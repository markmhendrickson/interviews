import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isAdminAuthorized } from "./_lib/auth.js";
import { recordEvent } from "./_lib/events.js";
import { generateTextInvite, sendInviteEmail } from "./_lib/invite.js";
import { getContact } from "./_lib/store.js";
import { getInterviewConfigBySlug } from "../src/interviews/registry.js";

type InviteMethod = "email" | "text" | "text_confirm";

function getInterviewSlug(req: VercelRequest): string {
  if (typeof req.query.interview === "string") return req.query.interview;
  if (typeof req.body?.interviewSlug === "string") return req.body.interviewSlug;
  return "ai";
}

function getMethod(req: VercelRequest): InviteMethod | null {
  const method = typeof req.body?.method === "string" ? req.body.method : "";
  if (method === "email" || method === "text" || method === "text_confirm") return method;
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    if (!isAdminAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const interviewSlug = getInterviewSlug(req);
    const method = getMethod(req);
    if (!method) {
      return res.status(400).json({ error: "Invalid invite method" });
    }

    const code = typeof req.body?.code === "string" ? req.body.code.trim().toLowerCase() : "";
    if (!code) {
      return res.status(400).json({ error: "Missing code" });
    }

    const contact = await getContact(code, interviewSlug);
    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    const config = getInterviewConfigBySlug(interviewSlug);
    const interviewName = config?.name || "conversation";
    const senderName =
      (typeof req.body?.senderName === "string" && req.body.senderName.trim()) ||
      process.env.SENDGRID_FROM_NAME ||
      "Mark";

    if (method === "email") {
      const result = await sendInviteEmail(contact, interviewSlug, {
        interviewName,
        senderName,
      });
      const event = await recordEvent({
        eventType: "invite_email_sent",
        interviewSlug,
        shareCode: code,
        metadata: {
          recipientEmail: result.to,
        },
      });
      return res.status(200).json({ ok: true, method, result, event });
    }

    if (method === "text") {
      const result = await generateTextInvite(contact, interviewSlug, {
        interviewName,
        senderName,
      });
      const event = await recordEvent({
        eventType: "invite_text_prepared",
        interviewSlug,
        shareCode: code,
        metadata: {
          recipientName: contact.name,
        },
      });
      return res.status(200).json({ ok: true, method, result, event });
    }

    const event = await recordEvent({
      eventType: "invite_text_confirmed",
      interviewSlug,
      shareCode: code,
      metadata: {
        recipientName: contact.name,
      },
    });
    return res.status(200).json({ ok: true, method, event });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
