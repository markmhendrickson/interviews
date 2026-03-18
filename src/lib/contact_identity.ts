import type { TranscriptMessage } from "./assessment";

function cleanNameCandidate(raw: string): string | null {
  const stripped = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/[.,!?;:]+$/g, "")
    .trim();
  if (!stripped) return null;

  const tokens = stripped.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return null;

  const normalized = tokens.join(" ");
  const lower = normalized.toLowerCase();
  if (["anonymous", "n/a", "na", "none", "unknown"].includes(lower)) return null;
  return normalized;
}

function extractName(text: string): string | null {
  const patterns = [
    /\bmy name is\s+([a-z][a-z' -]{1,60})/i,
    /\bi am\s+([a-z][a-z' -]{1,60})/i,
    /\bi'm\s+([a-z][a-z' -]{1,60})/i,
    /\bthis is\s+([a-z][a-z' -]{1,60})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const candidate = cleanNameCandidate(match[1]);
    if (candidate) return candidate;
  }
  return null;
}

function extractEmail(text: string): string | null {
  const match = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match ? match[0].toLowerCase() : null;
}

export function extractAnonymousContactIdentity(
  transcript: TranscriptMessage[]
): { name?: string; email?: string } {
  const firstUserMessage = transcript.find((entry) => entry.role === "user")?.content;
  if (!firstUserMessage) return {};

  const name = extractName(firstUserMessage) ?? undefined;
  const email = extractEmail(firstUserMessage) ?? undefined;
  return { name, email };
}
