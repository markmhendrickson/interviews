/**
 * Maps recommendation tool names to the most specific stable official docs / product pages.
 * Used when the model omits `url` or returns a homepage. Longer / more specific patterns first.
 */

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[._]/g, " ")
    .replace(/[^a-z0-9+\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type Entry = { patterns: RegExp[]; url: string };

const ENTRIES: Entry[] = [
  {
    patterns: [
      /google\s*classroom.*ai/i,
      /classroom.*gemini/i,
      /gemini.*classroom/i,
      /google\s*classroom/i,
    ],
    url: "https://support.google.com/edu/classroom/answer/15410566",
  },
  {
    patterns: [/notion\s*ai/i, /notion.*\bai\b/i],
    url: "https://www.notion.so/help/notion-ai",
  },
  {
    patterns: [/^notion$/i, /\bnotion\b(?!.*ai)/i],
    url: "https://www.notion.so/help/guides/get-started-with-notion",
  },
  {
    patterns: [/claude\s*projects?/i, /projects?\s*feature.*claude/i],
    url: "https://support.claude.com/en/articles/9517075-what-are-projects",
  },
  {
    patterns: [/^claude(\s*\.ai)?$/i, /\banthropic\s*claude\b/i],
    url: "https://claude.ai/download",
  },
  {
    patterns: [/claude\s*code/i],
    url: "https://docs.anthropic.com/en/docs/claude-code",
  },
  {
    patterns: [/otter\.?ai/i, /\botter\b/i],
    url: "https://help.otter.ai/hc/en-us/articles/360045239473-Record-and-review-your-conversations",
  },
  {
    patterns: [/chatgpt.*custom\s*gpt/i, /custom\s*gpt/i, /\bgpts?\b/i],
    url: "https://help.openai.com/en/articles/8554397-creating-a-gpt",
  },
  {
    patterns: [/chatgpt/i, /\bopenai\s*chat\b/i],
    url: "https://help.openai.com/en/articles/9275245-using-chatgpt-s-memory-feature",
  },
  {
    patterns: [/perplexity/i],
    url: "https://www.perplexity.ai/help-center",
  },
  {
    patterns: [/mem0/i],
    url: "https://docs.mem0.ai/quickstart",
  },
  {
    patterns: [/\bzep\b/i, /getzep/i],
    url: "https://help.getzep.com/",
  },
  {
    patterns: [/langgraph/i],
    url: "https://langchain-ai.github.io/langgraph/tutorials/introduction/",
  },
  {
    patterns: [/langchain.*memory/i, /langchain/i],
    url: "https://python.langchain.com/docs/concepts/memory/",
  },
  {
    patterns: [/\bcursor\b/i],
    url: "https://cursor.com/docs",
  },
  {
    patterns: [/github\s*copilot/i, /\bcopilot\b/i],
    url: "https://docs.github.com/en/copilot/get-started",
  },
  {
    patterns: [/windsurf/i, /codeium/i],
    url: "https://docs.codeium.com/windsurf/getting-started",
  },
  {
    patterns: [/replit.*agent/i, /\breplit\b/i],
    url: "https://docs.replit.com/replitai/agent",
  },
  {
    patterns: [/\bv0\b/i, /v0\.dev/i],
    url: "https://v0.dev/docs",
  },
  {
    patterns: [/\bn8n\b/i],
    url: "https://docs.n8n.io/try-it-out/quickstart/",
  },
  {
    patterns: [/\bmake\b.*automation/i, /make\.com/i, /integromat/i],
    url: "https://www.make.com/en/help",
  },
  {
    patterns: [/\bzapier\b/i],
    url: "https://help.zapier.com/hc/en-us",
  },
  {
    patterns: [/crew\s*ai/i],
    url: "https://docs.crewai.com/en/introduction",
  },
  {
    patterns: [/auto\s*gen/i, /autogen/i],
    url: "https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/index.html",
  },
  {
    patterns: [/google\s*adk/i, /agent\s*development\s*kit/i],
    url: "https://google.github.io/adk-docs/get-started/",
  },
  {
    patterns: [/granola/i],
    url: "https://help.granola.ai/",
  },
  {
    patterns: [/gemini/i],
    url: "https://gemini.google.com/app",
  },
  {
    patterns: [/microsoft\s*365\s*copilot/i, /m365\s*copilot/i],
    url: "https://support.microsoft.com/en-us/copilot",
  },
  {
    patterns: [/notebook\s*lm/i, /notebooklm/i],
    url: "https://notebooklm.google.com/",
  },
  {
    patterns: [/neotoma/i],
    url: "https://github.com/markmhendrickson/neotoma/blob/main/install.md",
  },
];

/** Substring fallbacks when no regex matches (normalized tool name contains key). */
const SUBSTRING_URLS: [string, string][] = [
  ["continue interview", ""],
  ["elevenlabs", "https://elevenlabs.io/docs"],
];

export const NEOTOMA_DEEP_URL =
  "https://github.com/markmhendrickson/neotoma/blob/main/install.md";

export function resolveRecommendationToolUrl(toolName: string): string | null {
  const raw = (toolName || "").trim();
  if (!raw) return null;
  const n = norm(raw);
  for (const [key, url] of SUBSTRING_URLS) {
    if (!url && n.includes(norm(key))) return null;
    if (url && n.includes(norm(key))) return url;
  }
  for (const { patterns, url } of ENTRIES) {
    for (const re of patterns) {
      if (re.test(raw) || re.test(n)) return url;
    }
  }
  return null;
}
