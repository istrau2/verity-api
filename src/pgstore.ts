import { Pool } from "pg";
import { createHash } from "node:crypto";
import { config } from "./config";

/**
 * Optional Postgres persistence, sharing the verity-ingestor database.
 * Active only when DATABASE_URL is set; every function degrades to a no-op /
 * empty result otherwise, so the gateway runs fine without the ingestor stack.
 *
 * What lives here:
 *   - wiki_occurrence: canonical claim ↔ where it appears on Wikipedia
 *     (persists what the decomposition cache only holds temporarily)
 *   - canonical_match: canonical text → on-chain post id — permanent, so a
 *     once-matched claim never hits the app's rate-limited match-batch again
 * (Tables are created by the ingestor's migrate(); writes here tolerate the
 * tables not existing yet.)
 */

const pool = config.databaseUrl ? new Pool({ connectionString: config.databaseUrl }) : null;
if (pool) {
  pool.on("error", (e) => console.warn("[verity-api] pg:", e.message));
  console.log("[verity-api] persistence: postgres enabled");
}

export const pgEnabled = !!pool;

/** Canonical identity used across cache, DB and ingestor joins. */
export function canonicalHash(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 16);
}

export interface OccurrenceRow {
  text: string;
  lang: string;
  title: string;
  revision: string;
  paragraphId: string;
  sentenceIds: string[];
}

export async function persistOccurrences(rows: OccurrenceRow[]): Promise<void> {
  if (!pool || rows.length === 0) return;
  try {
    for (const r of rows) {
      await pool.query(
        `INSERT INTO wiki_occurrence (canonical_hash, canonical_text, lang, title, revision, paragraph_id, sentence_ids)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (canonical_hash, lang, title, revision, paragraph_id)
         DO UPDATE SET sentence_ids = EXCLUDED.sentence_ids, last_seen = now()`,
        [canonicalHash(r.text), r.text, r.lang, r.title, r.revision, r.paragraphId, r.sentenceIds],
      );
    }
  } catch (e) {
    console.warn("[verity-api] occurrence persist failed:", e instanceof Error ? e.message : e);
  }
}

export async function persistMatch(text: string, postId: number, similarity: number): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO canonical_match (canonical_hash, canonical_text, chain_id, post_id, similarity)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (canonical_hash) DO UPDATE SET post_id = EXCLUDED.post_id, similarity = EXCLUDED.similarity, matched_at = now()`,
      [canonicalHash(text), text, config.chainId, postId, similarity],
    );
  } catch (e) {
    console.warn("[verity-api] match persist failed:", e instanceof Error ? e.message : e);
  }
}

// ── Ingestor-written time series (read here so the gateway is the only API) ──

export interface PositionHistoryRow {
  events: { event: string; t: number | null; side: string; amount_vsp: number }[];
  snapshots: { t: number; side: string; projected_vsp: number }[];
}

/** Stake events + sampled lot values for (post, user). Null when PG is off. */
export async function positionHistory(postId: number, address: string): Promise<PositionHistoryRow | null> {
  if (!pool) return null;
  const [events, snapshots] = await Promise.all([
    pool.query(
      `SELECT event, block_time, side, amount_vsp FROM chain_event
       WHERE chain_id = $1 AND post_id = $2 AND user_address = $3
         AND event IN ('StakeAdded','StakeWithdrawn')
       ORDER BY block_number, log_index`,
      [config.chainId, postId, address.toLowerCase()],
    ),
    pool.query(
      `SELECT t, side, projected_vsp FROM lot_snapshot
       WHERE chain_id = $1 AND post_id = $2 AND user_address = $3
       ORDER BY t`,
      [config.chainId, postId, address.toLowerCase()],
    ),
  ]);
  return {
    events: events.rows.map((r) => ({
      event: r.event,
      t: r.block_time ? new Date(r.block_time).getTime() : null,
      side: Number(r.side) === 1 ? "challenge" : "support",
      amount_vsp: r.amount_vsp,
    })),
    snapshots: snapshots.rows.map((r) => ({
      t: new Date(r.t).getTime(),
      side: Number(r.side) === 1 ? "challenge" : "support",
      projected_vsp: r.projected_vsp,
    })),
  };
}

/** Post totals + scores over time. Null when PG is off. */
export async function claimHistory(postId: number): Promise<unknown[] | null> {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT t, support_vsp, challenge_vsp, base_vs, effective_vs FROM post_snapshot
     WHERE chain_id = $1 AND post_id = $2 ORDER BY t`,
    [config.chainId, postId],
  );
  return r.rows.map((row) => ({
    t: new Date(row.t).getTime(),
    support_vsp: row.support_vsp,
    challenge_vsp: row.challenge_vsp,
    base_vs: row.base_vs,
    effective_vs: row.effective_vs,
  }));
}

/** Wikipedia locations of a claim (via canonical_match ⋈ wiki_occurrence). */
export async function claimOccurrences(postId: number): Promise<unknown[] | null> {
  if (!pool) return null;
  const r = await pool.query(
    `SELECT o.lang, o.title, o.revision, o.paragraph_id, o.sentence_ids, o.canonical_text, o.last_seen
     FROM canonical_match m
     JOIN wiki_occurrence o ON o.canonical_hash = m.canonical_hash
     WHERE m.chain_id = $1 AND m.post_id = $2
     ORDER BY o.title, o.last_seen DESC`,
    [config.chainId, postId],
  );
  return r.rows;
}

/** Permanent canonical→post lookups; returns hash→{postId, similarity}. */
export async function lookupMatches(texts: string[]): Promise<Map<string, { postId: number; similarity: number }>> {
  const out = new Map<string, { postId: number; similarity: number }>();
  if (!pool || texts.length === 0) return out;
  try {
    const hashes = texts.map(canonicalHash);
    const r = await pool.query(
      "SELECT canonical_hash, post_id, similarity FROM canonical_match WHERE chain_id = $1 AND canonical_hash = ANY($2)",
      [config.chainId, hashes],
    );
    for (const row of r.rows) {
      out.set(row.canonical_hash, { postId: Number(row.post_id), similarity: row.similarity ?? 1 });
    }
  } catch (e) {
    console.warn("[verity-api] match lookup failed:", e instanceof Error ? e.message : e);
  }
  return out;
}
