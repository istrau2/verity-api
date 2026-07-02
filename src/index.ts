import express, { type Request, type Response } from "express";
import cors from "cors";
import { config, hasGroqKey } from "./config";
import { assessClaim } from "./atomicity";

const app = express();
app.use(cors({ origin: config.allowOrigin === "*" ? true : config.allowOrigin.split(",") }));
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "verity-api", groq: hasGroqKey(), model: config.groqModel });
});

/**
 * POST /atomicity
 * Body: { text: string }
 * Returns the chain-independent LLM judgment (atomic / subClaims / wellFormed /
 * verifiable). Chain-dependent checks (dedup, on-chain existence) live in the
 * main app backend, not here.
 */
app.post("/atomicity", async (req: Request, res: Response) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) {
    return res.status(400).json({ error: "Body must include a non-empty 'text' string." });
  }
  if (text.length > config.maxClaimLength) {
    return res.status(400).json({ error: `Text exceeds ${config.maxClaimLength} characters.` });
  }
  if (!hasGroqKey()) {
    // Fail explicitly so the client can fall back to local heuristics.
    return res.status(503).json({ error: "GROQ_API_KEY not configured on the server." });
  }

  try {
    const result = await assessClaim(text);
    return res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[verity-api] atomicity failed:", msg);
    return res.status(502).json({ error: "Upstream LLM error", detail: msg.slice(0, 300) });
  }
});

app.listen(config.port, () => {
  console.log(
    `[verity-api] env=${config.env} listening on :${config.port} ` +
      `(model=${config.groqModel}, groqKey=${hasGroqKey() ? "set" : "MISSING"})`,
  );
});
