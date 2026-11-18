// Postgres port of server/src/schema.ts (original: Drizzle SQLite).
// Same table/column names, same semantics:
// - integer PK AUTOINCREMENT -> serial PK
// - integer timestamp_ms (epoch ms, returned as Date) -> timestamp (returned as Date)
// - integer 0/1 flags stay integer (no boolean rewrite, so all comparisons
//   and inserts in actions.ts work unchanged)
// - text "enums" stay plain text (validated at the action layer by Zod)
// - the one unique index (artist_profiles.artist_key) is preserved
// Plus one new table: `blobs` — bytea store for files uploaded AFTER the
// move (covers, artist photos, new tracks/chapters). The 34 tracks that
// already existed ship as static files under server/static/audio/ and are
// served from disk; only new uploads land in this table, so the app never
// depends on Render's ephemeral filesystem.

import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// NOTE: flags (downloaded, seenDone) stay integer 0/1 on purpose — no
// boolean columns — so every comparison and insert in actions.ts works
// exactly as it did against SQLite.

const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date());

export const savedAlbums = pgTable("saved_albums", {
  id: serial("id").primaryKey(),
  catalogId: text("catalog_id").notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  artistId: text("artist_id"),
  artworkUrl: text("artwork_url"),
  artworkBlobKey: text("artwork_blob_key"),
  genre: text("genre"),
  releaseLabel: text("release_label"),
  releaseDateLabel: text("release_date_label"),
  label: text("label"),
  producer: text("producer"),
  contributors: text("contributors"),
  albumInfo: text("album_info"),
  source: text("source").notNull().default("catalog"),
  downloaded: integer("downloaded").notNull().default(0),
  createdAt: createdAt(),
});

export const savedTracks = pgTable("saved_tracks", {
  id: serial("id").primaryKey(),
  albumId: integer("album_id"),
  catalogTrackId: text("catalog_track_id"),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  trackNumber: integer("track_number").notNull().default(0),
  discNumber: integer("disc_number").notNull().default(1),
  durationMs: integer("duration_ms").notNull().default(0),
  previewUrl: text("preview_url"),
  artworkUrl: text("artwork_url"),
  blobKey: text("blob_key"),
  fileName: text("file_name"),
  createdAt: createdAt(),
});

export const playlists = pgTable("playlists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const playlistItems = pgTable("playlist_items", {
  id: serial("id").primaryKey(),
  playlistId: integer("playlist_id").notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  previewUrl: text("preview_url"),
  artworkUrl: text("artwork_url"),
  durationMs: integer("duration_ms").notNull().default(0),
  blobKey: text("blob_key"),
  savedTrackId: integer("saved_track_id"),
  createdAt: createdAt(),
});

export const playHistory = pgTable("play_history", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  artworkUrl: text("artwork_url"),
  playedAt: timestamp("played_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const artistProfiles = pgTable(
  "artist_profiles",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    artistKey: text("artist_key").notNull(),
    artistId: text("artist_id"),
    photoUrl: text("photo_url"),
    photoBlobKey: text("photo_blob_key"),
    backgroundUrl: text("background_url"),
    backgroundBlobKey: text("background_blob_key"),
    bio: text("bio"),
    description: text("description"),
    genre: text("genre"),
    wikiUrl: text("wiki_url"),
    source: text("source").notNull().default("ai-created"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("artist_profiles_key").on(t.artistKey)],
);

export const appPlan = pgTable("app_plan", {
  id: integer("id").primaryKey(),
  tier: text("tier").$type<"developer" | "free" | "premium">().notNull().default("developer"),
  updatedAt: timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const uploadedBooks = pgTable("uploaded_books", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  author: text("author").notNull(),
  createdAt: createdAt(),
});

export const uploadedBookChapters = pgTable("uploaded_book_chapters", {
  id: serial("id").primaryKey(),
  bookId: integer("book_id").notNull(),
  title: text("title").notNull(),
  chapterNumber: integer("chapter_number").notNull().default(0),
  durationMs: integer("duration_ms").notNull().default(0),
  blobKey: text("blob_key"),
  fileName: text("file_name"),
  createdAt: createdAt(),
});

export const appRequests = pgTable("app_requests", {
  id: serial("id").primaryKey(),
  text: text("text").notNull(),
  status: text("status").$type<"pending" | "done">().notNull().default("pending"),
  resolutionNote: text("resolution_note"),
  seenDone: integer("seen_done").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

export const playbackRequests = pgTable("playback_requests", {
  id: serial("id").primaryKey(),
  query: text("query").notNull(),
  title: text("title").notNull(),
  artist: text("artist").notNull(),
  artworkUrl: text("artwork_url"),
  previewUrl: text("preview_url"),
  fallbackPreviewUrl: text("fallback_preview_url"),
  durationMs: integer("duration_ms").notNull().default(0),
  albumTitle: text("album_title"),
  savedTrackId: integer("saved_track_id"),
  status: text("status").$type<"pending" | "playing" | "done" | "failed">().notNull().default("pending"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date()),
});

// New in the standalone copy: bytea store for files uploaded after the
// move. Keys use the same formats as before (audio/<ts>-<rand>,
// book-chapter/<bookId>/<ts>-<rand>, album-cover/<ts>-<rand>,
// artist-photo/<ts>-<rand>, artist-background/<ts>-<rand>).
export const blobs = pgTable(
  "blobs",
  {
    key: text("key").primaryKey(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: text("data").notNull(), // base64 — bytea via raw SQL is fiddly in Drizzle; base64 text is simple and exact
    createdAt: createdAt(),
  },
  (t) => [index("blobs_created_at_idx").on(t.createdAt)],
);
