import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isAdminAuthorized } from "./_lib/auth.js";
import { listEvents, listEventsByCode, listEventsBySession } from "./_lib/events.js";
import inviteHandler from "./invite.js";
import {
  getContact,
  getResult,
  getSyncStatus,
  listContacts,
  listResults,
  removeContact,
  removeResult,
  syncContactsFromNeotoma,
  updateSyncStatus,
  upsertContact,
} from "./_lib/store.js";

type AdminResource =
  | "results"
  | "contacts"
  | "events"
  | "invite"
  | "overview"
  | "sync";

function getInterviewSlug(req: VercelRequest): string {
  if (typeof req.query.interview === "string") return req.query.interview;
  if (typeof req.body?.interviewSlug === "string") return req.body.interviewSlug;
  return "ai";
}

function getResource(req: VercelRequest): AdminResource {
  const raw = typeof req.query.resource === "string" ? req.query.resource : "overview";
  if (
    raw === "results" ||
    raw === "contacts" ||
    raw === "events" ||
    raw === "invite" ||
    raw === "overview" ||
    raw === "sync"
  ) {
    return raw;
  }
  return "overview";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (!isAdminAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const interviewSlug = getInterviewSlug(req);
    const resource = getResource(req);

    if (req.method === "GET") {
      if (resource === "results") {
        const { sessionId } = req.query;
        if (sessionId && typeof sessionId === "string") {
          const result = await getResult(sessionId, interviewSlug);
          if (!result) return res.status(404).json({ error: "Not found" });
          return res.status(200).json(result);
        }
        const results = await listResults(interviewSlug);
        return res.status(200).json({ results, count: results.length });
      }

      if (resource === "contacts") {
        const { code } = req.query;
        if (code && typeof code === "string") {
          const contact = await getContact(code, interviewSlug);
          if (!contact) return res.status(404).json({ error: "Not found" });
          return res.status(200).json(contact);
        }
        const contacts = await listContacts(interviewSlug);
        return res.status(200).json({ contacts, count: contacts.length });
      }

      if (resource === "events") {
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

      if (resource === "sync") {
        const sync = await getSyncStatus(interviewSlug);
        return res.status(200).json({ sync });
      }

      const [results, contacts, events, sync] = await Promise.all([
        listResults(interviewSlug),
        listContacts(interviewSlug),
        listEvents(interviewSlug),
        getSyncStatus(interviewSlug),
      ]);
      return res.status(200).json({
        interviewSlug,
        results,
        contacts,
        events,
        sync,
        counts: { results: results.length, contacts: contacts.length, events: events.length },
      });
    }

    if (req.method === "POST") {
      if (resource === "contacts") {
        const { code, name, email, context, source } = req.body || {};
        const contact = await upsertContact(
          {
            code: String(code || ""),
            name: String(name || ""),
            email: email ? String(email) : undefined,
            context: context ? String(context) : undefined,
            source: source ? String(source) : undefined,
          },
          interviewSlug
        );
        return res.status(201).json({ ok: true, contact });
      }

      if (resource === "invite") {
        req.query.interview = interviewSlug;
        return inviteHandler(req, res);
      }

      if (resource === "sync") {
        const requestedAt = new Date().toISOString();
        const explicitStatus =
          req.body?.status === "success" ||
          req.body?.status === "error" ||
          req.body?.status === "requested"
            ? req.body.status
            : null;

        // Backward-compatible manual mode for callers that explicitly set status.
        if (explicitStatus) {
          const sync = await updateSyncStatus(
            {
              status: explicitStatus,
              lastRequestedAt: requestedAt,
              lastSyncedAt:
                explicitStatus === "success"
                  ? String(req.body?.lastSyncedAt || requestedAt)
                  : undefined,
              lastError:
                explicitStatus === "error"
                  ? String(req.body?.lastError || "Sync failed")
                  : undefined,
            },
            interviewSlug
          );
          return res.status(200).json({ ok: true, sync });
        }

        try {
          const syncResult = await syncContactsFromNeotoma(interviewSlug);
          const sync = await updateSyncStatus(
            {
              status: "success",
              lastRequestedAt: requestedAt,
              lastSyncedAt: new Date().toISOString(),
              lastError: undefined,
            },
            interviewSlug
          );
          return res.status(200).json({ ok: true, sync, details: syncResult });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Sync failed";
          const sync = await updateSyncStatus(
            {
              status: "error",
              lastRequestedAt: requestedAt,
              lastError: message,
            },
            interviewSlug
          );
          return res.status(500).json({ error: message, sync });
        }
      }

      return res
        .status(400)
        .json({ error: "POST supports resource=contacts, resource=invite, or resource=sync only" });
    }

    if (req.method === "DELETE") {
      if (resource === "results") {
        const { sessionId } = req.query;
        if (!sessionId || typeof sessionId !== "string") {
          return res.status(400).json({ error: "Missing sessionId" });
        }
        await removeResult(sessionId, interviewSlug);
        return res.status(200).json({ ok: true, deleted: "result", sessionId });
      }

      if (resource === "contacts") {
        const { code } = req.query;
        if (!code || typeof code !== "string") {
          return res.status(400).json({ error: "Missing code" });
        }
        await removeContact(code, interviewSlug);
        return res.status(200).json({ ok: true, deleted: "contact", code });
      }

      return res.status(400).json({
        error: "DELETE supports resource=results or resource=contacts",
      });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
