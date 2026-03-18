import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isAdminAuthorized } from "./_lib/auth.js";
import { getContact, listContacts, removeContact, upsertContact } from "./_lib/store.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const interviewSlug =
      typeof req.query.interview === "string"
        ? req.query.interview
        : req.method === "POST" && typeof req.body?.interviewSlug === "string"
          ? req.body.interviewSlug
          : "ai";

    if (req.method === "GET") {
      const { code } = req.query;
      if (code && typeof code === "string") {
        const contact = await getContact(code, interviewSlug);
        if (!contact) return res.status(404).json({ error: "Not found" });
        return res.status(200).json(contact);
      }

      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const contacts = await listContacts(interviewSlug);
      return res.status(200).json({ contacts, count: contacts.length });
    }

    if (req.method === "POST") {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
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

    if (req.method === "DELETE") {
      if (!isAdminAuthorized(req)) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      const { code } = req.query;
      if (!code || typeof code !== "string") {
        return res.status(400).json({ error: "Missing code" });
      }
      await removeContact(code, interviewSlug);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
