import { jsonrepair } from "jsonrepair";
import { config } from "./config";

/**
 * Minimal client for any OpenAI-compatible chat-completions API (Groq, OpenAI,
 * or a self-hosted Ollama/vLLM — configured via LLM_BASE_URL / LLM_MODEL /
 * LLM_API_KEY). We ask for a JSON object response and return the raw string
 * content for the caller to parse.
 */
const MAX_RATE_LIMIT_RETRIES = 2;

export async function llmChatJSON(system: string, user: string, maxTokens = 500): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.llmApiKey) headers.Authorization = `Bearer ${config.llmApiKey}`;

  // OpenRouter-specific: pin the underlying host(s) so canonical wording stays
  // deterministic (see LLM_PROVIDER_ORDER). Other providers reject unknown
  // body fields, so only attach it on OpenRouter.
  const isOpenRouter = config.llmBaseUrl.includes("openrouter.ai");
  const routing =
    isOpenRouter && config.llmProviderOrder.length > 0
      ? { provider: { order: config.llmProviderOrder, allow_fallbacks: config.llmAllowFallbacks } }
      : {};
  if (isOpenRouter) headers["X-Title"] = "verity-api";

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...routing,
      }),
    });

    if (res.ok) {
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      return data.choices?.[0]?.message?.content ?? "";
    }

    const body = await res.text().catch(() => "");
    // Rate-limited (TPM): the provider says how long to wait — do that instead
    // of failing the chunk (a failed chunk degrades its sentences to fluff).
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const wait = retryDelayMs(res, body);
      console.warn(`[verity-api] LLM 429 — retrying in ${wait}ms (attempt ${attempt + 1})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`LLM ${res.status}: ${body.slice(0, 300)}`);
  }
}

/** Wait time for a 429: Retry-After header, or the "try again in Xs" hint. */
function retryDelayMs(res: Response, body: string): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 8000);
  const m = /try again in ([\d.]+)(ms|s)/i.exec(body);
  if (m) {
    const v = parseFloat(m[1]) * (m[2].toLowerCase() === "ms" ? 1 : 1000);
    return Math.min(Math.ceil(v) + 250, 8000); // small buffer past the hint
  }
  return 2000;
}

/**
 * Parse the first JSON object out of model output; tolerant of stray prose
 * AND of mildly malformed JSON (some hosts emit unescaped quotes, trailing
 * commas, etc. even in json_object mode — jsonrepair fixes those).
 */
export function parseModelJSON(s: string): Record<string, unknown> {
  const start = s.indexOf("{");
  if (start === -1) throw new Error("No JSON object in model response");
  const slice = s.slice(start, s.lastIndexOf("}") + 1);
  let decoded: unknown;
  try {
    decoded = JSON.parse(slice);
  } catch {
    decoded = JSON.parse(jsonrepair(slice));
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Model response was not a JSON object");
  }
  return decoded as Record<string, unknown>;
}
