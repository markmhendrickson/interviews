export interface Recommendation {
  tool: string;
  relevance: string;
  nextStep: string;
  isNeotoma?: boolean;
  url?: string;
}

export interface ReferralContact {
  name: string;
  contactInfo?: string;
  email?: string;
  notes?: string;
}

export interface Assessment {
  sessionId: string;
  contactName: string | null;
  timestamp: string;
  durationSeconds: number;
  icpTier: "tier1_infra" | "tier1_agent" | "tier1_operator" | "tier2_toolchain" | "none";
  icpProfile: string | null;
  matchConfidence: number;
  matchedSignals: string[];
  antiIcpSignals: string[];
  personSummary: string;
  recommendations: Recommendation[];
  referralPotential: "high" | "medium" | "low";
  referralNotes: string;
  referralContacts?: ReferralContact[];
  keyInsights: string[];
  contactEmail?: string;
  toolsUsed: string[];
  preferredAiTool?: string;
}

import { sanitizeContactIdentityName } from "../../shared/contact_identity";
import { resolveRecommendationToolUrl } from "../../shared/recommendation_tool_urls";

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
}

export function generateSessionId(): string {
  return `int_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

interface ToolAliasMatcher {
  label: string;
  aliases: RegExp[];
}

const TOOL_ALIAS_MATCHERS: ToolAliasMatcher[] = [
  { label: "ChatGPT", aliases: [/\bchatgpt\b/i, /\bopenai\b/i] },
  {
    label: "Claude",
    aliases: [
      /\bclaude\b/i,
      // Accept common speech-to-text typo when users say "Claude Code".
      /\bcloud code\b/i,
      /\bclaude code\b/i,
    ],
  },
  { label: "Gemini", aliases: [/\bgemini\b/i] },
  { label: "Cursor", aliases: [/\bcursor\b/i] },
  {
    label: "GitHub Copilot",
    aliases: [/\bcopilot\b/i, /\bgithub copilot\b/i],
  },
  { label: "Perplexity", aliases: [/\bperplexity\b/i] },
  { label: "Midjourney", aliases: [/\bmidjourney\b/i] },
  { label: "Notion AI", aliases: [/\bnotion ai\b/i, /\bnotion\b/i] },
];

export function detectToolsUsed(text: string): string[] {
  const haystack = String(text || "");
  return TOOL_ALIAS_MATCHERS.filter((matcher) =>
    matcher.aliases.some((alias) => alias.test(haystack))
  ).map((matcher) => matcher.label);
}

export type CanonicalIcpTier =
  | "tier1_infra"
  | "tier1_agent"
  | "tier1_operator"
  | "tier2_toolchain"
  | "none";

/**
 * Infer ICP tier from assessment fields when stored tier is missing or "none".
 * Used for display so high-confidence, strong-signal interviews show the correct badge.
 */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((s) => String(s ?? "").toLowerCase())
    .filter(Boolean);
}

export function inferIcpTierForDisplay(assessment: {
  matchConfidence?: number;
  matchedSignals?: string[];
  antiIcpSignals?: string[];
  icpProfile?: string | null;
  personSummary?: string;
  toolsUsed?: string[];
}): CanonicalIcpTier {
  const matchedSignals = asStringArray(assessment.matchedSignals);
  const antiSignals = asStringArray(assessment.antiIcpSignals);
  const tools = asStringArray(assessment.toolsUsed);
  const profileText = String(assessment.icpProfile ?? "").trim().toLowerCase();
  const summaryText = String(assessment.personSummary ?? "").trim().toLowerCase();
  const evidence = `${matchedSignals.join(" ")} ${profileText} ${summaryText} ${tools.join(" ")}`;
  const confidence = Number(assessment.matchConfidence ?? 0);

  if (/(infra|observability|evaluation|runtime)/.test(evidence)) return "tier1_infra";
  if (/(agent builder|multi-step|tool calling|agent workflows?)/.test(evidence))
    return "tier1_agent";
  if (/(toolchain|framework|integrator|sdk|devtool)/.test(evidence)) return "tier2_toolchain";
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

export function buildFallbackAssessment(params: {
  transcript: TranscriptMessage[];
  sessionId: string;
  contactName?: string | null;
  durationSeconds: number;
}): Assessment {
  const transcript = params.transcript.filter((m) => m.content?.trim());
  const userMessages = transcript
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);
  const joinedUserText = userMessages.join(" ");
  const toolsUsed = detectToolsUsed(joinedUserText);
  const firstUserSnippet = userMessages[0];

  const personSummary =
    userMessages.length === 0
      ? "You ended the interview before sharing enough detail for a full assessment."
      : "You shared some initial context, then ended the interview before a full qualification pass.";

  return {
    sessionId: params.sessionId,
    contactName: sanitizeContactIdentityName(params.contactName ?? null),
    timestamp: new Date().toISOString(),
    durationSeconds: params.durationSeconds,
    icpTier: "none",
    icpProfile: null,
    matchConfidence: 0.15,
    matchedSignals: [],
    antiIcpSignals: userMessages.length === 0 ? ["Insufficient interview data"] : [],
    personSummary,
    recommendations: buildHeuristicRecommendations({
      assessment: {
        icpTier: "none",
        icpProfile: null,
        personSummary,
        referralNotes:
          "Referral potential could not be evaluated confidently because the interview ended early.",
        keyInsights: firstUserSnippet
          ? [`Early signal from user: "${firstUserSnippet.slice(0, 180)}"`]
          : ["Interview ended before substantive user responses were captured."],
        toolsUsed,
      },
      transcript,
      includeContinueInterview: true,
    }),
    referralPotential: "low",
    referralNotes:
      "Referral potential could not be evaluated confidently because the interview ended early.",
    keyInsights: firstUserSnippet
      ? [`Early signal from user: "${firstUserSnippet.slice(0, 180)}"`]
      : ["Interview ended before substantive user responses were captured."],
    toolsUsed,
    preferredAiTool: toolsUsed[0],
  };
}

function toLowerHaystack(parts: unknown[]): string {
  return parts
    .flatMap((part) => (Array.isArray(part) ? part : [part]))
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function recommendation(
  tool: string,
  relevance: string,
  nextStep: string
): Recommendation {
  return {
    tool,
    relevance,
    nextStep,
    url: resolveRecommendationToolUrl(tool) || undefined,
  };
}

export function buildHeuristicRecommendations(params: {
  assessment?: Partial<
    Pick<
      Assessment,
      | "icpTier"
      | "icpProfile"
      | "personSummary"
      | "referralNotes"
      | "keyInsights"
      | "toolsUsed"
      | "preferredAiTool"
    >
  >;
  transcript?: TranscriptMessage[];
  includeContinueInterview?: boolean;
}): Recommendation[] {
  const { assessment, transcript, includeContinueInterview = false } = params;
  const toolsUsed = Array.isArray(assessment?.toolsUsed)
    ? assessment?.toolsUsed.filter(Boolean)
    : [];
  const userTranscript = Array.isArray(transcript)
    ? transcript
        .filter((item) => item.role === "user" && item.content?.trim())
        .map((item) => item.content.trim())
    : [];
  const haystack = toLowerHaystack([
    assessment?.personSummary,
    assessment?.referralNotes,
    assessment?.keyInsights,
    toolsUsed,
    assessment?.preferredAiTool,
    userTranscript,
  ]);

  const results: Recommendation[] = [];
  const seen = new Set<string>();
  const add = (rec: Recommendation) => {
    const key = rec.tool.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    results.push(rec);
  };

  if (includeContinueInterview) {
    add({
      tool: "Continue interview",
      relevance:
        "A bit more detail about your workflow and pain points would make the recommendations more precise.",
      nextStep:
        "Start a new interview and share a concrete example of where your current AI setup breaks down.",
      url: undefined,
    });
  }

  const mentionsChatgpt =
    toolsUsed.some((tool) => /chatgpt|openai/i.test(tool)) ||
    /\bchatgpt\b|\bopenai\b/.test(haystack);
  const mentionsMeetings =
    /\bmeeting\b|\bcall\b|\bvoice\b|\baudio\b|\btranscri/.test(haystack);
  const mentionsAutomation =
    /\bautomation\b|\bintegrat|\bworkflow\b|\bremind|\breminder\b|\brepeated\b|\bhandoff\b/.test(
      haystack
    );
  const mentionsTracking =
    /\binventory\b|\btrack\b|\btracking\b|\brecord\b|\bconsistent\b|\bspreadsheet\b|\bchecklist\b/.test(
      haystack
    );
  const mentionsResearch =
    /\bresearch\b|\bcompare\b|\bsearch\b|\blook up\b|\bfind information\b/.test(
      haystack
    );

  if (mentionsTracking || mentionsChatgpt) {
    add(
      recommendation(
        "ChatGPT",
        "You described a workflow that would benefit from a repeatable structure instead of starting from scratch each time.",
        "Set up a dedicated GPT or saved workflow for this one recurring task so the fields and prompts stay consistent."
      )
    );
  }

  if (mentionsTracking) {
    add(
      recommendation(
        "Notion AI",
        "A simple shared log can make recurring records easier to update and review than free-form chat alone.",
        "Create one database for the recurring items you track and use AI only to help summarize or clean entries."
      )
    );
  }

  if (mentionsAutomation) {
    add(
      recommendation(
        "Zapier",
        "You hinted at workflow gaps and missed follow-through, which often improves when reminders and updates are triggered automatically.",
        "Automate one reminder or status-update flow first instead of rebuilding the whole process at once."
      )
    );
  }

  if (mentionsMeetings) {
    add(
      recommendation(
        "Otter.ai",
        "If spoken context matters, automatic transcripts can preserve details that are easy to lose mid-conversation.",
        "Try it on one conversation or voice memo and review whether the captured action items are good enough to reuse."
      )
    );
  }

  if (mentionsResearch || results.length < 2) {
    add(
      recommendation(
        "Perplexity",
        "A second opinion with citations is useful when you need quick answers or want to verify suggestions before acting on them.",
        "Use it alongside your main assistant for one task where confidence and source-checking matter."
      )
    );
  }

  if (results.length < 3) {
    add(
      recommendation(
        "Claude",
        "A separate assistant with projects can be useful when you want a cleaner workspace for one ongoing area of work.",
        "Create one project around this use case and compare whether the responses stay more organized over time."
      )
    );
  }

  return results.slice(0, includeContinueInterview ? 4 : 3);
}
