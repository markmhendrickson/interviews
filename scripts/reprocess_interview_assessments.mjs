import dotenv from "dotenv";
import { kv } from "@vercel/kv";

dotenv.config({ path: new URL("../.env", import.meta.url).pathname });
dotenv.config({ path: new URL("../.env.development.local", import.meta.url).pathname });

const NEOTOMA_DEEP_URL =
  "https://github.com/markmhendrickson/neotoma/blob/main/install.md";
const LANGGRAPH_URL =
  "https://langchain-ai.github.io/langgraph/tutorials/introduction/";

function parseArgs(argv) {
  const args = {
    interviewSlug: "ai",
    apply: false,
    namespace: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--apply") {
      args.apply = true;
      continue;
    }
    if (token === "--slug" && argv[i + 1]) {
      args.interviewSlug = String(argv[i + 1]).trim().toLowerCase();
      i += 1;
      continue;
    }
    if (token === "--namespace" && argv[i + 1]) {
      args.namespace = String(argv[i + 1]).trim().toLowerCase();
      i += 1;
      continue;
    }
  }
  return args;
}

function getNamespace(explicitNamespace) {
  if (explicitNamespace) return explicitNamespace;
  return (
    process.env.KV_KEY_PREFIX ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    "development"
  )
    .trim()
    .toLowerCase();
}

function scopedKey(namespace, key) {
  return `survey:${namespace}:${key}`;
}

function resultIndexKey(namespace, interviewSlug) {
  return scopedKey(namespace, `${interviewSlug}:results:index`);
}

function resultKey(namespace, interviewSlug, sessionId) {
  return scopedKey(namespace, `${interviewSlug}:result:${sessionId}`);
}

function isNeotomaRecommendation(rec) {
  return Boolean(rec?.isNeotoma || /neotoma/i.test(String(rec?.tool || "")));
}

function normalizeRecommendationUrls(recommendations) {
  return recommendations.map((rec) => {
    const out = { ...rec };
    if (!out.url && /langgraph/i.test(String(out.tool || ""))) {
      out.url = LANGGRAPH_URL;
    }
    if (!out.url && isNeotomaRecommendation(out)) {
      out.url = NEOTOMA_DEEP_URL;
    }
    return out;
  });
}

function normalizeRecommendationsForAssessment(assessment) {
  const rawRecommendations = Array.isArray(assessment?.recommendations)
    ? assessment.recommendations.filter(
        (rec) => rec?.tool?.trim() || rec?.relevance?.trim() || rec?.nextStep?.trim()
      )
    : [];
  const icpTier = String(assessment?.icpTier || "").trim().toLowerCase();
  const isIcpMatch = Boolean(icpTier && icpTier !== "none");

  let recommendations = normalizeRecommendationUrls(rawRecommendations).filter(
    (rec) => isIcpMatch || !isNeotomaRecommendation(rec)
  );

  const hasNeotoma = recommendations.some(isNeotomaRecommendation);
  if (isIcpMatch && !hasNeotoma) {
    recommendations.unshift({
      tool: "Neotoma",
      relevance:
        "Your interview signals a strong fit for deterministic agent memory and reproducible state workflows.",
      nextStep: "Follow the install guide, then run neotoma init and connect your editor via MCP.",
      isNeotoma: true,
      url: NEOTOMA_DEEP_URL,
    });
  }

  const nonNeotomaCount = recommendations.filter(
    (rec) => !isNeotomaRecommendation(rec)
  ).length;
  if (isIcpMatch && nonNeotomaCount === 0) {
    recommendations.push({
      tool: "LangGraph",
      relevance:
        "LangGraph helps model explicit agent state transitions, which is useful when teams report context loss and brittle workflows.",
      nextStep:
        "Work through the LangGraph intro and map one real workflow to explicit state nodes and transitions.",
      url: LANGGRAPH_URL,
    });
  }

  if (recommendations.length === 0) {
    recommendations = [
      {
        tool: "Continue interview",
        relevance:
          "The transcript did not produce enough clear signals for high-confidence tool recommendations.",
        nextStep:
          "Run another interview with concrete examples of your current stack, failure modes, and desired outcomes.",
      },
    ];
  }

  return recommendations;
}

function normalizeIcpTier(value) {
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
  if (compact === "tier1infra" || compact === "infrastructureengineer") return "tier1_infra";
  if (compact === "tier1agent" || compact === "agentbuilder") return "tier1_agent";
  if (compact === "tier1operator" || compact === "tier1ainativeoperator") return "tier1_operator";
  if (compact === "tier2" || compact === "tier2toolchain" || compact === "toolchainintegrator") {
    return "tier2_toolchain";
  }
  return "none";
}

function inferIcpTier(assessment) {
  const matchedSignals = Array.isArray(assessment?.matchedSignals)
    ? assessment.matchedSignals.map((s) => String(s || "").toLowerCase()).filter(Boolean)
    : [];
  const antiSignals = Array.isArray(assessment?.antiIcpSignals)
    ? assessment.antiIcpSignals.map((s) => String(s || "").toLowerCase()).filter(Boolean)
    : [];
  const tools = Array.isArray(assessment?.toolsUsed)
    ? assessment.toolsUsed.map((t) => String(t || "").toLowerCase()).filter(Boolean)
    : [];
  const profileText = String(assessment?.icpProfile || "").trim().toLowerCase();
  const summaryText = String(assessment?.personSummary || "").trim().toLowerCase();
  const evidence = `${matchedSignals.join(" ")} ${profileText} ${summaryText} ${tools.join(" ")}`;
  const confidence = Number(assessment?.matchConfidence || 0);

  if (/(infra|observability|evaluation|runtime)/.test(evidence)) return "tier1_infra";
  if (/(agent builder|multi-step|tool calling|agent workflows?)/.test(evidence)) return "tier1_agent";
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

function defaultIcpProfileForTier(tier) {
  if (tier === "tier1_infra") return "AI Infrastructure Engineer";
  if (tier === "tier1_agent") return "Agent System Builder";
  if (tier === "tier1_operator") return "AI-native Operator";
  if (tier === "tier2_toolchain") return "Toolchain Integrator";
  return null;
}

function stringifyStable(value) {
  return JSON.stringify(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const namespace = getNamespace(args.namespace);
  const interviewSlug = args.interviewSlug || "ai";
  const indexKey = resultIndexKey(namespace, interviewSlug);
  const sessionIds = await kv.smembers(indexKey);

  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    console.log(
      JSON.stringify(
        {
          namespace,
          interviewSlug,
          sessionCount: 0,
          changed: 0,
          applied: args.apply,
          message: "No stored interview sessions found for this slug.",
        },
        null,
        2
      )
    );
    return;
  }

  let changed = 0;
  let skipped = 0;
  const changedSessions = [];

  for (const rawSessionId of sessionIds) {
    const sessionId = String(rawSessionId || "").trim();
    if (!sessionId) continue;
    const key = resultKey(namespace, interviewSlug, sessionId);
    const row = await kv.get(key);
    if (!row || typeof row !== "object") {
      skipped += 1;
      continue;
    }
    const currentAssessment = row.assessment;
    if (!currentAssessment || typeof currentAssessment !== "object") {
      skipped += 1;
      continue;
    }

    const normalizedTier = normalizeIcpTier(currentAssessment.icpTier);
    const repairedTier = normalizedTier === "none" ? inferIcpTier(currentAssessment) : normalizedTier;
    const repairedProfile =
      currentAssessment.icpProfile ||
      (repairedTier !== "none" ? defaultIcpProfileForTier(repairedTier) : null);
    const nextRecommendations = normalizeRecommendationsForAssessment(currentAssessment);
    const prevRecommendations = Array.isArray(currentAssessment.recommendations)
      ? currentAssessment.recommendations
      : [];
    const prevTier = String(currentAssessment.icpTier || "");
    const prevProfile = currentAssessment.icpProfile ?? null;
    const tierChanged = prevTier !== repairedTier;
    const profileChanged = prevProfile !== repairedProfile;
    const recommendationsChanged =
      stringifyStable(prevRecommendations) !== stringifyStable(nextRecommendations);

    if (!tierChanged && !profileChanged && !recommendationsChanged) {
      continue;
    }

    changed += 1;
    changedSessions.push(sessionId);

    if (args.apply) {
      const updated = {
        ...row,
        assessment: {
          ...currentAssessment,
          icpTier: repairedTier,
          icpProfile: repairedProfile,
          recommendations: nextRecommendations,
        },
        storedAt: new Date().toISOString(),
      };
      await kv.set(key, updated);
    }
  }

  console.log(
    JSON.stringify(
      {
        namespace,
        interviewSlug,
        sessionCount: sessionIds.length,
        changed,
        skipped,
        applied: args.apply,
        changedSessions: changedSessions.slice(0, 50),
      },
      null,
      2
    )
  );

  if (!args.apply && changed > 0) {
    console.log(
      "\nDry run only. Re-run with --apply to persist these updates."
    );
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`reprocess_interview_assessments failed: ${message}`);
  process.exit(1);
});
