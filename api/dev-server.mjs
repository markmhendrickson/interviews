import "dotenv/config";
import { config } from "dotenv";
import path from "path";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
// Load .env then .env.development.local so Vercel-pulled vars (e.g. KV_REST_API_URL) are used
config({ path: path.join(projectRoot, ".env") });
config({ path: path.join(projectRoot, ".env.development.local"), override: true });
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { kv } from "@vercel/kv";
import sendgrid from "@sendgrid/mail";

const app = express();
app.use(express.json({ limit: "2mb" }));

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn("ANTHROPIC_API_KEY is not set. /api/chat and /api/assess will fail.");
}
if (!process.env.ELEVENLABS_API_KEY) {
  console.warn(
    "ELEVENLABS_API_KEY is not set. /api/elevenlabs/signed-url will fail and voice may disconnect early."
  );
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getNamespace() {
  return (
    process.env.KV_KEY_PREFIX ||
    process.env.VERCEL_ENV ||
    process.env.NODE_ENV ||
    "development"
  )
    .trim()
    .toLowerCase();
}

function scopedKey(key) {
  return `survey:${getNamespace()}:${key}`;
}

const CONTACT_INDEX_KEY = scopedKey("contacts:index");
const RESULT_INDEX_KEY = scopedKey("results:index");
const EVENT_INDEX_KEY = scopedKey("events:index");
const SYNC_STATUS_KEY = scopedKey("sync_status");

function ensureKvConfigured() {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Vercel KV is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN");
  }
  if (!url.startsWith("https://")) {
    throw new Error(
      "Upstash Redis requires the REST endpoint (https), not redis://. " +
        "Connect the Redis integration to your project in Vercel and use the injected KV_REST_API_URL, or copy the REST URL from Upstash."
    );
  }
}

function normalizeCode(code) {
  return String(code || "").trim().toLowerCase();
}

function contactKey(code) {
  return scopedKey(`contact:${normalizeCode(code)}`);
}

function resultKey(sessionId) {
  return scopedKey(`result:${String(sessionId || "").trim()}`);
}

function eventKey(eventId) {
  return scopedKey(`event:${String(eventId || "").trim()}`);
}

async function getSyncStatus() {
  const existing = await kv.get(SYNC_STATUS_KEY);
  return (
    existing || {
      interviewSlug: "ai",
      status: "idle",
    }
  );
}

function createEventId() {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMessageCount(messageCount) {
  if (typeof messageCount !== "number" || !Number.isFinite(messageCount)) return undefined;
  return Math.max(0, Math.floor(messageCount));
}

function isAdminAuthorized(req) {
  const auth = req.headers.authorization || "";
  const passphrase = process.env.ADMIN_PASSPHRASE || "";
  return !!passphrase && auth === `Bearer ${passphrase}`;
}

function getBaseUrl() {
  return (
    process.env.INTERVIEWS_BASE_URL ||
    process.env.PUBLIC_APP_BASE_URL ||
    "https://interviews.markmhendrickson.com"
  ).replace(/\/+$/, "");
}

function buildShareUrl(interviewSlug, code) {
  return `${getBaseUrl()}/${encodeURIComponent(interviewSlug || "ai")}/${encodeURIComponent(
    normalizeCode(code)
  )}`;
}

function renderTemplate(template, context) {
  return template.replace(/\{\{(name|share_url|interview_name|sender_name)\}\}/g, (_, key) => {
    return context[key] ?? "";
  });
}

async function loadInviteTemplates() {
  const emailPath = path.join(projectRoot, "src/templates/invite_email.html");
  const textPath = path.join(projectRoot, "src/templates/invite_text.txt");
  const [emailTemplate, textTemplate] = await Promise.all([
    readFile(emailPath, "utf8"),
    readFile(textPath, "utf8"),
  ]);
  return { emailTemplate, textTemplate };
}

async function recordEvent(payload) {
  const event = {
    eventId: createEventId(),
    eventType: payload.eventType,
    timestamp: new Date().toISOString(),
    sessionId: payload.sessionId ? String(payload.sessionId).trim() : undefined,
    shareCode: payload.shareCode ? normalizeCode(payload.shareCode) : undefined,
    messageCount: normalizeMessageCount(payload.messageCount),
    metadata: payload.metadata && typeof payload.metadata === "object" ? payload.metadata : undefined,
  };
  await kv.set(eventKey(event.eventId), event);
  await kv.sadd(EVENT_INDEX_KEY, event.eventId);
  return event;
}

app.post("/api/chat", async (req, res) => {
  const { messages, systemPrompt } = req.body || {};

  if (!messages || !systemPrompt) {
    return res.status(400).json({ error: "Missing messages or systemPrompt" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const stream = await client.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  }
});

app.post("/api/assess", async (req, res) => {
  const { transcript, sessionId, contactName, durationSeconds } = req.body || {};
  if (!transcript || !sessionId) {
    return res.status(400).json({ error: "Missing transcript or sessionId" });
  }

  const extractionPrompt = `You are an assessment extraction system. Given a conversation transcript between an AI interviewer and a contact, extract a structured assessment.
Return ONLY valid JSON with these keys:
contactName, icpTier, icpProfile, matchConfidence, matchedSignals, antiIcpSignals, personSummary, recommendations, referralPotential, referralNotes, keyInsights, toolsUsed, preferredAiTool.`;

  try {
    const formattedTranscript = transcript
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n\n");

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      system: extractionPrompt,
      messages: [
        {
          role: "user",
          content: `Extract structured assessment from this transcript:\n\n${formattedTranscript}`,
        },
      ],
    });

    const text = response.content?.[0]?.type === "text" ? response.content[0].text : "{}";
    const raw = text.match(/\{[\s\S]*\}/)?.[0] || "{}";
    const assessment = JSON.parse(raw);
    assessment.sessionId = sessionId;
    assessment.timestamp = new Date().toISOString();
    assessment.durationSeconds = durationSeconds || 0;
    if (contactName) assessment.contactName = contactName;

    return res.status(200).json(assessment);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

app.post("/api/results", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      const { assessment, transcript, partial, sessionId: rawSessionId, messageCount, contactCode } =
        req.body || {};
      const sessionId = String(rawSessionId || assessment?.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId" });
      }

      const existing = await kv.get(resultKey(sessionId));
      await kv.set(resultKey(sessionId), {
        assessment: assessment || existing?.assessment,
        transcript: transcript || existing?.transcript || [],
        storedAt: new Date().toISOString(),
        partial: !!partial,
        messageCount: normalizeMessageCount(messageCount) ?? existing?.messageCount,
        contactCode: contactCode ? normalizeCode(contactCode) : existing?.contactCode,
      });
      await kv.sadd(RESULT_INDEX_KEY, sessionId);

      return res.status(201).json({ stored: true, sessionId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

const handleSignedUrl = async (req, res) => {
  const { agentId } = req.body || {};
  if (!agentId || typeof agentId !== "string") {
    return res.status(400).json({ error: "Missing agentId" });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ELEVENLABS_API_KEY is not set" });
  }

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(
        agentId
      )}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": apiKey,
        },
      }
    );

    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message =
        payload?.detail ||
        payload?.message ||
        `ElevenLabs API returned ${upstream.status}`;
      return res.status(502).json({ error: message });
    }

    const signedUrl = payload?.signed_url || payload?.signedUrl;
    if (!signedUrl) {
      return res.status(502).json({ error: "No signed URL returned by ElevenLabs" });
    }

    return res.status(200).json({ signedUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
};

app.post("/api/elevenlabs/signed-url", handleSignedUrl);
// Backward-compatible typo alias (older local builds may still call this path).
app.post("/api/evenlabs/signed-url", handleSignedUrl);

app.get("/api/results", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const sessionId = req.query.sessionId;
      if (sessionId) {
        const result = await kv.get(resultKey(String(sessionId)));
        if (!result) return res.status(404).json({ error: "Not found" });
        return res.status(200).json(result);
      }

      const sessionIds = await kv.smembers(RESULT_INDEX_KEY);
      const rows = await Promise.all(
        (sessionIds || []).map(async (id) => {
          const value = await kv.get(resultKey(id));
          return value ? { sessionId: id, ...value } : null;
        })
      );
      const results = rows.filter(Boolean);
      return res.status(200).json({ results, count: results.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

app.delete("/api/results", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const sessionId = String(req.query.sessionId || "").trim();
      if (!sessionId) {
        return res.status(400).json({ error: "Missing sessionId" });
      }
      await kv.del(resultKey(sessionId));
      await kv.srem(RESULT_INDEX_KEY, sessionId);
      return res.status(200).json({ deleted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

app.post("/api/events", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      const { eventType, sessionId, shareCode, messageCount, metadata } = req.body || {};
      const normalizedEventType = String(eventType || "").trim();
      if (!normalizedEventType) {
        return res.status(400).json({ error: "Missing eventType" });
      }
      const event = await recordEvent({
        eventType: normalizedEventType,
        sessionId,
        shareCode,
        messageCount,
        metadata,
      });
      return res.status(201).json({ ok: true, event });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

app.get("/api/events", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const code = normalizeCode(req.query.code);
      const sessionId = String(req.query.sessionId || "").trim();
      const eventIds = await kv.smembers(EVENT_INDEX_KEY);
      const rows = await Promise.all((eventIds || []).map((id) => kv.get(eventKey(id))));
      const events = rows
        .filter(Boolean)
        .filter((event) => {
          if (code && event.shareCode !== code) return false;
          if (sessionId && event.sessionId !== sessionId) return false;
          return true;
        })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return res.status(200).json({ events, count: events.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

app.get("/api/contacts", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      const code = req.query.code;
      if (code && typeof code === "string") {
        const contact = await kv.get(contactKey(code));
        if (!contact) return res.status(404).json({ error: "Not found" });
        return res.status(200).json(contact);
      }

      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const codes = await kv.smembers(CONTACT_INDEX_KEY);
      const rows = await Promise.all(
        (codes || []).map((entryCode) => kv.get(contactKey(entryCode)))
      );
      const contacts = rows
        .filter(Boolean)
        .sort((a, b) => String(a.code).localeCompare(String(b.code)));
      return res.status(200).json({ contacts, count: contacts.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

app.post("/api/contacts", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const { code, name, email, context, source } = req.body || {};
      const normalizedCode = normalizeCode(code);
      const trimmedName = String(name || "").trim();
      if (!/^[a-z0-9]{2,20}$/.test(normalizedCode)) {
        return res
          .status(400)
          .json({ error: "Code must be 2-20 lowercase letters/numbers." });
      }
      if (!trimmedName) {
        return res.status(400).json({ error: "Name is required." });
      }
      const contact = {
        code: normalizedCode,
        name: trimmedName,
        email: email ? String(email).trim().toLowerCase() || undefined : undefined,
        context: context ? String(context).trim() || undefined : undefined,
        source: source ? String(source).trim() || undefined : undefined,
      };
      await kv.set(contactKey(normalizedCode), contact);
      await kv.sadd(CONTACT_INDEX_KEY, normalizedCode);
      return res.status(201).json({ ok: true, contact });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

app.delete("/api/contacts", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const code = normalizeCode(req.query.code);
      if (!code) return res.status(400).json({ error: "Missing code" });
      await kv.del(contactKey(code));
      await kv.srem(CONTACT_INDEX_KEY, code);
      return res.status(200).json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

async function processInvite(req, res) {
  ensureKvConfigured();
  if (!isAdminAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const method = String(req.body?.method || "").trim();
  if (!["email", "text", "text_confirm"].includes(method)) {
    return res.status(400).json({ error: "Invalid invite method" });
  }

  const interviewSlug = String(req.body?.interviewSlug || "ai").trim().toLowerCase() || "ai";
  const code = normalizeCode(req.body?.code);
  if (!code) {
    return res.status(400).json({ error: "Missing code" });
  }

  const contact = await kv.get(contactKey(code));
  if (!contact) {
    return res.status(404).json({ error: "Contact not found" });
  }

  const senderName = String(req.body?.senderName || process.env.SENDGRID_FROM_NAME || "Mark").trim();
  const interviewName = "AI interview";
  const shareUrl = buildShareUrl(interviewSlug, code);
  const { emailTemplate, textTemplate } = await loadInviteTemplates();
  const text = renderTemplate(textTemplate, {
    name: contact.name,
    share_url: shareUrl,
    interview_name: interviewName,
    sender_name: senderName,
  }).trim();

  if (method === "email") {
    const to = String(contact.email || "").trim().toLowerCase();
    if (!to) {
      return res.status(400).json({ error: "Contact is missing email" });
    }
    if (!process.env.SENDGRID_API_KEY || !process.env.SENDGRID_FROM_EMAIL) {
      return res
        .status(500)
        .json({ error: "Missing SENDGRID_API_KEY or SENDGRID_FROM_EMAIL" });
    }
    sendgrid.setApiKey(process.env.SENDGRID_API_KEY);
    await sendgrid.send({
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL,
        name: senderName,
      },
      subject: `${interviewName}: quick invite`,
      text,
      html: renderTemplate(emailTemplate, {
        name: contact.name,
        share_url: shareUrl,
        interview_name: interviewName,
        sender_name: senderName,
      }),
    });
    const event = await recordEvent({
      eventType: "invite_email_sent",
      shareCode: code,
      metadata: { recipientEmail: to },
    });
    return res.status(200).json({ ok: true, method, result: { sent: true, to, shareUrl }, event });
  }

  if (method === "text") {
    const event = await recordEvent({
      eventType: "invite_text_prepared",
      shareCode: code,
      metadata: { recipientName: contact.name },
    });
    return res.status(200).json({ ok: true, method, result: { message: text, shareUrl }, event });
  }

  const event = await recordEvent({
    eventType: "invite_text_confirmed",
    shareCode: code,
    metadata: { recipientName: contact.name },
  });
  return res.status(200).json({ ok: true, method, event });
}

app.post("/api/invite", (req, res) => {
  (async () => {
    try {
      return await processInvite(req, res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

app.all("/api/admin", (req, res) => {
  (async () => {
    try {
      ensureKvConfigured();
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const resource = String(req.query.resource || "overview");

      if (req.method === "GET") {
        if (resource === "results") {
          const sessionId = String(req.query.sessionId || "").trim();
          if (sessionId) {
            const result = await kv.get(resultKey(sessionId));
            if (!result) return res.status(404).json({ error: "Not found" });
            return res.status(200).json(result);
          }
          const sessionIds = await kv.smembers(RESULT_INDEX_KEY);
          const rows = await Promise.all(
            (sessionIds || []).map(async (id) => {
              const value = await kv.get(resultKey(id));
              return value ? { sessionId: id, ...value } : null;
            })
          );
          const results = rows.filter(Boolean);
          return res.status(200).json({ results, count: results.length });
        }

        if (resource === "contacts") {
          const code = normalizeCode(req.query.code);
          if (code) {
            const contact = await kv.get(contactKey(code));
            if (!contact) return res.status(404).json({ error: "Not found" });
            return res.status(200).json(contact);
          }
          const codes = await kv.smembers(CONTACT_INDEX_KEY);
          const rows = await Promise.all(
            (codes || []).map((entryCode) => kv.get(contactKey(entryCode)))
          );
          const contacts = rows
            .filter(Boolean)
            .sort((a, b) => String(a.code).localeCompare(String(b.code)));
          return res.status(200).json({ contacts, count: contacts.length });
        }

        if (resource === "events") {
          const code = normalizeCode(req.query.code);
          const sessionId = String(req.query.sessionId || "").trim();
          const eventIds = await kv.smembers(EVENT_INDEX_KEY);
          const rows = await Promise.all((eventIds || []).map((id) => kv.get(eventKey(id))));
          const events = rows
            .filter(Boolean)
            .filter((event) => {
              if (code && event.shareCode !== code) return false;
              if (sessionId && event.sessionId !== sessionId) return false;
              return true;
            })
            .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
          return res.status(200).json({ events, count: events.length });
        }

        if (resource === "sync") {
          const sync = await getSyncStatus();
          return res.status(200).json({ sync });
        }

        const [sessionIds, codes] = await Promise.all([
          kv.smembers(RESULT_INDEX_KEY),
          kv.smembers(CONTACT_INDEX_KEY),
        ]);
        const [resultsRows, contactsRows] = await Promise.all([
          Promise.all(
            (sessionIds || []).map(async (id) => {
              const value = await kv.get(resultKey(id));
              return value ? { sessionId: id, ...value } : null;
            })
          ),
          Promise.all((codes || []).map((entryCode) => kv.get(contactKey(entryCode)))),
        ]);
        const results = resultsRows.filter(Boolean);
        const contacts = contactsRows
          .filter(Boolean)
          .sort((a, b) => String(a.code).localeCompare(String(b.code)));
        return res.status(200).json({
          results,
          contacts,
          sync: await getSyncStatus(),
          counts: { results: results.length, contacts: contacts.length },
        });
      }

      if (req.method === "POST") {
        if (resource === "contacts") {
          const { code, name, email, context, source } = req.body || {};
          const normalizedCode = normalizeCode(code);
          const trimmedName = String(name || "").trim();
          if (!/^[a-z0-9]{2,20}$/.test(normalizedCode)) {
            return res
              .status(400)
              .json({ error: "Code must be 2-20 lowercase letters/numbers." });
          }
          if (!trimmedName) {
            return res.status(400).json({ error: "Name is required." });
          }
          const contact = {
            code: normalizedCode,
            name: trimmedName,
            email: email ? String(email).trim().toLowerCase() || undefined : undefined,
            context: context ? String(context).trim() || undefined : undefined,
            source: source ? String(source).trim() || undefined : undefined,
          };
          await kv.set(contactKey(normalizedCode), contact);
          await kv.sadd(CONTACT_INDEX_KEY, normalizedCode);
          return res.status(201).json({ ok: true, contact });
        }

        if (resource === "invite") {
          return await processInvite(req, res);
        }

        if (resource === "sync") {
          const now = new Date().toISOString();
          const current = await getSyncStatus();
          const requestedStatus =
            req.body?.status === "success" ||
            req.body?.status === "error" ||
            req.body?.status === "requested"
              ? req.body.status
              : "requested";
          const sync = {
            ...current,
            interviewSlug: "ai",
            status: requestedStatus,
            lastRequestedAt: now,
            ...(requestedStatus === "success"
              ? { lastSyncedAt: String(req.body?.lastSyncedAt || now), lastError: undefined }
              : {}),
            ...(requestedStatus === "error"
              ? { lastError: String(req.body?.lastError || "Sync failed") }
              : {}),
          };
          await kv.set(SYNC_STATUS_KEY, sync);
          return res.status(200).json({ ok: true, sync });
        }

        return res
          .status(400)
          .json({ error: "POST supports resource=contacts, resource=invite, or resource=sync only" });
      }

      if (req.method === "DELETE") {
        if (resource === "results") {
          const sessionId = String(req.query.sessionId || "").trim();
          if (!sessionId) {
            return res.status(400).json({ error: "Missing sessionId" });
          }
          await kv.del(resultKey(sessionId));
          await kv.srem(RESULT_INDEX_KEY, sessionId);
          return res.status(200).json({ ok: true, deleted: "result", sessionId });
        }

        if (resource === "contacts") {
          const code = normalizeCode(req.query.code);
          if (!code) return res.status(400).json({ error: "Missing code" });
          await kv.del(contactKey(code));
          await kv.srem(CONTACT_INDEX_KEY, code);
          return res.status(200).json({ ok: true, deleted: "contact", code });
        }

        return res
          .status(400)
          .json({ error: "DELETE supports resource=results or resource=contacts" });
      }

      return res.status(405).json({ error: "Method not allowed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return res.status(500).json({ error: message });
    }
  })();
});

const server = app.listen(3000, () => {
  console.log("Interviews API dev server listening on http://localhost:3000");
});

server.on("error", (error) => {
  console.error("API dev server error:", error);
});

