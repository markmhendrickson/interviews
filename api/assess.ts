import type { VercelRequest, VercelResponse } from "@vercel/node";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_PROMPT = `You are an assessment extraction system. Given a conversation transcript between an AI interviewer and a contact, extract a structured assessment.

The interviewer was qualifying the contact against Neotoma's ICP tiers:
- tier1_infra: AI Infrastructure Engineers (agent runtimes, observability, evaluation)
- tier1_agent: Agent System Builders (multi-step agents, tool calling)
- tier1_operator: AI-native Operators (3+ AI tools daily, automation, technical fluency)
- tier2_toolchain: Toolchain Integrators (framework/devtool authors)
- none: Does not match any ICP

Extract the assessment as valid JSON. Include ALL fields from the schema. Be specific in matchedSignals and keyInsights — quote or paraphrase the contact's actual words.

For recommendations: if the contact matches an ICP tier, Neotoma should be the first recommendation (set isNeotoma: true). For non-matches, do NOT include Neotoma.

Return ONLY the JSON object, no markdown, no explanation.`;

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

    const normalizedRecommendations = Array.isArray(assessment.recommendations)
      ? assessment.recommendations.filter(
          (rec: { tool?: string; relevance?: string; nextStep?: string }) =>
            !!(rec?.tool?.trim() || rec?.relevance?.trim() || rec?.nextStep?.trim())
        )
      : [];

    const isIcpMatch = assessment.icpTier && assessment.icpTier !== "none";
    const hasNeotomaRecommendation = normalizedRecommendations.some(
      (rec: { isNeotoma?: boolean; tool?: string }) =>
        rec?.isNeotoma || /neotoma/i.test(String(rec?.tool || ""))
    );

    if (isIcpMatch && !hasNeotomaRecommendation) {
      normalizedRecommendations.unshift({
        tool: "Neotoma",
        relevance:
          "Your interview signals a strong fit for deterministic agent memory and reproducible state workflows.",
        nextStep: "Review Neotoma capabilities and evaluate against your current agent stack.",
        isNeotoma: true,
      });
    }

    assessment.recommendations = normalizedRecommendations;
    assessment.sessionId = sessionId;
    assessment.timestamp = new Date().toISOString();
    assessment.durationSeconds = durationSeconds || 0;
    if (contactName) assessment.contactName = contactName;

    return res.status(200).json(assessment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
