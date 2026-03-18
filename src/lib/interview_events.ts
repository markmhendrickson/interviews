export type InterviewEventType =
  | "link_opened"
  | "interview_started"
  | "interview_progressed"
  | "interview_abandoned"
  | "interview_completed";

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

export function countUserMessages(
  transcript: { role: "user" | "assistant"; content: string }[]
): number {
  return transcript.filter((item) => item.role === "user" && item.content.trim()).length;
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
