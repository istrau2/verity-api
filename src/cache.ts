import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "redis";
import { config } from "./config";

/**
 * Persistent KV cache with pluggable backends behind one tiny interface:
 *   - Redis (REDIS_URL set)  — shared across replicated instances; one
 *     visitor's decomposition warms the cache for every replica.
 *   - SQLite (default)       — zero-infrastructure single-node fallback,
 *     via Node's built-in node:sqlite (no native deps).
 *
 * Two tiers live here under different key suffixes: the text-only
 * decomposition (revision-keyed, long TTL) and the composed response
 * (chain-dependent, short TTL). Cache failures degrade to misses — an
 * unavailable cache slows the service down, it never breaks it.
 */

interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

// ── SQLite backend (single node) ─────────────────────────────────────────────

function sqliteStore(): CacheStore {
  mkdirSync(config.cacheDir, { recursive: true });
  const db = new DatabaseSync(join(config.cacheDir, "cache.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS kv_expires ON kv(expires_at);
  `);
  const getStmt = db.prepare("SELECT value FROM kv WHERE key = ? AND expires_at > ?");
  const setStmt = db.prepare(
    "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
  );
  const sweepStmt = db.prepare("DELETE FROM kv WHERE expires_at <= ?");

  // Housekeeping: sweep expired rows hourly (and once at startup).
  const sweep = () => {
    try {
      sweepStmt.run(Date.now());
    } catch {
      /* non-fatal */
    }
  };
  sweep();
  setInterval(sweep, 60 * 60 * 1000).unref();

  return {
    async get(key) {
      const row = getStmt.get(key, Date.now()) as { value: string } | undefined;
      return row?.value ?? null;
    },
    async set(key, value, ttlMs) {
      setStmt.run(key, value, Date.now() + ttlMs);
    },
  };
}

// ── Redis backend (replicated deployments) ───────────────────────────────────

function redisStore(url: string): CacheStore {
  const client = createClient({ url });
  client.on("error", (err: Error) => console.warn("[verity-api] redis:", err.message));
  const ready = client.connect().catch((err: Error) => {
    console.warn("[verity-api] redis connect failed:", err.message);
  });

  return {
    async get(key) {
      try {
        await ready;
        return await client.get(key);
      } catch {
        return null; // degrade to a cache miss
      }
    },
    async set(key, value, ttlMs) {
      try {
        await ready;
        await client.set(key, value, { PX: ttlMs });
      } catch {
        /* degrade silently */
      }
    },
  };
}

const store: CacheStore = config.redisUrl ? redisStore(config.redisUrl) : sqliteStore();
console.log(`[verity-api] cache backend: ${config.redisUrl ? "redis" : "sqlite"}`);

export async function cacheGet<T>(key: string): Promise<T | null> {
  const raw = await store.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  await store.set(key, JSON.stringify(value), ttlMs);
}

// ── In-flight dedup ──────────────────────────────────────────────────────────
// Concurrent identical requests share one promise. This is per-instance: with
// replicas, the worst case is two instances decomposing the same article once
// each — duplicate LLM spend, never incorrect results (last write wins with
// identical content). A cross-instance lock (SET NX) can be added if that
// spend ever matters.

const inflight = new Map<string, Promise<unknown>>();

export async function dedupInflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
