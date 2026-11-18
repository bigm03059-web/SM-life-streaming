# SM Life Streaming — standalone copy (Render free tier)

A standard deployable rebuild of SM Life Streaming, made so the app can
live at its own public address (`https://<name>.onrender.com`) instead of
only inside Muse. **This is a copy. The original in Muse (artifact
`music-streaming-app`, v61) is untouched and stays live** — nothing here
writes to it.

## What this is

- **Client:** the original React 19 app (`client/src/App.tsx`, ~10,700
  lines) with the platform SDK calls swapped for a small local shim
  (`client/src/sdk-client.ts`) that POSTs `{action, args}` to `./actions`.
- **Server:** the original Bun action handlers (`server/src/actions.ts`,
  58 actions, copied verbatim except the import line) running on a plain
  Bun HTTP server (`server/src/server.ts`). `POST /actions` dispatches
  them; `GET /audio/<key>` streams uploaded audio with Range support;
  `GET /health` is the Render health check.
- **Platform shim** (`server/src/platform.ts`) re-implements the four
  platform surfaces the actions used:
  - `ctx.db` → Postgres via Drizzle (`server/src/schema.ts`, pg port of
    the original SQLite schema; integer 0/1 flags and text enums kept
    as-is, epoch-ms timestamps become `timestamptz`).
  - `ctx.blobs` → the 34 shipped MP3s live as static files under
    `server/static/audio/` (served by key); new uploads go into a
    Postgres `blobs` table (base64).
  - `ctx.inference` → Google Gemini REST (`gemini-2.5-flash` by
    default, `GEMINI_MODEL` override). **When `GEMINI_API_KEY` is unset
    the call throws and every call site falls back to its built-in
    deterministic path** — nothing breaks, AI features just degrade.
  - `ctx.invalidateQueries` → no-op.
- **Auth:** the original app has no login. On a public URL anyone could
  read/change the library, so the standalone server requires **HTTP
  Basic auth on every route when `OWNER_PASS` is set**, and **refuses to
  start in production without `OWNER_PASS`**. The browser asks once and
  remembers it; the app itself needs no changes.

## What works the same as the original

Catalog search (iTunes/Deezer/Wikipedia), YouTube full song/video
playback inside the app (IFrame Player API), SLOWED (pitch+tempo
together, persistent), DJ crossfade, slide-up player, Video/Song toggle
(defaults Video), synced lyrics, Podcasts + Audiobooks tabs (LibriVox),
album/track/cover edit, library with the uploaded albums, dark/light
theme, album version filter, speak-to-search, Cast, scan/upload with
dedupe. Verified locally end-to-end (see DEPLOY.md).

## Locked requirements (verified in this copy — do not drop)

These four were confirmed explicitly against the original's v61
behavior and are part of the rebuild, not optional extras. All were
verified locally end-to-end where the sandbox allows (audible YouTube
playback and a real mic/voice test still need the user's phone — same
as the original's own verification notes).

### 1. Album downloads for offline listening (in-app only)
- Every album page has a **Download control**: catalog album pages
  ("Download for offline" → "Downloaded for offline") and saved
  album pages ("Download for offline" / "Downloaded — tap to
  remove"). Both call `setAlbumDownloaded`, which marks the library
  album as downloaded for offline listening inside the app.
- **Rule, same as the original:** catalog albums download for
  offline listening **inside the app only**. There is **no file
  download of catalog or YouTube content to the device** — the
  track-row "preview to device" button and the video "Download"
  button from the original were removed in this copy for exactly
  that reason.
- **The user's own uploaded full files are the only ones that can
  also download to the device.** Track rows show a "Device" button
  only for an uploaded full file (a saved track with no preview URL,
  or a playlist item backed by one). It resolves the file through
  `getTrackPlayback` / `getPlaylistItemPlayback` and saves it under
  its original filename.
- **Storage:** the download mark is a flag in Postgres
  (`saved_albums.downloaded`); audio bytes live in object storage —
  the shipped MP3s as static files in the image and new uploads in
  the Postgres `blobs` table — **never on local disk**, because
  Render's free filesystem is ephemeral and anything written there
  vanishes on restart/sleep.
- Kept deliberately (not playable media): downloading the album's
  cover art image and the lyrics as text from the album page.

### 2. Whole-album playback through YouTube, in order
- Tapping **Play on an album starts it playing through YouTube
  inside the app, track after track in correct track order** — on
  top of single-song YouTube playback. The player resolves each
  catalog track to its full song on the YouTube stage (IFrame Player
  API) and advances the queue automatically; a track with its own
  uploaded file plays that file in full instead.
- The **Video/Song toggle defaults to Video**; flipping to Song loads
  the explicit audio version (e.g. Official Audio) in the same
  player, flipping back restores the video at the same spot.

### 3. SLOWED — one button, exactly like the original
- **ONE button** (not separate tempo/pitch sliders), labelled
  SLOWED, pinned at the **bottom of the full player next to
  Crossfade** — it is **not in the mini bar**.
- **Pitch + tempo together at 0.72×**, a **persistent toggle** stored
  on the device: it stays on across tracks, restarts, and app opens
  until switched off.
- It slows **songs, 30-second preview clips, and videos** through the
  same switch (the decks pin `playbackRate = 0.72` with
  `preservesPitch = false`; the app's own video element does the
  same).
- **Known limit, carried over honestly:** on full YouTube IFrame
  videos only the tempo can drop — YouTube's player only offers
  fixed rates, so the stage picks the available rate closest to
  0.72×, which is **0.75×**, and YouTube pitch-corrects (pitch is
  locked by YouTube, no app can change it). Pitch + tempo together
  at 0.72× works in the app's own player (uploads and preview
  clips).

### 4. Scan (Library → Upload)
- **"Scan SD card" buttons in Library → Upload** scan device music
  folders: the user picks the Music folder once, the scan walks
  every subfolder, adds every album and song, files each album
  under the right artist's profile (creating the profile if new),
  and **skips anything already in the library** (dedupe). The
  remembered folder can be re-scanned with one tap.
- **Honest limit, same as the original:** the rebuild **cannot steer
  the device's own file picker**. On the user's KeenPlus player the
  picker opens to Recents and the Music folder shows no "Use this
  folder" button — only one-by-one picks work there, so the scan has
  the same picker behavior on that player as the original does. The
  app says this plainly on the Upload page, with the Select-all
  workaround written out.

## What is different on this copy

- **Ask Tiana does NOT work here** — there is no bridge back to Muse.
  The request box is replaced with a plain note saying so; the four
  already-finished requests show as read-only history with their
  "Updated" notes. Nothing is faked. Send new app changes in Muse.
- **AI features need a Gemini key** (free tier, no card — see
  DEPLOY.md). Without it: producer credits stay blank, artist-name
  cleaning and album-folder naming use filename parsing, hum-to-search
  falls back to a description search. The hum button was already
  removed from Home in the original, so nothing visible disappears.
- **Free-tier limits:** the Render service sleeps after 15 minutes with
  no traffic and takes about a minute to wake. The database is Neon
  (free, permanent, no card) — **not** Render's free Postgres, which
  deletes all its data after 30 days.

## Local development

```sh
bun install
bun run typecheck   # tsc, client + server
bun run build       # server bundle + client bundle
# Local test DB (in-process Postgres, no Neon needed):
SQLITE_PATH=../sm-life-render/app.db DATABASE_URL=pglite://./.pglite-data bun ./scripts/migrate.ts
DATABASE_URL=pglite://./.pglite-data OWNER_USER=owner OWNER_PASS=secret bun ./server/src/server.ts
```

`bun run start` runs the built server (`server/dist/server.js`); it
needs a real `DATABASE_URL` (Neon) or `pglite://` for a test DB.

## Deploy

See [DEPLOY.md](./DEPLOY.md) for the exact steps (GitHub → Neon →
Render → one-time migration → verify).

## Files

| Path | What it is |
| --- | --- |
| `server/src/actions.ts` | Original 58 actions, import swapped to `./platform` |
| `server/src/platform.ts` | SDK shim: defineAction, ctx.db/blobs/inference, connectDb, schema DDL |
| `server/src/schema.ts` | Drizzle `pgTable` port of the original schema |
| `server/src/server.ts` | Bun HTTP server: `/actions`, `/audio/<key>`, `/health`, static client |
| `server/static/audio/` | The 34 uploaded MP3s, named by blob key |
| `client/src/sdk-client.ts` | `createActionClient` + QueryClient defaults, posting to `./actions` |
| `client/build.mjs` | Client bundler (Bun.build + Tailwind), mirrors the original build |
| `scripts/migrate.ts` | One-time migration: SQLite snapshot → Postgres |
| `Dockerfile`, `render.yaml` | Render free-tier Docker web service + Blueprint |
| `.env.example` | Every env var, with notes |
