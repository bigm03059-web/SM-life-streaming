// Standalone HTTP server for SM Life Streaming (Render free tier).
//
// Bun.serve-based: serves the built client (client/dist), dispatches
// POST /actions to the registered action handlers, and streams uploaded
// audio/covers from /audio/<key> with Range support.
//
// Auth: the original app had NO login at all (single-user install). On a
// public Render URL that would let anyone read, change or delete the whole
// library, so this server requires HTTP Basic auth on every route when
// OWNER_PASS is set (browser prompts once and remembers it — no client
// change needed). In production (RENDER=true or NODE_ENV=production) the
// server refuses to start without OWNER_PASS, so the copy can never
// accidentally go up unprotected.
//
// Env:
//   DATABASE_URL   required — Neon Postgres connection string
//                  (or pglite:// for local tests, in-memory)
//   PORT           default 3000 (Render sets this)
//   OWNER_USER     default "owner"
//   OWNER_PASS     required in production; optional locally
//   GEMINI_API_KEY optional — enables the AI features (producer
//                  extraction, artist cleaning, folder naming, hum search).
//                  Without it those actions use their built-in fallbacks.
//   YOUTUBE_API_KEY optional — overrides the public web-client key baked
//                  into actions.ts (only if YouTube ever rotates it).

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Actions } from "./actions";
import * as pgSchema from "./schema";
import {
  connectDb,
  dispatchAction,
  ensureSchema,
  registerActions,
} from "./platform";

const PORT = Number(process.env.PORT ?? 3000);
const DIST_DIR = join(import.meta.dir, "..", "..", "client", "dist");
const STATIC_AUDIO_DIR = join(import.meta.dir, "..", "static", "audio");

const OWNER_USER = process.env.OWNER_USER ?? "owner";
const OWNER_PASS = process.env.OWNER_PASS ?? "";
const IS_PRODUCTION =
  process.env.RENDER === "true" || process.env.NODE_ENV === "production";

if (IS_PRODUCTION && !OWNER_PASS) {
  console.error(
    "FATAL: OWNER_PASS is not set. Refusing to start in production without\n" +
      "owner authentication — set OWNER_USER and OWNER_PASS in the Render\n" +
      "dashboard (Environment) before deploying.",
  );
  process.exit(1);
}
if (!OWNER_PASS) {
  console.warn(
    "[auth] WARNING: OWNER_PASS is not set — the app is open to anyone who\n" +
      "can reach it. Set OWNER_USER/OWNER_PASS before sharing the URL.",
  );
}

const DATABASE_URL = process.env.DATABASE_URL ?? "";
if (!DATABASE_URL) {
  console.error(
    "FATAL: DATABASE_URL is not set. Point it at the Neon Postgres\n" +
      "connection string (or pglite:// for a local in-memory test DB).",
  );
  process.exit(1);
}

const { db, close } = await connectDb(DATABASE_URL);
await ensureSchema(db);
registerActions(Actions as Record<string, unknown>);
console.log("[boot] database ready, actions registered");

// ---------------------------------------------------------------------------
// Basic auth
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorized(req: Request): boolean {
  if (!OWNER_PASS) return true; // dev only; production refuses to boot open
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  return timingSafeEqual(user, OWNER_USER) && timingSafeEqual(pass, OWNER_PASS);
}

function unauthorizedResponse(): Response {
  return new Response("Owner login required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="SM Life Streaming"' },
  });
}

// ---------------------------------------------------------------------------
// Body reading (capped — uploads arrive as base64 JSON, up to ~64M chars)
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 72_000_000;

async function readCappedBody(req: Request): Promise<string> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw Object.assign(new Error("Request body too large."), {
          status: 413,
        });
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString("utf-8");
}

// ---------------------------------------------------------------------------
// Audio streaming with Range support (static bundle + blobs table)
// ---------------------------------------------------------------------------

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] === "" ? NaN : Number(m[1]);
  let end = m[2] === "" ? NaN : Number(m[2]);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function serveAudio(
  key: string,
  req: Request,
): Promise<Response> {
  // 1. Shipped library files: audio/<ts>-<rand> -> static/audio/<ts>-<rand>.mp3
  let bytes: Buffer | null = null;
  let contentType = "audio/mpeg";
  const staticMatch = /^audio\/([A-Za-z0-9_-]+)$/.exec(key);
  if (staticMatch) {
    const file = join(STATIC_AUDIO_DIR, `${staticMatch[1]}.mp3`);
    try {
      const st = await stat(file);
      if (st.isFile()) bytes = await readFile(file);
    } catch {
      bytes = null;
    }
  }
  // 2. Files uploaded after the move: blobs table (base64).
  if (!bytes) {
    const rows = await db
      .select()
      .from(pgSchema.blobs)
      .where(eq(pgSchema.blobs.key, key))
      .limit(1);
    if (rows.length > 0) {
      bytes = Buffer.from(rows[0]!.data, "base64");
      contentType = rows[0]!.contentType;
    }
  }
  if (!bytes) return new Response("Not found.", { status: 404 });
  const range = parseRange(req.headers.get("range"), bytes.length);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400",
  };
  if (!range) {
    headers["Content-Length"] = String(bytes.length);
    return new Response(bytes, { status: 200, headers });
  }
  const slice = bytes.subarray(range.start, range.end + 1);
  headers["Content-Length"] = String(slice.length);
  headers["Content-Range"] =
    `bytes ${range.start}-${range.end}/${bytes.length}`;
  return new Response(slice, { status: 206, headers });
}

// ---------------------------------------------------------------------------
// Static client files
// ---------------------------------------------------------------------------

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

async function serveStatic(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  if (rel.includes("..")) return null;
  const file = join(DIST_DIR, rel);
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
    const body = await readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": STATIC_MIME[ext] ?? "application/octet-stream",
        "Cache-Control":
          ext === ".html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (!authorized(req)) return unauthorizedResponse();

    // Health check (also useful for Render's health checks).
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json({ ok: true });
    }

    // Audio / cover bytes.
    if (url.pathname.startsWith("/audio/") && req.method === "GET") {
      const key = decodeURIComponent(url.pathname.slice("/audio/".length));
      try {
        return await serveAudio(key, req);
      } catch (e) {
        console.error("[audio]", e);
        return new Response("Could not load that file.", { status: 500 });
      }
    }

    // Action RPC: POST /actions {action, args, actionCallId?}
    if (url.pathname === "/actions" && req.method === "POST") {
      let payload: unknown;
      try {
        const text = await readCappedBody(req);
        payload = text ? JSON.parse(text) : {};
      } catch (e) {
        const status = (e as { status?: number }).status ?? 400;
        return Response.json(
          { error: "That request could not be read. Try again.", code: "bad_request" },
          { status },
        );
      }
      const action =
        payload !== null && typeof payload === "object"
          ? (payload as { action?: unknown }).action
          : undefined;
      const args =
        payload !== null && typeof payload === "object"
          ? (payload as { args?: unknown }).args ?? {}
          : {};
      if (typeof action !== "string" || !action) {
        return Response.json(
          { error: "No action named in the request.", code: "bad_request" },
          { status: 400 },
        );
      }
      try {
        const data = await dispatchAction({ db }, action, args);
        return Response.json({ data });
      } catch (e) {
        const err = e as Error & { status?: number; issues?: unknown[] };
        const status =
          typeof err.status === "number" &&
          err.status >= 400 &&
          err.status < 500
            ? err.status
            : 500;
        console.error(`[action:${action}]`, err);
        return Response.json(
          {
            error: err.message || "Something went wrong. Try again.",
            code: status === 404 ? "unknown_action" : "action_failed",
            issues: err.issues ?? undefined,
          },
          { status },
        );
      }
    }

    // Static client (SPA fallback to index.html for unknown GET paths).
    if (req.method === "GET") {
      const file = await serveStatic(url.pathname);
      if (file) return file;
      const index = await serveStatic("/");
      if (index) return index;
    }

    return new Response("Not found.", { status: 404 });
  },
});

console.log(`[boot] SM Life Streaming (standalone) listening on :${server.port}`);
console.log(
  `[boot] AI: ${process.env.GEMINI_API_KEY ? "Gemini key set — AI features on" : "no GEMINI_API_KEY — AI features use their built-in fallbacks"}`,
);

process.on("SIGTERM", async () => {
  await close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await close();
  process.exit(0);
});
