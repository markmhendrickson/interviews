import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";
import {
  NEOTOMA_DEEP_URL,
  resolveRecommendationToolUrl,
} from "../shared/recommendation_tool_urls";
import { sanitizeContactIdentityName } from "../shared/contact_identity";
import { buildHeuristicRecommendations } from "../src/lib/assessment";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `You are an assessment extraction system. Given a conversation transcript between an AI interviewer and a contact, extract a structured assessment.

The interviewer was qualifying the contact against Neotoma's ICP tiers:
- tier1_infra: AI Infrastructure Engineers (agent runtimes, observability, evaluation)
- tier1_agent: Agent System Builders (multi-step agents, tool calling)
- tier1_operator: AI-native Operators (3+ AI tools daily, automation, technical fluency)
- tier2_toolchain: Toolchain Integrators (framework/devtool authors)
- none: Does not match any ICP

Extract the assessment as valid JSON. Include ALL fields from the schema. Be specific in matchedSignals and keyInsights — quote or paraphrase the contact's actual words.

For recommendations:
- If the contact matches an ICP tier, Neotoma should be the first recommendation (set isNeotoma: true) and return 2-4 total recommendations with at least one non-Neotoma item.
- For non-matches, do NOT include Neotoma and return 1-3 alternatives.

Every recommendation MUST include "url": a direct link to the most specific official resource (docs page, feature guide, help article, or product deep-link)—never a generic homepage when a more specific URL exists.

Return ONLY the JSON object, no markdown, no explanation.`;

type CanonicalIcpTier =
  | "tier1_infra"
  | "tier1_agent"
  | "tier1_operator"
  | "tier2_toolchain"
  | "none";

function normalizeIcpTier(value: unknown): CanonicalIcpTier {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "none";
  if (
    raw === "tier1_infra" ||
    raw === "tier1_agent" ||
    raw === "tier1_operator" ||
    raw === "tier2_toolchain" ||
    raw === "none"
  ) {
    return raw;
  }

  const compact = raw.replace(/[\s_-]+/g, "");
  if (compact === "tier1infra" || compact === "infrastructureengineer") {
    return "tier1_infra";
  }
  if (compact === "tier1agent" || compact === "agentbuilder") {
    return "tier1_agent";
  }
  if (compact === "tier1operator" || compact === "tier1ainativeoperator") {
    return "tier1_operator";
  }
  if (compact === "tier2" || compact === "tier2toolchain" || compact === "toolchainintegrator") {
    return "tier2_toolchain";
  }
  return "none";
}

function toLowerText(input: unknown): string {
  return String(input || "").trim().toLowerCase();
}

function inferIcpTier(assessment: Record<string, unknown>): CanonicalIcpTier {
  const matchedSignals = Array.isArray(assessment.matchedSignals)
    ? assessment.matchedSignals.map((s) => String(s || "").toLowerCase()).filter(Boolean)
    : [];
  const antiSignals = Array.isArray(assessment.antiIcpSignals)
    ? assessment.antiIcpSignals.map((s) => String(s || "").toLowerCase()).filter(Boolean)
    : [];
  const tools = Array.isArray(assessment.toolsUsed)
    ? assessment.toolsUsed.map((t) => String(t || "").toLowerCase()).filter(Boolean)
    : [];
  const profileText = toLowerText(assessment.icpProfile);
  const summaryText = toLowerText(assessment.personSummary);
  const evidence = `${matchedSignals.join(" ")} ${profileText} ${summaryText} ${tools.join(" ")}`;
  const confidence = Number(assessment.matchConfidence || 0);

  if (/(infra|observability|evaluation|runtime)/.test(evidence)) {
    return "tier1_infra";
  }
  if (/(agent builder|multi-step|tool calling|agent workflows?)/.test(evidence)) {
    return "tier1_agent";
  }
  if (/(toolchain|framework|integrator|sdk|devtool)/.test(evidence)) {
    return "tier2_toolchain";
  }
  if (
    confidence >= 80 &&
    matchedSignals.length >= 2 &&
    antiSignals.length <= 1 &&
    /(cursor|claude|mcp|automation|engineer|developer|operator)/.test(evidence)
  ) {
    return "tier1_operator";
  }
  if (confidence >= 65 && matchedSignals.length >= 2 && antiSignals.length <= 1) {
    return "tier2_toolchain";
  }
  return "none";
}

function defaultIcpProfileForTier(tier: CanonicalIcpTier): string | null {
  if (tier === "tier1_infra") return "AI Infrastructure Engineer";
  if (tier === "tier1_agent") return "Agent System Builder";
  if (tier === "tier1_operator") return "AI-native Operator";
  if (tier === "tier2_toolchain") return "Toolchain Integrator";
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { transcript, sessionId, contactName, durationSeconds } = req.body;

  if (!transcript || !sessionId) {
    return res.status(400).json({ error: "Missing transcript or sessionId" });
  }

  try {
    const formattedTranscript = transcript
      .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: `Extract the structured assessment from this interview transcript:\n\n${formattedTranscript}`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    let assessment;
    try {
      assessment = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        assessment = JSON.parse(jsonMatch[0]);
      } else {
        return res.status(500).json({ error: "Failed to parse assessment JSON" });
      }
    }

    const normalizedTier = normalizeIcpTier(assessment.icpTier);
    const repairedTier =
      normalizedTier === "none"
        ? inferIcpTier(assessment as Record<string, unknown>)
        : normalizedTier;
    assessment.icpTier = repairedTier;
    if (!assessment.icpProfile && repairedTier !== "none") {
      assessment.icpProfile = defaultIcpProfileForTier(repairedTier);
    }

    const normalizedRecommendations = Array.isArray(assessment.recommendations)
      ? assessment.recommendations
          .filter(
            (rec: { tool?: string; relevance?: string; nextStep?: string }) =>
              !!(rec?.tool?.trim() || rec?.relevance?.trim() || rec?.nextStep?.trim())
          )
          .map((rec: { tool?: string; url?: string }) => {
            const t = String(rec.tool || "").trim();
            const u = String(rec.url || "").trim();
            if (u) return rec;
            const fallback = resolveRecommendationToolUrl(t);
            return fallback ? { ...rec, url: fallback } : rec;
          })
      : [];

    const isNeotomaRecommendation = (rec: { isNeotoma?: boolean; tool?: string }) =>
      Boolean(rec?.isNeotoma || /neotoma/i.test(String(rec?.tool || "")));

    const isIcpMatch = repairedTier !== "none";
    const hasNeotomaRecommendation = normalizedRecommendations.some(
      isNeotomaRecommendation
    );

    let finalRecommendations = normalizedRecommendations.filter(
      (rec: { isNeotoma?: boolean; tool?: string }) =>
        isIcpMatch || !isNeotomaRecommendation(rec)
    );

    const hasNeotomaAfterFilter = finalRecommendations.some(
      (rec: { isNeotoma?: boolean; tool?: string }) =>
        isNeotomaRecommendation(rec)
    );

    if (isIcpMatch && !hasNeotomaAfterFilter) {
      finalRecommendations.unshift({
        tool: "Neotoma",
        relevance:
          "Your interview signals a strong fit for deterministic agent memory and reproducible state workflows.",
        nextStep: "Follow the install guide, then run neotoma init and connect your editor via MCP.",
        isNeotoma: true,
        url: NEOTOMA_DEEP_URL,
      });
    }

    const nonNeotomaCount = finalRecommendations.filter(
      (rec: { isNeotoma?: boolean; tool?: string }) => !isNeotomaRecommendation(rec)
    ).length;
    if (isIcpMatch && nonNeotomaCount === 0) {
      finalRecommendations.push({
        tool: "LangGraph",
        relevance:
          "LangGraph helps model explicit agent state transitions, which is useful when teams report context loss and brittle workflows.",
        nextStep:
          "Work through the LangGraph intro and map one real workflow to explicit state nodes and transitions.",
        url:
          resolveRecommendationToolUrl("LangGraph") ||
          "https://langchain-ai.github.io/langgraph/tutorials/introduction/",
      });
    }

    const nonContinueRecommendations = finalRecommendations.filter((rec: {
      tool?: string;
    }) => {
      const tool = String(rec.tool || "").trim().toLowerCase();
      return tool !== "continue interview" && tool !== "continue the interview";
    });

    if (nonContinueRecommendations.length === 0) {
      finalRecommendations = buildHeuristicRecommendations({
        assessment: {
          icpTier: repairedTier,
          icpProfile: assessment.icpProfile,
          personSummary: assessment.personSummary,
          referralNotes: assessment.referralNotes,
          keyInsights: assessment.keyInsights,
          toolsUsed: assessment.toolsUsed,
          preferredAiTool: assessment.preferredAiTool,
        },
        transcript,
        includeContinueInterview: true,
      });
    }

    assessment.recommendations = finalRecommendations;
    assessment.sessionId = sessionId;
    assessment.timestamp = new Date().toISOString();
    assessment.durationSeconds = durationSeconds || 0;
    assessment.contactName = sanitizeContactIdentityName(assessment.contactName);
    const bodyName = sanitizeContactIdentityName(contactName);
    if (bodyName) assessment.contactName = bodyName;

    return res.status(200).json(assessment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
