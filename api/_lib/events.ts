import { kv } from "@vercel/kv";

export type InterviewEventType =
  | "invite_email_sent"
  | "invite_text_prepared"
  | "invite_text_confirmed"
  | "link_opened"
  | "interview_started"
  | "interview_progressed"
  | "interview_abandoned"
  | "interview_completed";

export interface InterviewEvent {
  eventId: string;
  eventType: InterviewEventType;
  timestamp: string;
  interviewSlug: string;
  sessionId?: string;
  shareCode?: string;
  messageCount?: number;
  metadata?: Record<string, unknown>;
}

function getNamespace(): string {
  return (
    process.env.KV_KEY_PREFIX ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    "development"
  )
    .trim()
    .toLowerCase();
}

function scopedKey(key: string): string {
  return `survey:${getNamespace()}:${key}`;
}

function normalizeInterviewSlug(interviewSlug: string | undefined): string {
  const normalized = String(interviewSlug || "ai")
    .trim()
    .toLowerCase();
  return normalized || "ai";
}

function normalizeCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const normalized = String(code).trim().toLowerCase();
  return normalized || undefined;
}

function ensureKvConfigured(): void {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Vercel KV is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN");
  }
  if (!url.startsWith("https://")) {
    throw new Error(
      "Upstash Redis client was passed an invalid URL. Use the REST endpoint (https), not the redis:// URL."
    );
  }
}

function eventIndexKey(interviewSlug: string): string {
  return scopedKey(`${normalizeInterviewSlug(interviewSlug)}:events:index`);
}

function eventKey(eventId: string, interviewSlug: string): string {
  return scopedKey(`${normalizeInterviewSlug(interviewSlug)}:event:${eventId}`);
}

function createEventId(): string {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `evt_${Date.now().toString(36)}_${randomPart}`;
}

export async function recordEvent(input: {
  eventType: InterviewEventType;
  interviewSlug?: string;
  sessionId?: string;
  shareCode?: string;
  messageCount?: number;
  metadata?: Record<string, unknown>;
}): Promise<InterviewEvent> {
  ensureKvConfigured();
  const interviewSlug = normalizeInterviewSlug(input.interviewSlug);
  const event: InterviewEvent = {
    eventId: createEventId(),
    eventType: input.eventType,
    timestamp: new Date().toISOString(),
    interviewSlug,
    sessionId: input.sessionId ? String(input.sessionId).trim() || undefined : undefined,
    shareCode: normalizeCode(input.shareCode),
    messageCount:
      typeof input.messageCount === "number" && Number.isFinite(input.messageCount)
        ? Math.max(0, Math.floor(input.messageCount))
        : undefined,
    metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : undefined,
  };

  await kv.set(eventKey(event.eventId, interviewSlug), event);
  await kv.sadd(eventIndexKey(interviewSlug), event.eventId);
  return event;
}

export async function listEvents(interviewSlug = "ai"): Promise<InterviewEvent[]> {
  ensureKvConfigured();
  const eventIds = await kv.smembers<string[]>(eventIndexKey(interviewSlug));
  if (!eventIds || eventIds.length === 0) return [];
  const rows = await Promise.all(
    eventIds.map((eventId) => kv.get<InterviewEvent>(eventKey(eventId, interviewSlug)))
  );
  return rows
    .filter((row): row is InterviewEvent => !!row)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export async function listEventsByCode(
  shareCode: string,
  interviewSlug = "ai"
): Promise<InterviewEvent[]> {
  const normalizedCode = normalizeCode(shareCode);
  if (!normalizedCode) return [];
  const events = await listEvents(interviewSlug);
  return events.filter((event) => event.shareCode === normalizedCode);
}

export async function listEventsBySession(
  sessionId: string,
  interviewSlug = "ai"
): Promise<InterviewEvent[]> {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) return [];
  const events = await listEvents(interviewSlug);
  return events.filter((event) => event.sessionId === normalizedSessionId);
}
