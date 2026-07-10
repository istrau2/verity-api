import { createHash } from "node:crypto";
import { config } from "./config";
import { llmChatJSON, parseModelJSON } from "./llm";

/**
 * Text → canonical claims.
 *
 * Takes ordered sentences (typically one paragraph — the lazy-loading cache
 * unit) and produces their fundamental claims: each a minimal, self-contained
 * assertion (pronouns and references resolved), plus the mapping of which
 * sentences express which claim. Sentences asserting nothing checkable are
 * fluff.
 *
 * Chunked LLM extraction: ~12 sentences per call with a couple of preceding
 * sentences as context (so "it" can resolve to "Bitcoin"; the caller passes
 * context for the first chunk, e.g. the previous paragraph's tail). Duplicates
 * merge by normalized canonical text; because groupIds are content hashes of
 * that normalized text, groups also merge across paragraphs and across
 * separately-cached batches. Near-dupes the normalization misses collapse
 * downstream when the app's match-batch maps them to the same dupe group.
 */

export interface InputSentence {
  sentenceId: string;
  text: string;
}

export interface ClaimGroup {
  /** Stable id derived from the canonical text (stable across cache rebuilds). */
  groupId: string;
  canonicalText: string;
  /** Page sentences (in article order) that express this claim. */
  sentenceIds: string[];
}

export interface Decomposition {
  groups: ClaimGroup[];
  /** Sentences that carry no checkable claim. */
  fluff: string[];
  /**
   * Number of LLM chunk calls that failed (their sentences default to fluff).
   * Callers should only long-cache a decomposition when this is 0.
   */
  failedChunks: number;
}

const CHUNK_SIZE = 12;
const CONTEXT_SENTENCES = 2;

/** Bump when the extraction prompt/logic changes — versions the cache key so
 *  stale decompositions from older prompts don't linger for their full TTL. */
export const DECOMPOSE_VERSION = 5;

const SYSTEM = `You extract canonical factual claims from encyclopedia text for a truth-staking platform, where each claim must be a single, self-contained, objectively checkable assertion.

You receive consecutive sentences of one article, each with a numeric index. Some lines are marked CONTEXT — use them only to resolve references; do NOT return claims for them.

For EACH non-context sentence:
- Fluff (empty claims list) is ONLY text that asserts nothing checkable: transitions ("The following sections explore..."), section framing, pure opinion, or restatements of the article's structure. When in doubt, it is a claim, NOT fluff.
- Assertions about history, measurements, comparisons, causes, or scientific findings ARE claims even when qualitative (e.g. "Ongoing changes in climate have no precedent over the last several thousand years" is a checkable claim).
- Extract each claim in CANONICAL form:
  * atomic: one assertion per claim. Split independent assertions that could each be true or false on their own — including causal/explanatory clauses ("X happened, as/because Y offset Z" -> claim 1: X happened; claim 2: Y offset Z, with the timeframe/subject carried into both). Do NOT split: conjunctions/disjunctions ("and"/"or") joining objects, modifiers, manners, or a list of sources that belong to the SAME subject+verb — those stay ONE claim.
  * self-contained: resolve every pronoun AND every bare or elliptical noun phrase using the context — "it" -> the actual subject, "Changes" -> "Climate changes", "These effects" -> the specific effects. Carry timeframes and scopes into each claim. Test: would the claim mean the same thing pasted into a different article? If not, ground its subject.
  * minimal logical form: declarative, no rhetorical framing, keep numbers, dates, names and units exactly as stated.
  * consistent: if two sentences state the same fact, return the IDENTICAL canonical wording for both.

Most sentences yield 1 claim; some yield 2-3; only genuinely contentless sentences yield 0.

EXAMPLE
Input:
CONTEXT: Climate change affects the environment in many ways.
[0] Changes may occur gradually or rapidly.
[1] Evidence for these effects comes from studying climate change in the past, from modelling, and from modern observations.
Output:
{"sentences":[{"i":0,"claims":["Climate changes may occur gradually or rapidly."]},{"i":1,"claims":["Evidence for the environmental effects of climate change comes from studying climate change in the past, from modelling, and from modern observations."]}]}
(Note: "Changes" was grounded as "Climate changes"; the "or" and the list of sources were NOT split — same subject+verb.)

Respond ONLY with JSON, no prose:
{"sentences":[{"i":<index>,"claims":["...", ...]}, ...]}
Include every non-context sentence index exactly once.`;

/**
 * Decompose ordered sentences into canonical claim groups + fluff.
 * `context` supplies preceding sentences for the FIRST chunk (later chunks use
 * the preceding sentences of the array itself).
 */
export async function decomposeSentences(
  sentences: InputSentence[],
  context: string[] = [],
): Promise<Decomposition> {
  const chunks: { start: number; end: number }[] = [];
  for (let i = 0; i < sentences.length; i += CHUNK_SIZE) {
    chunks.push({ start: i, end: Math.min(i + CHUNK_SIZE, sentences.length) });
  }

  // sentence index → canonical claims (empty = fluff)
  const claimsByIndex = new Map<number, string[]>();
  let failedChunks = 0;
  await mapBounded(chunks, config.decomposeConcurrency, async ({ start, end }) => {
    const res = await extractChunk(sentences, start, end, context);
    if (!res.ok) failedChunks++;
    for (const [i, claims] of res.claims) claimsByIndex.set(i, claims);
  });

  // Merge by normalized canonical text, preserving article order.
  const byNorm = new Map<string, ClaimGroup>();
  const fluff: string[] = [];
  sentences.forEach((s, i) => {
    const claims = claimsByIndex.get(i) ?? [];
    if (claims.length === 0) {
      fluff.push(s.sentenceId);
      return;
    }
    for (const c of claims) {
      const norm = normalize(c);
      if (!norm) continue;
      let group = byNorm.get(norm);
      if (!group) {
        group = { groupId: groupIdFor(norm), canonicalText: c.trim(), sentenceIds: [] };
        byNorm.set(norm, group);
      }
      if (!group.sentenceIds.includes(s.sentenceId)) group.sentenceIds.push(s.sentenceId);
    }
  });

  return { groups: [...byNorm.values()], fluff, failedChunks };
}

/** One LLM call for sentences[start..end), with leading context lines. */
async function extractChunk(
  sentences: InputSentence[],
  start: number,
  end: number,
  externalContext: string[],
): Promise<{ ok: boolean; claims: Map<number, string[]> }> {
  const lines: string[] = [];
  if (start === 0) {
    for (const c of externalContext.slice(-CONTEXT_SENTENCES)) lines.push(`CONTEXT: ${c}`);
  }
  for (let i = Math.max(0, start - CONTEXT_SENTENCES); i < start; i++) {
    lines.push(`CONTEXT: ${sentences[i].text}`);
  }
  for (let i = start; i < end; i++) {
    lines.push(`[${i}] ${sentences[i].text}`);
  }

  const claims = new Map<number, string[]>();
  let ok = true;
  try {
    const raw = await llmChatJSON(SYSTEM, lines.join("\n"), 2000);
    const parsed = parseModelJSON(raw) as {
      sentences?: { i?: number; claims?: unknown }[];
    };
    for (const row of parsed.sentences ?? []) {
      if (typeof row.i !== "number" || row.i < start || row.i >= end) continue;
      const rowClaims = Array.isArray(row.claims)
        ? row.claims.filter((c): c is string => typeof c === "string" && c.trim().length >= 8)
        : [];
      claims.set(row.i, rowClaims.map((c) => c.trim()));
    }
  } catch (e) {
    ok = false;
    console.warn(`[verity-api] decompose chunk ${start}-${end} failed:`, e instanceof Error ? e.message : e);
  }
  // A sentence the model skipped (or a failed chunk) is treated as fluff rather
  // than inventing claims; failed chunks keep the result out of the long cache.
  for (let i = start; i < end; i++) {
    if (!claims.has(i)) claims.set(i, []);
  }
  return { ok, claims };
}

/** Run `fn` over items with at most `limit` in flight. */
async function mapBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[""'']/g, '"')
    .replace(/[^\p{L}\p{N}\s".%-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function groupIdFor(norm: string): string {
  return "g" + createHash("sha1").update(norm).digest("hex").slice(0, 10);
}
