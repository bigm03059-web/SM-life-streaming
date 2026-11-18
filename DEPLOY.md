# Deploying the SM Life Streaming copy to Render (free tier)

No card is needed for any of these steps. **If any step asks for a card,
stop and report it — that ends the no-card path.** Nothing here touches
the original app in Muse; it stays live at v61 either way.

## 0. What you need first (all yours — the assistant never creates
## accounts or agrees to terms on your behalf)

1. **A GitHub account** (free). If you don't have one, create it at
   github.com — your own email, your own password. Render deploys from
   GitHub, so without this the deploy cannot happen.
2. **A Neon account** (free, no card). Sign up at neon.tech with your
   email. Create a project (any name, e.g. `sm-life`), then copy its
   connection string — it looks like
   `postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`.
   **That string is a password — treat it like one.** Don't post it in a
   public place; share it with the assistant only for the one-time
   migration run in step 4, and never save it in a file.
3. **A Render account** (free, no card for signup). Yours already exists
   under bigm03059@gmail.com.
4. *(Optional)* **A Gemini API key** (free tier, no card) from Google AI
   Studio, under your Google account. Only needed if you want the AI
   features (producer credits, smarter album naming) switched on. The
   app works without it — see README.md.

## 1. Put the code on GitHub

From this folder (`~/workspace/sm-life-render-app/`):

```sh
git init
git add .
git commit -m "SM Life Streaming — standalone copy for Render free tier"
git branch -M main
git remote add origin https://github.com/<your-username>/sm-life-streaming.git
git push -u origin main
```

Create the repo first on github.com (private is fine — Render can read
private repos once you connect GitHub).

## 2. Create the Render service

1. In Render: **New → Blueprint**, connect the GitHub repo. Render reads
   `render.yaml` and creates a free Docker web service named
   `sm-life-streaming`.
2. When it asks for environment variables, set:
   - `DATABASE_URL` — the Neon connection string from step 0.2.
   - `OWNER_PASS` — Render generates a random one; read it in the
     dashboard (Environment tab) and keep it somewhere safe. It is the
     password the app asks for when it opens.
   - `GEMINI_API_KEY` — only if you made one in step 0.4.
   - `OWNER_USER` is already `owner` in the Blueprint.
3. Deploy. First build takes a few minutes (Bun install + client build).

**If Render asks for a credit card while creating the web service, STOP
and report it.** (Sources conflict on this: some say a card is required
even on the free tier, some say it isn't. It can only be settled by
trying.)

## 3. Run the one-time data migration

This copies the library from the Muse original into Neon: 3 albums,
35 tracks, 239 play-history rows, 2 artist profiles, the plan row, and
the 4 finished Ask Tiana requests. The 34 MP3s do **not** need moving —
they already ship inside the app under `server/static/audio/`.

The SQLite snapshot lives on the assistant's machine, so the assistant
runs this step (it needs the Neon `DATABASE_URL` for this one command
only):

```sh
SQLITE_PATH=../sm-life-render/app.db DATABASE_URL='<neon connection string>' bun ./scripts/migrate.ts
```

Expected output: `app_plan: 1 rows`, `artist_profiles: 2 rows`,
`saved_albums: 3 rows`, `saved_tracks: 35 rows`,
`play_history: 239 rows`, `app_requests: 4 rows`, `migration complete`.

The script refuses to run twice on a target that already has albums
(unless `--force` is passed), and reads the SQLite file read-only — the
original is never written to.

## 4. Verify on the live URL

Open `https://sm-life-streaming.onrender.com` (or whatever name Render
gave it). The browser asks for the owner login once (`owner` + the
`OWNER_PASS` from step 2). Then check, in order:

1. Library shows 3 albums: **400 Degreez** (Juvenile, 16 tracks),
   **Too Hot For T.V** (Bad Boy's Da Band, 18 tracks), **LET 'EM KNOW -
   Single** (T.I., 1 track).
2. Open 400 Degreez — tap Play on track 1, it plays the uploaded file.
3. Search "Lil Baby" — results come back; open an album, tap Play —
   the whole album plays through YouTube inside the app, track after
   track in correct order, Video/Song toggle defaulting to Video.
4. Open a track's full player — Video/Song toggle is there, defaults
   to Video; SLOWED + Crossfade sit together at the bottom of the full
   player; SLOWED stays on across tracks.
5. Podcasts tab — search "The Daily", an episode plays with resume.
   Audiobooks tab — "Secret Garden" shows 27 chapters.
6. Upload a small test track (Library → Upload) — it appears in the
   library and plays. (Delete it after, or keep it — it's your copy.)
7. **Download control:** on a catalog album page, tap "Download for
   offline" — it flips to "Downloaded for offline" and the album
   shows in the Library's Downloaded section. On a saved album page
   the same button toggles it back off. On an uploaded track's row,
   a "Device" button downloads that file to the device; on a
   catalog track's row there is **no** device-download button, and
   videos have none either — catalog/YouTube content stays in-app.
8. **SLOWED check:** turn SLOWED on in the full player, play a song,
   a preview clip, and a video — all slow down; flip to the next
   track and it is still slowed; close and reopen the app and it is
   still on until switched off. On a full YouTube video the slowdown
   is tempo-only (0.75×, pitch locked by YouTube) — that is the
   known limit, not a bug.
9. **Scan check:** Library → Upload shows "Scan SD card". The
   button opens the device's own file picker — on the KeenPlus it
   opens to Recents and the Music folder offers no "Use this
   folder", same as the original; the page itself says so and gives
   the Select-all workaround.
10. Ask Tiana box — shows the plain note that this copy isn't
    connected to Tiana, plus the 4 finished requests as history.
    **Do not expect new requests sent here to reach Tiana — they
    can't.**

Note the first open after 15 minutes idle takes about a minute: the
free service was asleep and is waking up. That is the free tier, not a
bug.

## 5. Keep-alive (set up as soon as the URL exists)

The free Render service sleeps after 15 minutes with no traffic, so
as soon as this deploy produces its public address, the assistant
sets up a keep-alive check that **pings the address every 10
minutes** so it does not fall asleep. The exact public URL goes in
the deploy report the moment it exists — the keep-alive cannot be
set up before that, because there is no address to ping yet.

## 6. If it gives problems

The Render copy can be deleted any time (Render dashboard → service →
Settings → Delete) and the Muse original is untouched — your songs and
everything stay right where they are in Muse. Tell the assistant what
went wrong before deleting, so the fix can go into the code first.

## What was NOT done here

- **No APK.** Wrapping the Render address into an APK is a separate
  later job; the user already knows a site that makes an APK from a
  pasted address link.
- **No Render free Postgres.** It deletes all data after 30 days, so
  Neon is the database.
- **No accounts created, no terms agreed, no card entered** by the
  assistant. Every signup above is the user's own.
