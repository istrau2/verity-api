import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";

/**
 * Environment selection.
 *   node dist/index.js --env production   (or APP_ENV=production)
 *
 * Loads `.env.<name>` first (per-env, non-secret, committed) then `.env`
 * (secrets like GROQ_API_KEY, git-ignored). dotenv does not override
 * already-set vars, so the env-specific file wins and `.env` fills the rest.
 */
function resolveEnvName(): string {
  const i = process.argv.indexOf("--env");
  let name = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : process.env.APP_ENV ?? "dev";
  if (name === "local") name = "dev"; // alias, for parity with the extension
  return name;
}

const envName = resolveEnvName();
const specific = `.env.${envName}`;
if (existsSync(specific)) loadEnv({ path: specific });
loadEnv(); // `.env` fallback (secrets); does not override values already set

export const config = {
  env: envName,
  port: Number(process.env.PORT ?? 8790),
  /**
   * LLM provider — any OpenAI-compatible chat-completions API. Groq by default;
   * a self-hosted Ollama/vLLM is a base-url + model swap. The old GROQ_* names
   * are honored as fallbacks.
   */
  llmApiKey: process.env.LLM_API_KEY ?? process.env.GROQ_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  llmBaseUrl: process.env.LLM_BASE_URL ?? process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
  /**
   * OpenRouter only: pin which underlying host(s) serve the model, in order.
   * Pinning keeps canonical wording stable — different hosts quantize the
   * "same" model differently, and wording drift breaks claim-group identity.
   */
  llmProviderOrder: (process.env.LLM_PROVIDER_ORDER ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Allow OpenRouter to fall back past the pinned hosts (default: no). */
  llmAllowFallbacks: process.env.LLM_ALLOW_FALLBACKS === "true",
  allowOrigin: process.env.ALLOW_ORIGIN ?? "*",
  /** Reject anything longer than this before spending an LLM call. */
  maxClaimLength: 2000,

  // ── Article decomposition ──
  /** Hard cap on sentences accepted per /article/claims request. */
  decomposeMaxSentences: Number(process.env.DECOMPOSE_MAX_SENTENCES ?? 200),
  /** Concurrent LLM chunk calls during one decomposition. */
  decomposeConcurrency: Number(process.env.DECOMPOSE_CONCURRENCY ?? 4),
  /**
   * Cache backend. Set REDIS_URL (e.g. redis://host:6379) for a shared cache
   * across replicated instances; unset falls back to a local SQLite file.
   */
  redisUrl: process.env.REDIS_URL ?? "",
  /**
   * Optional: the verity-ingestor Postgres. When set, the gateway persists
   * wiki occurrences + canonical→claim matches there (and reads matches back,
   * skipping the app's rate-limited match-batch for known texts).
   */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Directory for the SQLite cache file (single-node fallback). */
  cacheDir: process.env.CACHE_DIR ?? "./data",
  /** TTL for the text-only decomposition layer (revision-keyed). */
  decompositionTtlMs: Number(process.env.DECOMPOSITION_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
  /** TTL for the composed (chain-dependent) response layer. */
  resolvedTtlMs: Number(process.env.RESOLVED_TTL_MS ?? 60 * 60 * 1000),

  // ── Gateway: server-to-server access to the Verisphere app + chain ──
  /** Base URL of the app API (e.g. https://test.verisphere.co/api). */
  appApiBase: process.env.APP_API_BASE ?? "https://test.verisphere.co/api",
  /** JSON-RPC endpoint for read-only chain calls (EIP-712 domain). */
  rpcUrl: process.env.RPC_URL ?? "https://api.avax-test.network/ext/bc/C/rpc",
  /** Chain id for EIP-712 domains (Fuji = 43113). */
  chainId: Number(process.env.CHAIN_ID ?? 43113),
} as const;

/**
 * Whether the LLM is usable. Hosted providers require a key; local servers
 * (Ollama/vLLM) typically don't, so an unrecognized base URL counts as
 * configured even without one.
 */
const HOSTED_PROVIDERS = ["api.groq.com", "openrouter.ai", "api.openai.com", "api.together.xyz", "api.deepinfra.com"];
export const hasLlm = () =>
  config.llmApiKey.length > 0 || !HOSTED_PROVIDERS.some((h) => config.llmBaseUrl.includes(h));
