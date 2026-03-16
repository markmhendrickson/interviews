import type { VercelRequest, VercelResponse } from "@vercel/node";

const RESULTS_STORE: Record<string, unknown> = {};

function checkAuth(req: VercelRequest): boolean {
  const passphrase = process.env.ADMIN_PASSPHRASE;
  if (!passphrase) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${passphrase}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "POST") {
    const { assessment, transcript } = req.body;
    if (!assessment?.sessionId) {
      return res.status(400).json({ error: "Missing assessment with sessionId" });
    }

    RESULTS_STORE[assessment.sessionId] = {
      assessment,
      transcript: transcript || [],
      storedAt: new Date().toISOString(),
    };

    return res.status(201).json({ stored: true, sessionId: assessment.sessionId });
  }

  if (!checkAuth(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (req.method === "GET") {
    const { sessionId } = req.query;

    if (sessionId && typeof sessionId === "string") {
      const result = RESULTS_STORE[sessionId];
      if (!result) return res.status(404).json({ error: "Not found" });
      return res.status(200).json(result);
    }

    const results = Object.entries(RESULTS_STORE).map(([id, data]) => ({
      sessionId: id,
      ...(data as Record<string, unknown>),
    }));

    return res.status(200).json({ results, count: results.length });
  }

  if (req.method === "DELETE") {
    const { sessionId } = req.query;
    if (sessionId && typeof sessionId === "string") {
      delete RESULTS_STORE[sessionId];
      return res.status(200).json({ deleted: true });
    }
    return res.status(400).json({ error: "Missing sessionId" });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
