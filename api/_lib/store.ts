import { kv } from "@vercel/kv";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

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

export interface SyncStatus {
  interviewSlug: string;
  status: "idle" | "requested" | "success" | "error";
  lastSyncedAt?: string;
  lastRequestedAt?: string;
  lastError?: string;
}

const execFileAsync = promisify(execFile);

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

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeImportedCode(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.length < 2) return null;
  return normalized.slice(0, 20);
}

function ensureUniqueCode(baseCode: string, usedCodes: Set<string>): string {
  if (!usedCodes.has(baseCode)) {
    usedCodes.add(baseCode);
    return baseCode;
  }
  for (let i = 2; i < 10_000; i += 1) {
    const suffix = String(i);
    const candidate = `${baseCode.slice(0, Math.max(2, 20 - suffix.length))}${suffix}`;
    if (!usedCodes.has(candidate)) {
      usedCodes.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Unable to generate unique contact code for "${baseCode}"`);
}

function buildNameBasedCode(name: string, usedCodes: Set<string>): string | null {
  const tokens = name
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return null;

  const first = tokens[0];
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : "";

  const firstCandidate = normalizeImportedCode(first);
  const firstLastCandidate = normalizeImportedCode(`${first}${last}`);

  if (firstCandidate && !usedCodes.has(firstCandidate)) {
    usedCodes.add(firstCandidate);
    return firstCandidate;
  }

  if (firstLastCandidate && !usedCodes.has(firstLastCandidate)) {
    usedCodes.add(firstLastCandidate);
    return firstLastCandidate;
  }

  if (firstLastCandidate) {
    return ensureUniqueCode(firstLastCandidate, usedCodes);
  }
  if (firstCandidate) {
    return ensureUniqueCode(firstCandidate, usedCodes);
  }
  return null;
}

function mapNeotomaEntityToContact(
  entity: Record<string, unknown>,
  usedCodes: Set<string>
): Contact | null {
  const snapshot =
    entity.snapshot && typeof entity.snapshot === "object"
      ? (entity.snapshot as Record<string, unknown>)
      : {};
  const canonicalName = asString(entity.canonical_name);
  const name = asString(snapshot.name) || asString(snapshot.full_name) || canonicalName;
  if (!name) return null;

  const code = buildNameBasedCode(name, usedCodes);
  if (!code) return null;

  const email = normalizeEmail(asString(snapshot.email));
  const contextParts = [
    asString(snapshot.context),
    asString(snapshot.company),
    asString(snapshot.title),
    asString(snapshot.location),
  ].filter((part): part is string => Boolean(part));

  return {
    code,
    name,
    email,
    context: contextParts.length > 0 ? contextParts.join(" · ") : undefined,
    source: "neotoma_sync",
  };
}

function mapHttpContactToContact(
  row: Record<string, unknown>,
  usedCodes: Set<string>
): Contact | null {
  const name =
    asString(row.name) || asString(row.full_name) || asString(row.canonical_name);
  if (!name) return null;

  const importedCode = normalizeImportedCode(
    asString(row.code) || asString(row.contact_code)
  );
  const code = importedCode
    ? ensureUniqueCode(importedCode, usedCodes)
    : buildNameBasedCode(name, usedCodes);
  if (!code) return null;

  const contextParts = [
    asString(row.context),
    asString(row.company),
    asString(row.title),
    asString(row.location),
  ].filter((part): part is string => Boolean(part));

  return {
    code,
    name,
    email: normalizeEmail(asString(row.email)),
    context: contextParts.length > 0 ? contextParts.join(" · ") : undefined,
    source: asString(row.source) || "neotoma_sync",
  };
}

async function fetchNeotomaContactsViaHttp(): Promise<Contact[]> {
  const endpoint = process.env.INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_URL?.trim();
  if (!endpoint) return [];

  const limit = Number.parseInt(process.env.INTERVIEWS_NEOTOMA_SYNC_LIMIT || "500", 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 500;
  const timeoutMsRaw = Number.parseInt(
    process.env.INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_TIMEOUT_MS || "15000",
    10
  );
  const timeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw >= 1000
      ? Math.min(timeoutMsRaw, 120000)
      : 15000;

  const url = new URL(endpoint);
  if (!url.searchParams.has("type")) url.searchParams.set("type", "contact");
  if (!url.searchParams.has("limit")) url.searchParams.set("limit", String(safeLimit));

  const headerName = (
    process.env.INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_HEADER || "Authorization"
  ).trim();
  const token = process.env.INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_TOKEN?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers[headerName] =
      headerName.toLowerCase() === "authorization" ? `Bearer ${token}` : token;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch Neotoma contacts via HTTP: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Neotoma sync API returned ${response.status}: ${text.slice(0, 300) || "empty response"}`
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Neotoma sync API returned invalid JSON: ${message}`);
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (Array.isArray((parsed as { contacts?: unknown[] }).contacts)
          ? (parsed as { contacts: unknown[] }).contacts
          : Array.isArray((parsed as { entities?: unknown[] }).entities)
            ? (parsed as { entities: unknown[] }).entities
            : [])
      : [];

  const usedCodes = new Set<string>();
  const mapped: Contact[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const asRecord = row as Record<string, unknown>;
    const contact =
      asString(asRecord.name) || asString(asRecord.full_name)
        ? mapHttpContactToContact(asRecord, usedCodes)
        : mapNeotomaEntityToContact(asRecord, usedCodes);
    if (contact) mapped.push(contact);
  }
  return mapped;
}

async function fetchNeotomaContactsViaCli(): Promise<Contact[]> {
  const neotomaTargetEnv = (
    process.env.INTERVIEWS_ADMIN_NEOTOMA_ENV ||
    process.env.NEOTOMA_TARGET_ENV ||
    process.env.NEOTOMA_ENV ||
    "dev"
  )
    .trim()
    .toLowerCase();
  const envArg = neotomaTargetEnv.startsWith("prod") ? "prod" : "dev";
  const cliBin = (process.env.NEOTOMA_CLI_BIN || "neotoma").trim();
  const limit = Number.parseInt(process.env.INTERVIEWS_NEOTOMA_SYNC_LIMIT || "500", 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 500;

  const childEnv = { ...process.env };
  const configuredDataDir = process.env.INTERVIEWS_ADMIN_NEOTOMA_DATA_DIR?.trim();
  if (configuredDataDir) {
    childEnv.NEOTOMA_DATA_DIR = configuredDataDir;
  } else if (!childEnv.NEOTOMA_DATA_DIR) {
    const cursorMcpPath = join(homedir(), ".cursor", "mcp.json");
    try {
      const raw = await readFile(cursorMcpPath, "utf8");
      const parsed = JSON.parse(raw) as {
        mcpServers?: Record<string, { env?: Record<string, unknown> }>;
      };
      const mcpDataDir = parsed.mcpServers?.["neotoma-dev"]?.env?.NEOTOMA_DATA_DIR;
      if (typeof mcpDataDir === "string" && mcpDataDir.trim()) {
        childEnv.NEOTOMA_DATA_DIR = mcpDataDir.trim();
      }
    } catch {
      // Optional local convenience fallback only.
    }
  }
  if (process.env.INTERVIEWS_ADMIN_NEOTOMA_ENV?.trim()) {
    childEnv.NEOTOMA_ENV = process.env.INTERVIEWS_ADMIN_NEOTOMA_ENV.trim();
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      cliBin,
      [envArg, "entities", "list", "--type", "contact", "--limit", String(safeLimit)],
      { env: childEnv }
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch Neotoma contacts via CLI: ${message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Neotoma CLI returned invalid JSON: ${message}`);
  }

  const rows =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { entities?: unknown[] }).entities)
      ? ((parsed as { entities: unknown[] }).entities as Record<string, unknown>[])
      : [];

  const usedCodes = new Set<string>();
  const mapped: Contact[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const contact = mapNeotomaEntityToContact(row, usedCodes);
    if (contact) mapped.push(contact);
  }
  return mapped;
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

function syncStatusKey(interviewSlug: string): string {
  return scopedKey(`${normalizeInterviewSlug(interviewSlug)}:sync_status`);
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

export async function getSyncStatus(interviewSlug = "ai"): Promise<SyncStatus> {
  ensureKvConfigured();
  const normalized = normalizeInterviewSlug(interviewSlug);
  const stored = await kv.get<SyncStatus>(syncStatusKey(normalized));
  return (
    stored ?? {
      interviewSlug: normalized,
      status: "idle",
    }
  );
}

export async function updateSyncStatus(
  update: Partial<SyncStatus>,
  interviewSlug = "ai"
): Promise<SyncStatus> {
  ensureKvConfigured();
  const normalized = normalizeInterviewSlug(interviewSlug);
  const current = await getSyncStatus(normalized);
  const definedUpdates = Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined)
  ) as Partial<SyncStatus>;
  const next: SyncStatus = {
    ...current,
    ...definedUpdates,
    interviewSlug: normalized,
  };
  await kv.set(syncStatusKey(normalized), next);
  return next;
}

export async function syncContactsFromNeotoma(
  interviewSlug = "ai"
): Promise<{ imported: number; removed: number; skipped: number }> {
  ensureKvConfigured();

  const useHttpSyncSource = Boolean(
    process.env.INTERVIEWS_ADMIN_NEOTOMA_SYNC_API_URL?.trim()
  );
  const fetched = useHttpSyncSource
    ? await fetchNeotomaContactsViaHttp()
    : await fetchNeotomaContactsViaCli();
  const fetchedMap = new Map<string, Contact>();
  for (const contact of fetched) fetchedMap.set(contact.code, contact);

  const existing = await listContacts(interviewSlug);
  const existingCodes = new Set(existing.map((contact) => contact.code));
  const existingImportedCodes = new Set(
    existing.filter((contact) => contact.source === "neotoma_sync").map((contact) => contact.code)
  );

  let imported = 0;
  for (const contact of fetchedMap.values()) {
    await kv.set(contactKey(contact.code, interviewSlug), contact);
    if (!existingCodes.has(contact.code)) {
      await kv.sadd(contactIndexKey(interviewSlug), contact.code);
    }
    imported += 1;
  }

  let removed = 0;
  for (const code of existingImportedCodes) {
    if (fetchedMap.has(code)) continue;
    await removeContact(code, interviewSlug);
    removed += 1;
  }

  return {
    imported,
    removed,
    skipped: Math.max(0, fetched.length - fetchedMap.size),
  };
}
