import contactsData from "../data/contacts.json";

export interface Contact {
  code: string;
  name: string;
  context?: string;
  source?: string;
}

type ContactEntry = Omit<Contact, "code">;
type ContactStorage = {
  custom: Record<string, ContactEntry>;
  removed: string[];
};

const baseContacts: Record<string, ContactEntry> = contactsData;
const CONTACTS_STORAGE_KEY = "network_survey_custom_contacts_v1";

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

function loadStorage(): ContactStorage {
  if (typeof window === "undefined") {
    return { custom: {}, removed: [] };
  }

  try {
    const raw = window.localStorage.getItem(CONTACTS_STORAGE_KEY);
    if (!raw) return { custom: {}, removed: [] };
    const parsed = JSON.parse(raw) as Partial<ContactStorage>;
    return {
      custom: parsed.custom ?? {},
      removed: Array.isArray(parsed.removed) ? parsed.removed : [],
    };
  } catch {
    return { custom: {}, removed: [] };
  }
}

function saveStorage(next: ContactStorage): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(next));
}

function getAllContactEntries(): Record<string, ContactEntry> {
  const { custom, removed } = loadStorage();
  const merged = { ...baseContacts, ...custom };
  for (const code of removed) {
    delete merged[code];
  }
  return merged;
}

export function listContacts(): Contact[] {
  return Object.entries(getAllContactEntries())
    .map(([code, entry]) => ({ code, ...entry }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function addOrUpdateContact(input: Contact): { ok: true } | { ok: false; error: string } {
  const code = normalizeCode(input.code);
  if (!/^[a-z0-9]{2,20}$/.test(code)) {
    return { ok: false, error: "Code must be 2-20 lowercase letters/numbers." };
  }
  if (!input.name.trim()) {
    return { ok: false, error: "Name is required." };
  }

  const storage = loadStorage();
  storage.custom[code] = {
    name: input.name.trim(),
    context: input.context?.trim() || undefined,
    source: input.source?.trim() || undefined,
  };
  storage.removed = storage.removed.filter((removedCode) => removedCode !== code);
  saveStorage(storage);
  return { ok: true };
}

export function removeContact(code: string): void {
  const normalized = normalizeCode(code);
  const storage = loadStorage();
  delete storage.custom[normalized];
  if (!storage.removed.includes(normalized)) {
    storage.removed.push(normalized);
  }
  saveStorage(storage);
}

export function resolveContact(code: string | null): Contact | null {
  if (!code) return null;
  const key = normalizeCode(code);
  const entry = getAllContactEntries()[key];
  if (!entry) return null;
  return { code: key, ...entry };
}
