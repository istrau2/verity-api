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
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  groqBaseUrl: process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
  allowOrigin: process.env.ALLOW_ORIGIN ?? "*",
  /** Reject anything longer than this before spending an LLM call. */
  maxClaimLength: 2000,
} as const;

export const hasGroqKey = () => config.groqApiKey.length > 0;
