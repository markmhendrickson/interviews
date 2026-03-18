export interface Contact {
  code: string;
  name: string;
  email?: string;
  context?: string;
  source?: string;
}

function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data?.error) return data.error;
  } catch {
    // noop
  }
  return "Request failed";
}

export async function resolveContact(
  code: string | null,
  interviewSlug = "ai"
): Promise<Contact | null> {
  if (!code) return null;
  const key = normalizeCode(code);
  if (!key) return null;

  const response = await fetch(
    `/api/contacts?code=${encodeURIComponent(key)}&interview=${encodeURIComponent(interviewSlug)}`
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as Contact;
}

export async function listContacts(
  passphrase: string,
  interviewSlug = "ai"
): Promise<{ contacts: Contact[]; count: number }> {
  const response = await fetch(
    `/api/admin?resource=contacts&interview=${encodeURIComponent(interviewSlug)}`,
    {
    headers: { Authorization: `Bearer ${passphrase}` },
    }
  );
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as { contacts: Contact[]; count: number };
}

export async function addOrUpdateContact(
  input: Contact,
  passphrase: string,
  interviewSlug = "ai"
): Promise<{ ok: true; contact: Contact }> {
  const response = await fetch(
    `/api/admin?resource=contacts&interview=${encodeURIComponent(interviewSlug)}`,
    {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${passphrase}`,
    },
    body: JSON.stringify(input),
    }
  );
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as { ok: true; contact: Contact };
}

export async function removeContact(
  code: string,
  passphrase: string,
  interviewSlug = "ai"
): Promise<{ ok: true }> {
  const key = normalizeCode(code);
  const response = await fetch(
    `/api/admin?resource=contacts&code=${encodeURIComponent(key)}&interview=${encodeURIComponent(interviewSlug)}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${passphrase}` },
    }
  );
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }
  return (await response.json()) as { ok: true };
}
