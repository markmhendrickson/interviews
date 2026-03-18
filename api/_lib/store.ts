import { kv } from "@vercel/kv";

export interface Contact {
  code: string;
  name: string;
  email?: string;
  context?: string;
  source?: string;
}

export interface StoredResult {
  assessment?: {
    sessionId: string;
    [key: string]: unknown;
  };
  transcript: { role: "user" | "assistant"; content: string }[];
  storedAt: string;
  partial?: boolean;
  messageCount?: number;
  contactCode?: string;
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

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

function normalizeEmail(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized;
}

function normalizeInterviewSlug(interviewSlug: string | undefined): string {
  const normalized = String(interviewSlug || "ai")
    .trim()
    .toLowerCase();
  return normalized || "ai";
}

function contactIndexKey(interviewSlug: string): string {
  return scopedKey(`${normalizeInterviewSlug(interviewSlug)}:contacts:index`);
}

function resultIndexKey(interviewSlug: string): string {
  return scopedKey(`${normalizeInterviewSlug(interviewSlug)}:results:index`);
}

function contactKey(code: string, interviewSlug: string): string {
  return scopedKey(`${normalizeInterviewSlug(interviewSlug)}:contact:${normalizeCode(code)}`);
}

function resultKey(sessionId: string, interviewSlug: string): string {
  return scopedKey(`${normalizeInterviewSlug(interviewSlug)}:result:${sessionId}`);
}

function ensureKvConfigured(): void {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Vercel KV is not configured: set KV_REST_API_URL and KV_REST_API_TOKEN");
  }
  if (!url.startsWith("https://")) {
    throw new Error(
      "Upstash Redis client was passed an invalid URL. Use the REST endpoint (https), not the redis:// URL. " +
        "In Vercel: connect the Redis integration to your project and pull env; use the injected KV_REST_API_URL (https). " +
        "For local dev, copy the REST URL from the integration or Upstash dashboard."
    );
  }
}

export async function getContact(
  code: string,
  interviewSlug = "ai"
): Promise<Contact | null> {
  ensureKvConfigured();
  const key = normalizeCode(code);
  if (!key) return null;
  const contact = await kv.get<Contact>(contactKey(key, interviewSlug));
  return contact ?? null;
}

export async function listContacts(interviewSlug = "ai"): Promise<Contact[]> {
  ensureKvConfigured();
  const codes = await kv.smembers<string[]>(contactIndexKey(interviewSlug));
  if (!codes || codes.length === 0) return [];

  const contacts = await Promise.all(
    codes.map((code) => kv.get<Contact>(contactKey(code, interviewSlug)))
  );

  return contacts
    .filter((contact): contact is Contact => !!contact)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export async function upsertContact(
  input: Contact,
  interviewSlug = "ai"
): Promise<Contact> {
  ensureKvConfigured();

  const code = normalizeCode(input.code);
  const name = String(input.name || "").trim();
  if (!/^[a-z0-9]{2,20}$/.test(code)) {
    throw new Error("Code must be 2-20 lowercase letters/numbers.");
  }
  if (!name) {
    throw new Error("Name is required.");
  }

  const contact: Contact = {
    code,
    name,
    email: normalizeEmail(input.email),
    context: input.context?.trim() || undefined,
    source: input.source?.trim() || undefined,
  };

  await kv.set(contactKey(code, interviewSlug), contact);
  await kv.sadd(contactIndexKey(interviewSlug), code);
  return contact;
}

export async function removeContact(
  code: string,
  interviewSlug = "ai"
): Promise<void> {
  ensureKvConfigured();
  const normalized = normalizeCode(code);
  if (!normalized) return;
  await kv.del(contactKey(normalized, interviewSlug));
  await kv.srem(contactIndexKey(interviewSlug), normalized);
}

export async function getResult(
  sessionId: string,
  interviewSlug = "ai"
): Promise<StoredResult | null> {
  ensureKvConfigured();
  const result = await kv.get<StoredResult>(resultKey(sessionId, interviewSlug));
  return result ?? null;
}

export async function listResults(
  interviewSlug = "ai"
): Promise<Array<{ sessionId: string } & StoredResult>> {
  ensureKvConfigured();
  const sessionIds = await kv.smembers<string[]>(resultIndexKey(interviewSlug));
  if (!sessionIds || sessionIds.length === 0) return [];

  const rows = await Promise.all(
    sessionIds.map(async (sessionId) => {
      const value = await kv.get<StoredResult>(resultKey(sessionId, interviewSlug));
      if (!value) return null;
      return { sessionId, ...value };
    })
  );

  return rows.filter(
    (row): row is { sessionId: string } & StoredResult => row !== null
  );
}

export async function upsertResult(input: {
  assessment?: StoredResult["assessment"];
  transcript?: StoredResult["transcript"];
  interviewSlug?: string;
  partial?: boolean;
  sessionId?: string;
  messageCount?: number;
  contactCode?: string;
}): Promise<{ stored: true; sessionId: string }> {
  ensureKvConfigured();
  const interviewSlug = normalizeInterviewSlug(input.interviewSlug);
  const sessionId = String(input.sessionId || input.assessment?.sessionId || "").trim();
  if (!sessionId) {
    throw new Error("Missing sessionId");
  }

  const existing = await kv.get<StoredResult>(resultKey(sessionId, interviewSlug));
  const normalizedMessageCount =
    typeof input.messageCount === "number" && Number.isFinite(input.messageCount)
      ? Math.max(0, Math.floor(input.messageCount))
      : existing?.messageCount;
  const normalizedContactCode = input.contactCode?.trim().toLowerCase() || existing?.contactCode;
  const payload: StoredResult = {
    assessment: input.assessment ?? existing?.assessment,
    transcript: input.transcript || existing?.transcript || [],
    storedAt: new Date().toISOString(),
    partial: Boolean(input.partial),
    messageCount: normalizedMessageCount,
    contactCode: normalizedContactCode,
  };

  await kv.set(resultKey(sessionId, interviewSlug), payload);
  await kv.sadd(resultIndexKey(interviewSlug), sessionId);
  return { stored: true, sessionId };
}

export async function removeResult(
  sessionId: string,
  interviewSlug = "ai"
): Promise<void> {
  ensureKvConfigured();
  if (!sessionId) return;
  await kv.del(resultKey(sessionId, interviewSlug));
  await kv.srem(resultIndexKey(interviewSlug), sessionId);
}
