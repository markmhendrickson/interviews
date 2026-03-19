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
    recommendations: [
      {
        tool: "Continue interview",
        relevance:
          "A longer conversation will unlock better-fit recommendations and a more accurate assessment.",
        nextStep:
          "Start a new interview and share your role, current workflow, and AI tooling in a bit more detail.",
      },
    ],
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
