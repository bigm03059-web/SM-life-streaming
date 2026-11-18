// One-time data migration: Muse original (SQLite app.db snapshot) -> the
// standalone copy's Postgres (Neon in production, PGlite locally).
//
// Usage:
//   SQLITE_PATH=../sm-life-render/app.db DATABASE_URL=pglite://./.pglite-data bun ./scripts/migrate.ts
//
// What it moves: app_plan, artist_profiles, saved_albums, saved_tracks,
// playlists, playlist_items, play_history, uploaded_books,
// uploaded_book_chapters, app_requests, playback_requests — with their
// original IDs preserved (album/track references stay intact) and the
// Postgres id sequences reset past the largest imported id.
//
// What it does NOT move: the `blobs` table stays empty on purpose. The 34
// uploaded MP3s already ship as static files under server/static/audio/
// and are served from disk by blob key, so nothing needs re-uploading.
// New uploads after the move land in the blobs table.
//
// Safety: refuses to run if the target already holds library rows, unless
// --force is passed. Reads the SQLite file read-only; the original is
// never written to.

import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { connectDb, ensureSchema } from "../server/src/platform";
import * as schema from "../server/src/schema";

// snake_case SQLite column -> camelCase Drizzle property
const camel = (s: string) =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const TABLE_OBJECTS = {
  app_plan: schema.appPlan,
  artist_profiles: schema.artistProfiles,
  saved_albums: schema.savedAlbums,
  saved_tracks: schema.savedTracks,
  playlists: schema.playlists,
  playlist_items: schema.playlistItems,
  play_history: schema.playHistory,
  uploaded_books: schema.uploadedBooks,
  uploaded_book_chapters: schema.uploadedBookChapters,
  app_requests: schema.appRequests,
  playback_requests: schema.playbackRequests,
} as const;

const SQLITE_PATH = process.env.SQLITE_PATH ?? "";
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FORCE = process.argv.includes("--force");

if (!SQLITE_PATH) {
  console.error(
    "Set SQLITE_PATH to the SQLite snapshot, e.g.\n" +
      "  SQLITE_PATH=../sm-life-render/app.db DATABASE_URL=... bun ./scripts/migrate.ts",
  );
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL (Neon string, or pglite://./.pglite-data).");
  process.exit(1);
}

type TableSpec = {
  sqlite: string;
  pg: string;
  columns: string[]; // SQLite column names, in order
  timestamps: string[]; // columns stored as epoch-ms integers in SQLite
  serial: boolean; // whether the pg id sequence needs a reset
};

const TABLES: TableSpec[] = [
  {
    sqlite: "app_plan",
    pg: "app_plan",
    columns: ["id", "tier", "updated_at"],
    timestamps: ["updated_at"],
    serial: false,
  },
  {
    sqlite: "artist_profiles",
    pg: "artist_profiles",
    columns: [
      "id",
      "name",
      "artist_key",
      "artist_id",
      "photo_url",
      "photo_blob_key",
      "background_url",
      "background_blob_key",
      "bio",
      "description",
      "genre",
      "wiki_url",
      "source",
      "created_at",
      "updated_at",
    ],
    timestamps: ["created_at", "updated_at"],
    serial: true,
  },
  {
    sqlite: "saved_albums",
    pg: "saved_albums",
    columns: [
      "id",
      "catalog_id",
      "title",
      "artist",
      "artist_id",
      "artwork_url",
      "artwork_blob_key",
      "genre",
      "release_label",
      "release_date_label",
      "label",
      "producer",
      "contributors",
      "album_info",
      "source",
      "downloaded",
      "created_at",
    ],
    timestamps: ["created_at"],
    serial: true,
  },
  {
    sqlite: "saved_tracks",
    pg: "saved_tracks",
    columns: [
      "id",
      "album_id",
      "catalog_track_id",
      "title",
      "artist",
      "track_number",
      "disc_number",
      "duration_ms",
      "preview_url",
      "artwork_url",
      "blob_key",
      "file_name",
      "created_at",
    ],
    timestamps: ["created_at"],
    serial: true,
  },
  {
    sqlite: "playlists",
    pg: "playlists",
    columns: ["id", "name", "created_at"],
    timestamps: ["created_at"],
    serial: true,
  },
  {
    sqlite: "playlist_items",
    pg: "playlist_items",
    columns: [
      "id",
      "playlist_id",
      "title",
      "artist",
      "preview_url",
      "artwork_url",
      "duration_ms",
      "blob_key",
      "saved_track_id",
      "created_at",
    ],
    timestamps: ["created_at"],
    serial: true,
  },
  {
    sqlite: "play_history",
    pg: "play_history",
    columns: ["id", "title", "artist", "artwork_url", "played_at"],
    timestamps: ["played_at"],
    serial: true,
  },
  {
    sqlite: "uploaded_books",
    pg: "uploaded_books",
    columns: ["id", "title", "author", "created_at"],
    timestamps: ["created_at"],
    serial: true,
  },
  {
    sqlite: "uploaded_book_chapters",
    pg: "uploaded_book_chapters",
    columns: [
      "id",
      "book_id",
      "title",
      "chapter_number",
      "duration_ms",
      "blob_key",
      "file_name",
      "created_at",
    ],
    timestamps: ["created_at"],
    serial: true,
  },
  {
    sqlite: "app_requests",
    pg: "app_requests",
    columns: [
      "id",
      "text",
      "status",
      "resolution_note",
      "seen_done",
      "created_at",
      "updated_at",
    ],
    timestamps: ["created_at", "updated_at"],
    serial: true,
  },
  {
    sqlite: "playback_requests",
    pg: "playback_requests",
    columns: [
      "id",
      "query",
      "title",
      "artist",
      "artwork_url",
      "preview_url",
      "fallback_preview_url",
      "duration_ms",
      "album_title",
      "saved_track_id",
      "status",
      "created_at",
      "updated_at",
    ],
    timestamps: ["created_at", "updated_at"],
    serial: true,
  },
];

const sqlite = new Database(SQLITE_PATH, { readonly: true });
const { db, close } = await connectDb(DATABASE_URL);
await ensureSchema(db);

const existing = await db.execute(
  sql`SELECT COUNT(*)::int AS n FROM saved_albums`,
);
const existingCount = (existing as unknown as { n: number }[])[0]?.n ?? 0;
if (existingCount > 0 && !FORCE) {
  console.error(
    `Target already has ${existingCount} saved album(s). Refusing to migrate\n` +
      "on top of existing data — re-run with --force only if you mean to\n" +
      "duplicate it (rows are inserted by explicit id and will conflict).",
  );
  await close();
  process.exit(1);
}

for (const t of TABLES) {
  const cols = t.columns.join(", ");
  const rows = sqlite
    .query(`SELECT ${cols} FROM ${t.sqlite} ORDER BY id`)
    .all() as Record<string, unknown>[];
  if (rows.length === 0) {
    console.log(`${t.pg}: 0 rows — skipped`);
    continue;
  }
  if (FORCE) {
    await db.execute(sql.raw(`DELETE FROM ${t.pg}`));
  }
  // Insert through the Drizzle builder (one row per statement — ~300 rows
  // total, fast enough — so timestamps and ids are typed correctly).
  const table = TABLE_OBJECTS[t.pg as keyof typeof TABLE_OBJECTS];
  for (const row of rows) {
    const values: Record<string, unknown> = {};
    for (const c of t.columns) {
      const v = row[c];
      values[camel(c)] =
        t.timestamps.includes(c) && typeof v === "number"
          ? new Date(v)
          : (v ?? null);
    }
    await db.insert(table).values(values as never);
  }
  if (t.serial) {
    await db.execute(
      sql.raw(
        `SELECT setval(pg_get_serial_sequence('${t.pg}', 'id'), (SELECT MAX(id) FROM ${t.pg}))`,
      ),
    );
  }
  console.log(`${t.pg}: ${rows.length} rows`);
}

console.log("migration complete");
await close();
