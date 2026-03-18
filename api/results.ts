import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isAdminAuthorized } from "./_lib/auth.js";
import { getResult, listResults, removeResult, upsertResult } from "./_lib/store.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const interviewSlug =
      typeof req.query.interview === "string"
        ? req.query.interview
        : typeof req.body?.interviewSlug === "string"
          ? req.body.interviewSlug
          : "ai";

    if (req.method === "POST") {
      const { assessment, transcript, partial, sessionId, messageCount, contactCode } =
        req.body || {};
      const stored = await upsertResult({
        assessment,
        transcript,
        interviewSlug,
        partial: Boolean(partial),
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        messageCount: typeof messageCount === "number" ? messageCount : undefined,
        contactCode: typeof contactCode === "string" ? contactCode : undefined,
      });
      return res.status(201).json(stored);
    }

    if (!isAdminAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (req.method === "GET") {
      const { sessionId } = req.query;

      if (sessionId && typeof sessionId === "string") {
        const result = await getResult(sessionId, interviewSlug);
        if (!result) return res.status(404).json({ error: "Not found" });
        return res.status(200).json(result);
      }

      const results = await listResults(interviewSlug);
      return res.status(200).json({ results, count: results.length });
    }

    if (req.method === "DELETE") {
      const { sessionId } = req.query;
      if (sessionId && typeof sessionId === "string") {
        await removeResult(sessionId, interviewSlug);
        return res.status(200).json({ deleted: true });
      }
      return res.status(400).json({ error: "Missing sessionId" });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}
