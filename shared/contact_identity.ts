/** Names that should not be shown in greetings (LLM or fallback placeholders). */
const PLACEHOLDER_NAME = /^(unknown|anonymous|n\/a|na|guest|none|unspecified|not\s+provided|\?|-|—|n\.\s*a\.?)$/i;

/** Role/job phrases after "A " / "An " — not real names (e.g. "A Teacher"). */
const GENERIC_ROLE_PHRASE = new Set(
  [
    "teacher",
    "developer",
    "engineer",
    "student",
    "user",
    "participant",
    "interviewee",
    "candidate",
    "manager",
    "designer",
    "founder",
    "consultant",
    "analyst",
    "architect",
    "operator",
    "professor",
    "instructor",
    "specialist",
    "programmer",
    "professional",
    "individual",
    "person",
    "respondent",
    "executive",
    "contractor",
    "freelancer",
    "researcher",
    "writer",
    "administrator",
    "admin",
    "platform engineer",
    "software engineer",
    "data engineer",
    "ml engineer",
    "ai engineer",
    "product manager",
    "project manager",
    "tech lead",
    "technically proficient teacher",
    "technical professional",
  ].map((s) => s.toLowerCase())
);

const ADJECTIVE_BEFORE_ROLE = new Set([
  "senior",
  "junior",
  "lead",
  "chief",
  "staff",
  "principal",
  "platform",
  "software",
  "data",
  "full",
  "stack",
  "front",
  "end",
  "back",
  "ai",
  "ml",
  "technical",
  "technically",
  "proficient",
  "experienced",
]);

const ROLE_TAIL_NOUN = new Set([
  "teacher",
  "developer",
  "engineer",
  "student",
  "manager",
  "designer",
  "architect",
  "analyst",
  "operator",
  "researcher",
  "writer",
  "consultant",
  "specialist",
  "programmer",
  "professional",
  "executive",
  "administrator",
  "admin",
  "founder",
  "instructor",
  "professor",
]);

function isGenericArticleRoleIdentity(normalized: string): boolean {
  const m = normalized.match(/^(a|an)\s+(.+)$/i);
  if (!m) return false;
  const rest = m[2].trim().toLowerCase();
  if (!rest) return true;
  if (GENERIC_ROLE_PHRASE.has(rest)) return true;
  const words = rest.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  const last = words[words.length - 1];
  if (!ROLE_TAIL_NOUN.has(last)) return false;
  return words.slice(0, -1).every((w) => ADJECTIVE_BEFORE_ROLE.has(w));
}

const THE_GENERIC = /^(the\s+)?(user|contact|respondent|participant|interviewee|candidate)\s*$/i;

/**
 * Returns a trimmed real name, or null if missing, placeholder, or generic role label (e.g. "A Teacher").
 */
export function sanitizeContactIdentityName(
  name: string | null | undefined
): string | null {
  const t = String(name ?? "").trim();
  if (!t) return null;
  if (PLACEHOLDER_NAME.test(t)) return null;
  const lower = t.toLowerCase();
  if (THE_GENERIC.test(lower)) return null;
  if (isGenericArticleRoleIdentity(lower)) return null;
  return t;
}
