import { createHash } from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { config, hasLlm } from "./config";
import { assessClaim } from "./atomicity";
import { decomposeSentences, DECOMPOSE_VERSION, type Decomposition, type InputSentence } from "./decompose";
import { cacheGet, cacheSet, dedupInflight } from "./cache";
import { appGet, appPost, AppError } from "./appClient";
import { buildTx, getLivePost, getRelayConfig, getUserLot } from "./chain";
import {
  canonicalHash,
  claimHistory,
  claimOccurrences,
  lookupMatches,
  persistMatch,
  persistOccurrences,
  pgEnabled,
  positionHistory,
} from "./pgstore";

/**
 * verity-api — VALUE-ADD gateway only. The extension calls the app directly
 * (via its background worker) for plain passthroughs; verity-api handles the
 * things that need it:
 *   - /atomicity      : LLM check (holds the LLM key)
 *   - /article/claims : article → canonical claim groups (LLM decomposition,
 *                       revision-keyed cache, on-chain matching via the app)
 *   - /relay/config   : Forwarder + token EIP-712 domains, addresses, posting fee
 *   - /relay/build    : calldata encoding (keeps viem out of the extension)
 */
const app = express();
app.use(cors({ origin: config.allowOrigin === "*" ? true : config.allowOrigin.split(",") }));
app.use(express.json({ limit: "64kb" }));

const h =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[verity-api] ${req.method} ${req.path} failed:`, msg);
      if (res.headersSent) return;
      if (err instanceof AppError) res.status(err.status).json({ error: err.detail, detail: err.detail });
      else res.status(502).json({ error: "Upstream error", detail: msg.slice(0, 300) });
    });
  };

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "verity-api", env: config.env, llm: hasLlm() });
});

// ── Chain-independent LLM check ─────────────────────────────────────────────
app.post("/atomicity", h(async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text) return res.status(400).json({ error: "Body must include a non-empty 'text' string." });
  if (text.length > config.maxClaimLength) return res.status(400).json({ error: `Text exceeds ${config.maxClaimLength} characters.` });
  if (!hasLlm()) return res.status(503).json({ error: "No LLM configured on the server (LLM_API_KEY / LLM_BASE_URL)." });
  res.json(await assessClaim(text));
}));

// ── Article → canonical claim groups ────────────────────────────────────────

type Match = { postId: number; similarity: number };

/** How long a "no on-chain match" verdict may be cached (see cacheSet below). */
const NEGATIVE_MATCH_TTL_MS = 90_000;

/**
 * Match canonical texts against on-chain claims, three layers deep:
 *   1. Postgres canonical_match (permanent — a matched claim never unmatches)
 *   2. short-TTL cache (positive 60m / negative 90s, chain state drifts)
 *   3. the app's rate-limited match-batch (embeddings) for the remainder
 * Confirmed matches are persisted back to Postgres when available.
 */
async function matchCanonicals(texts: string[]): Promise<Map<number, Match>> {
  const byIndex = new Map<number, Match>();

  // Layer 1: permanent store.
  const persisted = await lookupMatches(texts);
  const remaining: number[] = [];
  texts.forEach((t, i) => {
    const hit = persisted.get(canonicalHash(t));
    if (hit) byIndex.set(i, { postId: hit.postId, similarity: hit.similarity });
    else remaining.push(i);
  });

  // Layer 2: cache.
  const missIdx: number[] = [];
  await Promise.all(
    remaining.map(async (i) => {
      const hit = await cacheGet<{ m: Match | null }>(matchKey(texts[i]));
      if (hit) {
        if (hit.m) byIndex.set(i, hit.m);
      } else {
        missIdx.push(i);
      }
    }),
  );

  const CHUNK = 99;
  for (let c = 0; c < missIdx.length; c += CHUNK) {
    const slice = missIdx.slice(c, c + CHUNK);
    const mb = await appPost<{
      results?: { index: number; matches?: { post_id: number; similarity: number }[] }[];
    }>("/claims/match-batch", {
      sentences: slice.map((i) => texts[i]),
      threshold: 0.9,
      top_k: 1,
      collapse: true,
    });
    const bySlice = new Map<number, Match>();
    for (const r of mb.results ?? []) {
      const m = r.matches?.[0];
      if (m) bySlice.set(r.index, { postId: m.post_id, similarity: m.similarity });
    }
    await Promise.all(
      slice.map(async (origIdx, sliceIdx) => {
        const m = bySlice.get(sliceIdx) ?? null;
        if (m) byIndex.set(origIdx, m);
        // Positive matches are stable (claims don't unmatch) → long TTL, and
        // persisted permanently when Postgres is around. Misses are
        // short-lived: a freshly created claim shows up as soon as the app
        // indexes its embedding, and a stale "no match" would hide the new
        // underline from everyone for the full TTL.
        await cacheSet(matchKey(texts[origIdx]), { m }, m ? config.resolvedTtlMs : NEGATIVE_MATCH_TTL_MS);
        if (m) await persistMatch(texts[origIdx], m.postId, m.similarity);
      }),
    );
  }
  return byIndex;
}

function matchKey(text: string): string {
  return "match:v1:" + createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 16);
}

async function fetchSummaries(postIds: number[]): Promise<Map<number, any>> {
  const summaries = new Map<number, any>();
  await Promise.all(
    postIds.map(async (pid) => {
      try {
        summaries.set(pid, await appGet(`/claims/${pid}/summary`));
      } catch {
        /* skip — unindexed/stale ids just stay unmatched */
      }
    }),
  );
  return summaries;
}

// LLM guardrail: per-IP budget of freshly-decomposed SENTENCES per window
// (cache hits are free — lazy loading sends many small paragraph batches).
const decomposeLog = new Map<string, { t: number; n: number }[]>();
function allowDecompose(ip: string, sentenceCount: number): boolean {
  const WINDOW = 10 * 60 * 1000;
  const LIMIT = 600; // sentences per window
  const now = Date.now();
  const log = (decomposeLog.get(ip) ?? []).filter((e) => now - e.t < WINDOW);
  const used = log.reduce((sum, e) => sum + e.n, 0);
  if (used + sentenceCount > LIMIT) return false;
  log.push({ t: now, n: sentenceCount });
  decomposeLog.set(ip, log);
  return true;
}

interface ParagraphInput {
  paragraphId: string;
  /** Preceding sentences, context-only (pronoun resolution across paragraphs). */
  context: string[];
  sentences: InputSentence[];
}

/**
 * Lazy, paragraph-batched resolution. The client sends whichever paragraphs
 * scrolled into view; the PARAGRAPH is the cache unit (viewport-independent,
 * so every user's scroll warms the same entries). Decompositions are cached
 * long (revision-keyed); on-chain matches are cached short per canonical text.
 * Groups merge across paragraphs by content-hash groupId.
 */
app.post("/article/claims", h(async (req, res) => {
  const rawParas: unknown = req.body?.paragraphs;
  const paragraphs: ParagraphInput[] = (Array.isArray(rawParas) ? rawParas : [])
    .filter((p: any) => p && typeof p.paragraphId === "string" && Array.isArray(p.sentences))
    .map((p: any) => ({
      paragraphId: p.paragraphId,
      context: Array.isArray(p.context) ? p.context.filter((c: unknown) => typeof c === "string").slice(-2) : [],
      sentences: p.sentences
        .filter((s: any) => s && typeof s.sentenceId === "string" && typeof s.text === "string" && s.text.trim())
        .slice(0, 60),
    }))
    .filter((p: ParagraphInput) => p.sentences.length > 0);

  const totalSentences = paragraphs.reduce((n, p) => n + p.sentences.length, 0);
  if (totalSentences === 0) return res.json({ groups: [], fluff: [] });
  if (totalSentences > config.decomposeMaxSentences) {
    return res.status(413).json({ error: `Too many sentences in one batch: ${totalSentences} > ${config.decomposeMaxSentences}` });
  }

  const url = typeof req.body?.url === "string" ? req.body.url : "";
  const lang = /^https?:\/\/([a-z-]+)\.(?:m\.)?wikipedia\.org\//i.exec(url)?.[1] ?? "xx";
  const title = (typeof req.body?.title === "string" ? req.body.title : "untitled")
    .toLowerCase().replace(/\s+/g, "_").slice(0, 200);
  const rev = String(req.body?.revisionId ?? "norev");
  // Key includes the model: different models produce different canonical
  // wordings, so a provider/model switch must not serve the old model's cache.
  const model = config.llmModel.replace(/[^a-z0-9.-]/gi, "_");
  const keyFor = (p: ParagraphInput) => {
    const textHash = createHash("sha1").update(p.sentences.map((s) => s.text).join("\n")).digest("hex").slice(0, 8);
    return `wiki:v${DECOMPOSE_VERSION}:${model}:${lang}:${title}:${rev}:${p.paragraphId}:${textHash}`;
  };

  // Per-paragraph decomposition: cached → free; missing → LLM (budgeted).
  const cached = await Promise.all(paragraphs.map((p) => cacheGet<Decomposition>(keyFor(p))));
  const missing = paragraphs.filter((_, i) => !cached[i]);
  if (missing.length > 0) {
    if (!hasLlm()) return res.status(503).json({ error: "No LLM configured on the server." });
    const missingSentences = missing.reduce((n, p) => n + p.sentences.length, 0);
    if (!allowDecompose(req.ip ?? "unknown", missingSentences)) {
      return res.status(429).json({ error: "Analysis budget exhausted for this address — try again in a few minutes." });
    }
  }
  const decomps = await Promise.all(
    paragraphs.map(async (p, i) => {
      if (cached[i]) return cached[i]!;
      const key = keyFor(p);
      return dedupInflight(key, async () => {
        const d = await decomposeSentences(p.sentences, p.context);
        // Only long-cache complete decompositions; partial ones retry sooner.
        await cacheSet(key, d, d.failedChunks === 0 ? config.decompositionTtlMs : 5 * 60 * 1000);
        return d;
      });
    }),
  );

  // Persist occurrences (canonical claim ↔ page location) so "where does this
  // claim appear on Wikipedia" outlives the decomposition cache. Fire-and-forget.
  if (pgEnabled) {
    const rows = paragraphs.flatMap((p, i) =>
      decomps[i].groups.map((g) => ({
        text: g.canonicalText,
        lang,
        title,
        revision: rev,
        paragraphId: p.paragraphId,
        sentenceIds: g.sentenceIds,
      })),
    );
    void persistOccurrences(rows);
  }

  // Merge groups across paragraphs — groupIds are content hashes, so the same
  // canonical claim in two paragraphs lands in one group.
  const merged = new Map<string, { canonicalText: string; sentenceIds: string[] }>();
  const fluff: string[] = [];
  for (const d of decomps) {
    fluff.push(...d.fluff);
    for (const g of d.groups) {
      const existing = merged.get(g.groupId);
      if (existing) {
        for (const id of g.sentenceIds) if (!existing.sentenceIds.includes(id)) existing.sentenceIds.push(id);
      } else {
        merged.set(g.groupId, { canonicalText: g.canonicalText, sentenceIds: [...g.sentenceIds] });
      }
    }
  }
  const groupList = [...merged.entries()];

  // On-chain overlay: match canonical texts (cached per text), hydrate summaries.
  let matches = new Map<number, Match>();
  try {
    matches = await matchCanonicals(groupList.map(([, g]) => g.canonicalText));
  } catch (e) {
    console.warn("[verity-api] match-batch failed; groups degrade to eligible:", e instanceof Error ? e.message : e);
  }
  const summaries = await fetchSummaries([...new Set([...matches.values()].map((m) => m.postId))]);

  const groups = groupList.map(([groupId, g], i) => {
    const m = matches.get(i);
    const summary = m ? summaries.get(m.postId) : undefined;
    if (m && summary) {
      return {
        group_id: groupId,
        canonical_text: g.canonicalText,
        sentence_ids: g.sentenceIds,
        status: summary.is_active ? "mapped" : "low-liquidity",
        match_score: m.similarity,
        claim: summary,
      };
    }
    return { group_id: groupId, canonical_text: g.canonicalText, sentence_ids: g.sentenceIds, status: "eligible" };
  });

  res.json({ groups, fluff });
}));

/**
 * Live stake totals straight from StakeEngine via RPC — the app's indexer can
 * lag the chain by minutes, so anything user-facing that must reflect a stake
 * the user JUST confirmed reads from here instead.
 */
app.get("/claims/:id/live", h(async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isInteger(postId) || postId < 0) {
    return res.status(400).json({ error: "Invalid post id" });
  }
  const [live, cfg] = await Promise.all([getLivePost(postId), getRelayConfig()]);
  const totalWei = live.supportWei + live.challengeWei;
  res.json({
    post_id: postId,
    support_vsp: Number(live.supportWei) / 1e18,
    challenge_vsp: Number(live.challengeWei) / 1e18,
    // Live scores from ScoreEngine views (same numbers the app indexes later).
    base_vs: live.baseVs,
    effective_vs: live.effectiveVs,
    // Active = clears the protocol's activity threshold (the posting fee).
    active: totalWei >= BigInt(cfg.postingFeeWei),
  });
}));

/**
 * A user's live position on a claim, from StakeEngine.getUserLotInfo: the
 * PROJECTED lot value (principal ± epoch settlement gains/losses — i.e. the
 * earnings signal), entry epoch, and queue position weight.
 */
app.get("/claims/:id/lot/:address", h(async (req, res) => {
  const postId = Number(req.params.id);
  const address = String(req.params.address ?? "");
  if (!Number.isInteger(postId) || postId < 0 || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "Invalid post id or address" });
  }
  const lot = await getUserLot(postId, address);
  const side = (s: typeof lot.support) =>
    s && {
      projected_vsp: s.projectedVsp,
      entry_epoch: s.entryEpoch,
      position_weight: s.positionWeight,
      side_total_vsp: s.sideTotalVsp,
    };
  res.json({ post_id: postId, support: side(lot.support), challenge: side(lot.challenge) });
}));

// ── Historical series (ingestor-written Postgres; 503 when not configured) ──

app.get("/positions/:address/:postId/history", h(async (req, res) => {
  const postId = Number(req.params.postId);
  const address = String(req.params.address ?? "");
  if (!Number.isInteger(postId) || postId < 0 || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "Invalid post id or address" });
  }
  const hist = await positionHistory(postId, address);
  if (!hist) return res.status(503).json({ error: "History store not configured (DATABASE_URL)." });
  res.json({ post_id: postId, ...hist });
}));

app.get("/claims/:id/history", h(async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isInteger(postId) || postId < 0) return res.status(400).json({ error: "Invalid post id" });
  const snapshots = await claimHistory(postId);
  if (!snapshots) return res.status(503).json({ error: "History store not configured (DATABASE_URL)." });
  res.json({ post_id: postId, snapshots });
}));

app.get("/claims/:id/occurrences", h(async (req, res) => {
  const postId = Number(req.params.id);
  if (!Number.isInteger(postId) || postId < 0) return res.status(400).json({ error: "Invalid post id" });
  const occurrences = await claimOccurrences(postId);
  if (!occurrences) return res.status(503).json({ error: "History store not configured (DATABASE_URL)." });
  res.json({ post_id: postId, occurrences });
}));

/**
 * A claim was just created for this canonical text — seed the match cache with
 * the positive verdict so its underline survives page refreshes immediately
 * (no waiting for the app to embed the claim, and no stale negative verdict).
 * Poison-proof: the post id is derived from the app's exact on-chain lookup,
 * never taken from the caller.
 */
app.post("/claim-created", h(async (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > config.maxClaimLength) {
    return res.status(400).json({ error: "Body must include a valid 'text' string." });
  }
  const chk = await appGet<{ exists?: boolean; post_id?: number | null }>(
    `/claims/check-onchain?text=${encodeURIComponent(text)}`,
  );
  if (chk?.exists && chk.post_id != null) {
    await cacheSet(matchKey(text), { m: { postId: chk.post_id, similarity: 1 } }, config.resolvedTtlMs);
    await persistMatch(text, chk.post_id, 1);
    return res.json({ seeded: true, post_id: chk.post_id });
  }
  res.json({ seeded: false });
}));

// ── Relay: EIP-712 domains + calldata (nodeless, server-side) ───────────────
app.get("/relay/config", h(async (_req, res) => {
  res.json(await getRelayConfig());
}));

app.post("/relay/build", h(async (req, res) => {
  const action = req.body?.action;
  if (action !== "setStake" && action !== "createClaim" && action !== "approve") {
    return res.status(400).json({ error: "action must be 'setStake', 'createClaim', or 'approve'" });
  }
  res.json(await buildTx(action, req.body ?? {}));
}));

app.listen(config.port, () => {
  console.log(
    `[verity-api] env=${config.env} listening on :${config.port} ` +
      `(app=${config.appApiBase}, llm=${hasLlm() ? config.llmModel : "MISSING"})`,
  );
});
