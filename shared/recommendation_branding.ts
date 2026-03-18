function norm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[._]/g, " ")
    .replace(/[^a-z0-9+\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type BrandRule = {
  patterns: RegExp[];
  iconSlugs?: string[];
  monogram: string;
};

function simpleIconUrls(slug: string): string[] {
  return [
    `https://cdn.simpleicons.org/${slug}`,
    `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/${slug}.svg`,
  ];
}

function maybeSvgUrl(url?: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.pathname.toLowerCase().endsWith(".svg") ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function dedupe(urls: string[]): string[] {
  return Array.from(new Set(urls.filter(Boolean)));
}

const BRAND_RULES: BrandRule[] = [
  { patterns: [/notion/i], iconSlugs: ["notion"], monogram: "N" },
  { patterns: [/claude/i], iconSlugs: ["claude"], monogram: "C" },
  { patterns: [/chatgpt/i, /openai/i, /\bgpts?\b/i], iconSlugs: ["openai"], monogram: "O" },
  { patterns: [/otter/i], iconSlugs: ["otterai"], monogram: "O" },
  { patterns: [/google classroom/i], iconSlugs: ["googleclassroom"], monogram: "G" },
  { patterns: [/gemini/i], iconSlugs: ["googlegemini"], monogram: "G" },
  { patterns: [/perplexity/i], iconSlugs: ["perplexity"], monogram: "P" },
  { patterns: [/mem0/i], monogram: "M" },
  { patterns: [/\bzep\b/i], monogram: "Z" },
  { patterns: [/langchain/i], iconSlugs: ["langchain"], monogram: "L" },
  { patterns: [/langgraph/i], monogram: "L" },
  { patterns: [/cursor/i], iconSlugs: ["cursor"], monogram: "C" },
  { patterns: [/copilot/i], iconSlugs: ["githubcopilot"], monogram: "C" },
  { patterns: [/windsurf|codeium/i], monogram: "W" },
  { patterns: [/replit/i], iconSlugs: ["replit"], monogram: "R" },
  { patterns: [/^v0$|v0\.dev/i], monogram: "V" },
  { patterns: [/n8n/i], iconSlugs: ["n8n"], monogram: "N" },
  { patterns: [/\bmake\b|integromat/i], iconSlugs: ["make"], monogram: "M" },
  { patterns: [/zapier/i], iconSlugs: ["zapier"], monogram: "Z" },
  { patterns: [/crewai/i], monogram: "C" },
  { patterns: [/autogen/i], iconSlugs: ["microsoft"], monogram: "A" },
  { patterns: [/google adk/i], iconSlugs: ["google"], monogram: "G" },
  { patterns: [/granola/i], monogram: "G" },
  { patterns: [/neotoma/i], monogram: "N" },
];

export function getRecommendationBranding(toolName: string): {
  iconUrls: string[];
  monogram: string;
} {
  const raw = (toolName || "").trim();
  const normalized = norm(raw);
  if (!normalized) return { iconUrls: [], monogram: "?" };

  for (const rule of BRAND_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(raw) || pattern.test(normalized))) {
      const svgUrls = (rule.iconSlugs || []).flatMap(simpleIconUrls);
      return { iconUrls: dedupe(svgUrls), monogram: rule.monogram };
    }
  }

  return { iconUrls: [], monogram: normalized.slice(0, 1).toUpperCase() };
}

export function getRecommendationBrandingFromUrl(
  toolName: string,
  toolUrl?: string
): { iconUrls: string[]; monogram: string } {
  const base = getRecommendationBranding(toolName);
  const explicitSvg = maybeSvgUrl(toolUrl);
  if (!explicitSvg) return base;
  return { iconUrls: dedupe([explicitSvg, ...base.iconUrls]), monogram: base.monogram };
}
