// Standalone replacement for `@hatch/space-sdk` (server side).
//
// The original actions.ts imports exactly four things from the SDK:
// `defineAction`, `z`, and the types `ActionsModule` and `Ctx`. This module
// provides all four with the same shapes, backed by ordinary infrastructure:
//
// - `ctx.db`      -> Drizzle over Postgres (Neon free tier in production,
//                    PGlite in-process for local tests). Same select/insert/
//                    update/delete API the handlers already use.
// - `ctx.blobs`   -> BlobClient over two stores: the 34 audio files that
//                    shipped with the app live as static files under
//                    server/static/audio/ (key `audio/<ts>-<rand>` -> file
//                    `<ts>-<rand>.mp3`); anything uploaded after the move is
//                    stored in the `blobs` table (base64 text) in Postgres.
//                    `getUrl` returns an own-origin `/audio/<key>` URL that
//                    the HTTP server streams with Range support.
// - `ctx.inference.complete` -> Google Gemini REST API (free tier, no card)
//                    when GEMINI_API_KEY is set; when it is not set it throws
//                    a plain Error, and every call site in actions.ts already
//                    catches that and falls back to its deterministic path
//                    (producer -> null, artist cleaning -> feat-strip,
//                    folder planning -> deterministic parse, hum search ->
//                    description-only iTunes search).
// - `ctx.invalidateQueries` -> no-op (the client refetches with React Query
//   on its own; there is no cross-client invalidation channel here).
// - `ctx.emit` -> no-op. `ctx.agent` / `ctx.tool` -> not implemented: the
//   original actions never call them (verified by grep).
// - `ctx.viewer` -> undefined (no login; the server gates access with HTTP
//   Basic auth instead — see server.ts).

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as pgSchema from "./schema";

export { z };
export type { NodePgDatabase };

export type SpaceDb<TSchema extends Record<string, unknown> = typeof pgSchema> =
  NodePgDatabase<TSchema>;

// ---------------------------------------------------------------------------
// Inference errors
// ---------------------------------------------------------------------------

export const INFERENCE_SCHEMA_ERROR_BRAND =
  "@hatch/space-sdk/InferenceSchemaError/v1";

export class InferenceSchemaError extends Error {
  readonly __brand: typeof INFERENCE_SCHEMA_ERROR_BRAND =
    INFERENCE_SCHEMA_ERROR_BRAND;
  readonly issues: readonly unknown[];

  constructor(issues: readonly unknown[]) {
    super("The AI response did not match the expected shape.");
    this.issues = issues;
    this.name = "InferenceSchemaError";
  }

  static is(value: unknown): value is InferenceSchemaError {
    if (value instanceof InferenceSchemaError) return true;
    return (
      value !== null &&
      typeof value === "object" &&
      "__brand" in value &&
      (value as { __brand?: unknown }).__brand ===
        INFERENCE_SCHEMA_ERROR_BRAND
    );
  }
}

// ---------------------------------------------------------------------------
// Action registry
// ---------------------------------------------------------------------------

export type ActionDefinition<
  Req extends z.ZodType = z.ZodType,
  Res extends z.ZodType = z.ZodType,
> = {
  readonly __brand: "@hatch/space-sdk/action/v1";
  readonly request: Req;
  readonly response: Res;
  readonly description?: string;
  readonly handler: (
    ctx: Ctx,
    args: z.infer<Req>,
  ) => Promise<z.infer<Res>>;
};

export type ActionsModule = Record<
  string,
  Omit<ActionDefinition, "handler"> & {
    handler: (ctx: Ctx, args: any) => Promise<any>;
  }
>;

const registry = new Map<string, ActionDefinition>();

export function defineAction<
  Req extends z.ZodType,
  Res extends z.ZodType,
>(spec: {
  request: Req;
  response: Res;
  description?: string;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}): ActionDefinition<Req, Res> {
  const def: ActionDefinition<Req, Res> = {
    __brand: "@hatch/space-sdk/action/v1",
    request: spec.request,
    response: spec.response,
    description: spec.description,
    handler: spec.handler,
  };
  return def;
}

export function isAction(value: unknown): value is ActionDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    "__brand" in value &&
    (value as { __brand?: unknown }).__brand === "@hatch/space-sdk/action/v1"
  );
}

/** Register a module's exported actions by name (called once at boot). */
export function registerActions(actions: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(actions)) {
    if (isAction(value)) registry.set(name, value);
  }
}

export function listActionNames(): string[] {
  return [...registry.keys()].sort();
}

// ---------------------------------------------------------------------------
// Blobs
// ---------------------------------------------------------------------------

export type BlobPutData = string | ArrayBuffer | ArrayBufferView | Blob;

export interface BlobMetadata {
  readonly key: string;
  readonly contentType: string;
  readonly size: number;
  readonly sizeBytes: number;
  readonly etag: string;
  readonly visibility: "private" | "public";
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly public: boolean;
}

export interface BlobClient {
  put(
    key: string,
    data: BlobPutData,
    options?: { contentType?: string; public?: boolean },
  ): Promise<void>;
  getUrl(key: string, options?: { expiresInSeconds?: number }): Promise<string>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<BlobMetadata | null>;
  list(prefix?: string): Promise<BlobMetadata[]>;
}

const STATIC_AUDIO_DIR = join(
  import.meta.dir,
  "..",
  "static",
  "audio",
);

function staticFileForKey(key: string): string | null {
  // Only the shipped library lives on disk: audio/<ts>-<rand> (.mp3).
  // Anything else (covers, photos, chapters) lives in the blobs table.
  const m = /^audio\/([A-Za-z0-9_-]+)$/.exec(key);
  if (!m) return null;
  return join(STATIC_AUDIO_DIR, `${m[1]}.mp3`);
}

async function toBuffer(data: BlobPutData): Promise<Buffer> {
  if (typeof data === "string") return Buffer.from(data, "utf-8");
  if (data instanceof Blob) return Buffer.from(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function createBlobClient(db: SpaceDb): BlobClient {
  const exists = async (key: string): Promise<boolean> => {
    const f = staticFileForKey(key);
    if (f) {
      try {
        await readFile(f);
        return true;
      } catch {
        // fall through to the table
      }
    }
    const rows = await db
      .select({ key: pgSchema.blobs.key })
      .from(pgSchema.blobs)
      .where(eq(pgSchema.blobs.key, key))
      .limit(1);
    return rows.length > 0;
  };

  return {
    async put(key, data, options) {
      const buf = await toBuffer(data);
      const contentType =
        options?.contentType ?? "application/octet-stream";
      await db
        .insert(pgSchema.blobs)
        .values({
          key,
          contentType,
          sizeBytes: buf.length,
          data: buf.toString("base64"),
        })
        .onConflictDoNothing();
      // onConflictDoNothing covers re-put of the same key; a fresh key
      // always inserts. (Keys are timestamp+random, so collisions are
      // effectively impossible; the row is simply kept if one occurs.)
    },

    async getUrl(key) {
      if (!(await exists(key))) {
        throw new Error(`blob not found: ${key}`);
      }
      return `/audio/${encodeURIComponent(key)}`;
    },

    async delete(key) {
      // Only the blobs table is ever deleted from. Files under
      // server/static/audio/ are part of the deployment itself — deleting
      // a library row must not delete the shipped file, and once no row
      // references a key the file is unreachable anyway.
      await db.delete(pgSchema.blobs).where(eq(pgSchema.blobs.key, key));
    },

    async head(key) {
      const rows = await db
        .select()
        .from(pgSchema.blobs)
        .where(eq(pgSchema.blobs.key, key))
        .limit(1);
      if (rows.length > 0) {
        const r = rows[0]!;
        return {
          key: r.key,
          contentType: r.contentType,
          size: r.sizeBytes,
          sizeBytes: r.sizeBytes,
          etag: `db-${r.key}`,
          visibility: "private" as const,
          createdAtMs: r.createdAt.getTime(),
          updatedAtMs: r.createdAt.getTime(),
          public: false,
        };
      }
      const f = staticFileForKey(key);
      if (f) {
        try {
          const buf = await readFile(f);
          return {
            key,
            contentType: "audio/mpeg",
            size: buf.length,
            sizeBytes: buf.length,
            etag: `static-${key}`,
            visibility: "private" as const,
            createdAtMs: 0,
            updatedAtMs: 0,
            public: false,
          };
        } catch {
          return null;
        }
      }
      return null;
    },

    async list(prefix = "") {
      const rows = await db.select().from(pgSchema.blobs);
      const out: BlobMetadata[] = rows
        .filter((r) => r.key.startsWith(prefix))
        .map((r) => ({
          key: r.key,
          contentType: r.contentType,
          size: r.sizeBytes,
          sizeBytes: r.sizeBytes,
          etag: `db-${r.key}`,
          visibility: "private" as const,
          createdAtMs: r.createdAt.getTime(),
          updatedAtMs: r.createdAt.getTime(),
          public: false,
        }));
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Inference (Gemini free tier, optional)
// ---------------------------------------------------------------------------

export interface InferenceCompleteOptions<
  T extends z.ZodType = z.ZodType,
> {
  readonly schema: T;
  readonly timeout_secs?: number;
  readonly system?: string;
  readonly images?: readonly {
    readonly dataBase64: string;
    readonly mimeType?: "image/jpeg" | "image/png";
    readonly filename?: string;
    readonly caption?: string;
  }[];
}

export interface InferenceClient {
  complete<T extends z.ZodType>(
    prompt: string,
    options: InferenceCompleteOptions<T>,
  ): Promise<z.infer<T>>;
}

function createInferenceClient(): InferenceClient {
  return {
    async complete(prompt, options) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "AI is not set up on this copy (no GEMINI_API_KEY).",
        );
      }
      const model = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
      const timeoutMs = (options.timeout_secs ?? 60) * 1000;
      const jsonSchema = zodToJsonSchema(options.schema, {
        $refStrategy: "none",
      });
      const parts: Record<string, unknown>[] = [{ text: prompt }];
      for (const img of options.images ?? []) {
        parts.push({
          inlineData: {
            mimeType: img.mimeType ?? "image/jpeg",
            data: img.dataBase64,
          },
        });
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: options.system
              ? { parts: [{ text: options.system }] }
              : undefined,
            contents: [{ parts }],
            generationConfig: {
              responseMimeType: "application/json",
              responseSchema: jsonSchema,
            },
          }),
        },
      );
      if (!res.ok) {
        throw new Error(
          `Gemini request failed (HTTP ${res.status}).`,
        );
      }
      const json = (await res.json()) as {
        candidates?: {
          content?: { parts?: { text?: string }[] };
        }[];
      };
      const text = json.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? "")
        .join("");
      if (!text) throw new Error("Gemini returned no text.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Gemini returned text that was not JSON.");
      }
      const result = options.schema.safeParse(parsed);
      if (!result.success) {
        throw new InferenceSchemaError(result.error.issues);
      }
      return result.data;
    },
  };
}

// ---------------------------------------------------------------------------
// Context + dispatch
// ---------------------------------------------------------------------------

export interface Ctx {
  readonly slug: string;
  readonly invocationId: string;
  readonly db: <TSchema extends Record<string, unknown> = typeof pgSchema>() => SpaceDb<TSchema>;
  readonly blobs: BlobClient;
  readonly inference: InferenceClient;
  readonly viewer?: undefined;
  emit(data: unknown): void;
  invalidateQueries(): void;
}

export interface PlatformDeps {
  db: SpaceDb;
}

export function createCtx(deps: PlatformDeps): Ctx {
  const blobs = createBlobClient(deps.db);
  const inference = createInferenceClient();
  return {
    slug: "music-streaming-app",
    invocationId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    db: () => deps.db as never,
    blobs,
    inference,
    viewer: undefined,
    emit() {},
    invalidateQueries() {},
  };
}

/** Run one action by name. Returns `{data}` or throws an Error. */
export async function dispatchAction(
  deps: PlatformDeps,
  name: string,
  args: unknown,
): Promise<unknown> {
  const def = registry.get(name);
  if (!def) {
    const err = new Error(`Unknown action: ${name}`) as Error & {
      status?: number;
    };
    err.status = 404;
    throw err;
  }
  const parsedArgs = def.request.safeParse(args ?? {});
  if (!parsedArgs.success) {
    const first = parsedArgs.error.issues[0];
    const err = new Error(
      first
        ? `${String(first.path.join("."))}: ${first.message}`
        : "Invalid request.",
    ) as Error & { status?: number; issues?: unknown[] };
    err.status = 400;
    err.issues = parsedArgs.error.issues;
    throw err;
  }
  const ctx = createCtx(deps);
  const result = await def.handler(ctx, parsedArgs.data);
  const parsedRes = def.response.safeParse(result);
  if (!parsedRes.success) {
    throw new Error(
      `Action ${name} returned an unexpected shape; please try again.`,
    );
  }
  return parsedRes.data;
}

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

export interface DbHandle {
  db: SpaceDb;
  close(): Promise<void>;
}

export async function connectDb(
  databaseUrl: string,
): Promise<DbHandle> {
  if (databaseUrl.startsWith("pglite://")) {
    // Local-test only: in-process Postgres (no server needed).
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    const client = new PGlite(databaseUrl.slice("pglite://".length) || undefined);
    await client.waitReady;
    // Same Drizzle API surface as the node-postgres database; only the
    // session type differs, so this test-only branch is cast to SpaceDb.
    const db = drizzlePglite(client, { schema: pgSchema }) as unknown as SpaceDb;
    return {
      db,
      close: async () => {
        await client.close();
      },
    };
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    ssl:
      databaseUrl.includes("sslmode=require") ||
      databaseUrl.includes("neon.tech")
        ? { rejectUnauthorized: false }
        : undefined,
  });
  pool.on("error", (err) => {
    console.error("[db] idle pool error:", err);
  });
  const db = drizzle(pool, { schema: pgSchema });
  return {
    db,
    close: async () => {
      await pool.end();
    },
  };
}

/** Create all tables (used by the migration script and first boot). */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS saved_albums (
  id SERIAL PRIMARY KEY,
  catalog_id TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artist_id TEXT,
  artwork_url TEXT,
  artwork_blob_key TEXT,
  genre TEXT,
  release_label TEXT,
  release_date_label TEXT,
  label TEXT,
  producer TEXT,
  contributors TEXT,
  album_info TEXT,
  source TEXT NOT NULL DEFAULT 'catalog',
  downloaded INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS saved_tracks (
  id SERIAL PRIMARY KEY,
  album_id INTEGER,
  catalog_track_id TEXT,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  track_number INTEGER NOT NULL DEFAULT 0,
  disc_number INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  preview_url TEXT,
  artwork_url TEXT,
  blob_key TEXT,
  file_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS playlists (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS playlist_items (
  id SERIAL PRIMARY KEY,
  playlist_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  preview_url TEXT,
  artwork_url TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  blob_key TEXT,
  saved_track_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS play_history (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artwork_url TEXT,
  played_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artist_profiles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  artist_key TEXT NOT NULL,
  artist_id TEXT,
  photo_url TEXT,
  photo_blob_key TEXT,
  background_url TEXT,
  background_blob_key TEXT,
  bio TEXT,
  description TEXT,
  genre TEXT,
  wiki_url TEXT,
  source TEXT NOT NULL DEFAULT 'ai-created',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS artist_profiles_key ON artist_profiles (artist_key);
CREATE TABLE IF NOT EXISTS app_plan (
  id INTEGER PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'developer',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS uploaded_books (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS uploaded_book_chapters (
  id SERIAL PRIMARY KEY,
  book_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  chapter_number INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  blob_key TEXT,
  file_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_requests (
  id SERIAL PRIMARY KEY,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolution_note TEXT,
  seen_done INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS playback_requests (
  id SERIAL PRIMARY KEY,
  query TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  artwork_url TEXT,
  preview_url TEXT,
  fallback_preview_url TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  album_title TEXT,
  saved_track_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blobs (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blobs_created_at_idx ON blobs (created_at);
`;

export async function ensureSchema(db: SpaceDb): Promise<void> {
  // One statement at a time: the Postgres extended query protocol rejects
  // multi-statement strings sent as a single prepared statement.
  for (const stmt of MIGRATION_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await db.execute(sql.raw(stmt));
  }
}
