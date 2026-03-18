import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isAdminAuthorized } from "./_lib/auth.js";
import {
  listEvents,
  listEventsByCode,
  listEventsBySession,
  recordEvent,
  type InterviewEventType,
} from "./_lib/events.js";

const ALLOWED_EVENT_TYPES = new Set<InterviewEventType>([
  "invite_email_sent",
  "invite_text_prepared",
  "invite_text_confirmed",
  "link_opened",
  "interview_started",
  "interview_progressed",
  "interview_abandoned",
  "interview_completed",
]);

function getInterviewSlug(req: VercelRequest): string {
  if (typeof req.query.interview === "string") return req.query.interview;
  if (typeof req.body?.interviewSlug === "string") return req.body.interviewSlug;
  return "ai";
}

function parseEventType(raw: unknown): InterviewEventType | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!ALLOWED_EVENT_TYPES.has(value as InterviewEventType)) return null;
  return value as InterviewEventType;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const interviewSlug = getInterviewSlug(req);

    if (req.method === "POST") {
      const eventType = parseEventType(req.body?.eventType);
      if (!eventType) {
        return res.status(400).json({ error: "Invalid or missing eventType" });
      }

      const messageCount =
        typeof req.body?.messageCount === "number" ? req.body.messageCount : undefined;
      const event = await recordEvent({
        eventType,
        interviewSlug,
        sessionId:
          typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
        shareCode:
          typeof req.body?.shareCode === "string" ? req.body.shareCode : undefined,
        messageCount,
        metadata:
          req.body?.metadata &&
          typeof req.body.metadata === "object" &&
          !Array.isArray(req.body.metadata)
            ? (req.body.metadata as Record<string, unknown>)
            : undefined,
      });
      return res.status(201).json({ ok: true, event });
    }

    if (req.method === "GET") {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const code = typeof req.query.code === "string" ? req.query.code : undefined;
      const sessionId =
        typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;

      const events = code
        ? await listEventsByCode(code, interviewSlug)
        : sessionId
          ? await listEventsBySession(sessionId, interviewSlug)
          : await listEvents(interviewSlug);
      return res.status(200).json({ events, count: events.length });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
