import { detectToolsUsed } from "./assessment";

export type InterviewEventType =
  | "link_opened"
  | "interview_started"
  | "interview_progressed"
  | "interview_abandoned"
  | "interview_completed";

interface PartialAssessment {
  sessionId: string;
  contactName: string | null;
  timestamp: string;
  durationSeconds: number;
  icpTier: "none";
  icpProfile: null;
  matchConfidence: number;
  matchedSignals: string[];
  antiIcpSignals: string[];
  personSummary: string;
  recommendations: Array<{
    tool: string;
    relevance: string;
    nextStep: string;
  }>;
  referralPotential: "low";
  referralNotes: string;
  keyInsights: string[];
  toolsUsed: string[];
}

interface RecordEventInput {
  eventType: InterviewEventType;
  interviewSlug: string;
  sessionId?: string;
  shareCode?: string;
  messageCount?: number;
  metadata?: Record<string, unknown>;
}

interface PartialResultInput {
  interviewSlug: string;
  sessionId: string;
  transcript: { role: "user" | "assistant"; content: string }[];
  contactCode?: string;
  messageCount?: number;
}

function createJsonBlob(payload: unknown): Blob {
  return new Blob([JSON.stringify(payload)], { type: "application/json" });
}

function buildPartialAssessment(params: {
  sessionId: string;
  transcript: { role: "user" | "assistant"; content: string }[];
  contactName?: string | null;
  durationSeconds?: number;
}): PartialAssessment {
  const userText = params.transcript
    .filter((item) => item.role === "user" && item.content.trim())
    .map((item) => item.content.trim())
    .join(" ");
  const toolsUsed = detectToolsUsed(userText);
  const latestUserMessage = [...params.transcript]
    .reverse()
    .find((item) => item.role === "user" && item.content.trim())
    ?.content.trim();

  return {
    sessionId: params.sessionId,
    contactName: params.contactName || null,
    timestamp: new Date().toISOString(),
    durationSeconds:
      typeof params.durationSeconds === "number" && Number.isFinite(params.durationSeconds)
        ? Math.max(0, Math.floor(params.durationSeconds))
        : 0,
    icpTier: "none",
    icpProfile: null,
    matchConfidence: 0,
    matchedSignals: [],
    antiIcpSignals: [],
    personSummary: "Interview in progress.",
    recommendations: [],
    referralPotential: "low",
    referralNotes: "Interview not completed yet.",
    keyInsights: latestUserMessage
      ? [`Latest user response: "${latestUserMessage.slice(0, 160)}"`]
      : ["Interview has started, but no substantive user response is stored yet."],
    toolsUsed,
  };
}

export function countUserMessages(
  transcript: { role: "user" | "assistant"; content: string }[]
): number {
  return transcript.filter((item) => item.role === "user" && item.content.trim()).length;
}

export async function upsertPartialResult(input: {
  interviewSlug: string;
  sessionId: string;
  transcript: { role: "user" | "assistant"; content: string }[];
  contactName?: string | null;
  contactCode?: string;
  messageCount?: number;
  durationSeconds?: number;
}): Promise<void> {
  await fetch("/api/results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      partial: true,
      interviewSlug: input.interviewSlug,
      sessionId: input.sessionId,
      assessment: buildPartialAssessment({
        sessionId: input.sessionId,
        transcript: input.transcript,
        contactName: input.contactName,
        durationSeconds: input.durationSeconds,
      }),
      transcript: input.transcript,
      contactCode: input.contactCode,
      messageCount: input.messageCount,
    }),
  });
}

export async function recordInterviewEvent(input: RecordEventInput): Promise<void> {
  await fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function sendAbandonBeacon(
  event: RecordEventInput,
  partialResult: PartialResultInput
): void {
  const canBeacon = typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function";
  if (canBeacon) {
    const eventBlob = createJsonBlob(event);
    const resultBlob = createJsonBlob({
      partial: true,
      interviewSlug: partialResult.interviewSlug,
      sessionId: partialResult.sessionId,
      transcript: partialResult.transcript,
      contactCode: partialResult.contactCode,
      messageCount: partialResult.messageCount,
    });
    navigator.sendBeacon("/api/events", eventBlob);
    navigator.sendBeacon("/api/results", resultBlob);
    return;
  }

  // Fallback for environments where beacon is unavailable.
  void fetch("/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch(() => {});
  void fetch("/api/results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      partial: true,
      interviewSlug: partialResult.interviewSlug,
      sessionId: partialResult.sessionId,
      transcript: partialResult.transcript,
      contactCode: partialResult.contactCode,
      messageCount: partialResult.messageCount,
    }),
    keepalive: true,
  }).catch(() => {});
}
