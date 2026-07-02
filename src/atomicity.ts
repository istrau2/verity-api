import { groqChatJSON } from "./groq";

/**
 * Chain-independent, LLM-based judgment of a candidate claim. This is the check
 * that a regex can't do: distinguishing a phrase-level "and" (one claim) from
 * two genuinely independent assertions, plus basic well-formed / verifiable
 * judgments. Deliberately knows nothing about chain state or duplicates — that
 * lives in the main backend.
 */
export interface AtomicityResult {
  /** True if the text is a single atomic assertion. */
  atomic: boolean;
  /** The atomic sub-claims. When atomic, a single-element array of the claim. */
  subClaims: string[];
  /** A complete, coherent declarative sentence (not a fragment or gibberish). */
  wellFormed: boolean;
  /** An objectively checkable assertion (not a question or pure opinion). */
  verifiable: boolean;
  /** Short human-readable rationale. */
  reason: string;
}

const SYSTEM = `You classify candidate factual claims for a truth-staking platform, where each claim must be a single, self-contained, objectively checkable assertion.

Judge FOUR things about the claim and return JSON only:

1. "atomic": Is it ONE assertion, or does it bundle multiple INDEPENDENT assertions?
   - A conjunction ("and", "as well as", commas) that joins objects, modifiers, or a list belonging to the SAME subject+verb is STILL atomic.
     e.g. "Miners collect transaction fees and a fixed reward" -> atomic (one claim: what miners collect).
   - Split ONLY when there are genuinely independent assertions that could each be independently true or false.
     e.g. "Bitcoin launched in 2009 and its supply is capped at 21 million" -> NOT atomic (two claims).
2. "subClaims": If atomic, return [the claim, lightly cleaned]. If not atomic, return the list of atomic sub-claims, each a complete standalone sentence.
3. "wellFormed": Is it a complete, coherent declarative sentence (not gibberish, not a trailing fragment like "The sky is")?
4. "verifiable": Is it an objectively checkable statement (not a question, command, or purely subjective opinion)?

Respond with ONLY this JSON shape, no prose:
{"atomic": boolean, "subClaims": string[], "wellFormed": boolean, "verifiable": boolean, "reason": "one short sentence"}`;

export async function assessClaim(text: string): Promise<AtomicityResult> {
  const raw = await groqChatJSON(SYSTEM, `Claim: """${text}"""`);
  const parsed = parseJson(raw);
  return normalize(parsed, text);
}

/** Parse the first JSON object out of the model output; tolerant of stray prose. */
function parseJson(s: string): Record<string, unknown> {
  const start = s.indexOf("{");
  if (start === -1) throw new Error("No JSON object in model response");
  const decoded = JSON.parse(s.slice(start, s.lastIndexOf("}") + 1));
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Model response was not a JSON object");
  }
  return decoded as Record<string, unknown>;
}

function normalize(p: Record<string, unknown>, original: string): AtomicityResult {
  const atomic = p.atomic !== false; // default to atomic when unspecified
  let subClaims = Array.isArray(p.subClaims)
    ? p.subClaims.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  if (subClaims.length === 0) subClaims = [original.trim()];
  return {
    atomic,
    subClaims,
    wellFormed: p.wellFormed !== false,
    verifiable: p.verifiable !== false,
    reason: typeof p.reason === "string" ? p.reason : "",
  };
}
