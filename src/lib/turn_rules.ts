export function enforceSingleTrailingQuestion(text: string): string {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const firstQuestionIndex = trimmed.indexOf("?");
  if (firstQuestionIndex === -1) {
    return trimmed;
  }

  // Keep content through the first question mark so a question, if present,
  // is always the final sentence in the turn.
  return trimmed.slice(0, firstQuestionIndex + 1).trim();
}
