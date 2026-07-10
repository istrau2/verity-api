import { config } from "./config";

/**
 * Server-to-server client for the Verisphere app API. A server is not subject
 * to CORS, so verity-api can call the app's endpoints directly — the extension
 * only ever talks to verity-api.
 */

const base = config.appApiBase.replace(/\/$/, "");

export async function appGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new AppError(res.status, await safeText(res));
  return (await res.json()) as T;
}

export async function appPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new AppError(res.status, await safeText(res));
  return (await res.json()) as T;
}

export class AppError extends Error {
  readonly status: number;
  /** The app's human-readable message (FastAPI `detail`), extracted from body. */
  readonly detail: string;
  constructor(status: number, body: string) {
    let detail = body;
    try {
      const j = JSON.parse(body);
      if (typeof j?.detail === "string") detail = j.detail;
      else if (typeof j?.error === "string") detail = j.error;
    } catch {
      /* non-JSON body — use as-is */
    }
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}
