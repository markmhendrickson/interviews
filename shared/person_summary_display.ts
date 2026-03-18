/**
 * True when the assessment personSummary is worth showing in "What you told me".
 * Omits summaries that only describe no engagement / no extractable substance.
 */
export function personSummaryWorthShowing(personSummary: string): boolean {
  const raw = String(personSummary || "").trim();
  if (!raw || raw.toLowerCase() === "null") return false;
  const s = raw.toLowerCase();

  const onlyDescribesNonEngagement = [
    /\bunresponsive\b/,
    /no meaningful information/,
    /provided no meaningful/,
    /minimal verbal responses/,
    /\blong silences\b/,
    /despite multiple (?:prompts|attempts|tries)/,
    /minimal engagement/,
    /did not share/,
    /no substantive/,
    /\bno engagement\b/,
    /provided minimal/,
    /ended conversation immediately/,
    /without sharing/,
    /insufficient interview data/,
    /ended (?:the )?interview before sharing/,
    /before a full qualification pass/,
    /before sharing enough detail/,
    /^interview in progress\.?$/i,
    /before substantive user responses/,
    /no substantive user responses were captured/,
    /ended before substantive/,
    /unable to (?:assess|evaluate|determine).*(?:role|fit|usage)/i,
    /little to no information (?:was )?(?:shared|provided)/i,
  ].some((re) => re.test(s));

  return !onlyDescribesNonEngagement;
}
