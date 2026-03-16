import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";

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
const RESULTS_STORE = new Map();

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
  const { assessment, transcript } = req.body || {};
  if (!assessment?.sessionId) {
    return res.status(400).json({ error: "Missing assessment with sessionId" });
  }
  RESULTS_STORE.set(assessment.sessionId, {
    assessment,
    transcript: transcript || [],
    storedAt: new Date().toISOString(),
  });
  return res.status(201).json({ stored: true, sessionId: assessment.sessionId });
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
  const auth = req.headers.authorization || "";
  const passphrase = process.env.ADMIN_PASSPHRASE || "";
  if (!passphrase || auth !== `Bearer ${passphrase}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const sessionId = req.query.sessionId;
  if (sessionId) {
    const result = RESULTS_STORE.get(String(sessionId));
    if (!result) return res.status(404).json({ error: "Not found" });
    return res.status(200).json(result);
  }
  const results = Array.from(RESULTS_STORE.entries()).map(([id, data]) => ({
    sessionId: id,
    ...data,
  }));
  return res.status(200).json({ results, count: results.length });
});

const server = app.listen(3000, () => {
  console.log("Network Survey API dev server listening on http://localhost:3000");
});

server.on("error", (error) => {
  console.error("API dev server error:", error);
});

