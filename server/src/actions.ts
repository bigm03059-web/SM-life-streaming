// Actions for SM Life Streaming.
// Catalog data (search, albums, artists, videos, covers, previews) is fetched
// live from the iTunes Search API, the Deezer API, and Wikipedia — no keys.
// The user's own library (saved/downloaded albums, uploaded full tracks,
// playlists, history) lives in ctx.db + ctx.blobs.

import {
  defineAction,
  z,
  type ActionsModule,
  type Ctx,
} from "./platform";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------- shared output shapes ----------

// Version of a song/album as the source itself labels it: "explicit" is
// the uncensored rendition, "clean" is the edited/cleaned rendition of a
// song that also exists explicit, "none" means the source lists no
// explicit content (an ordinary song, not a censored edit).
const explicitnessOut = z.enum(["explicit", "clean", "none"]);
type Explicitness = z.infer<typeof explicitnessOut>;

const albumOut = z.object({
  catalogId: z.string(),
  title: z.string(),
  artist: z.string(),
  artistId: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  genre: z.string().nullable(),
  releaseLabel: z.string().nullable(),
  // The release date in ISO form ("2026-11-06" or an ISO datetime) so
  // album lists can be ordered newest first; null when the source
  // lists no date. releaseLabel stays the human "November 2026".
  releaseDateIso: z.string().nullable(),
  trackCount: z.number(),
  explicitness: explicitnessOut,
});
type AlbumOut = z.infer<typeof albumOut>;

// One catalog edition of an album, carrying its version name for the
// album page's version filter: Original / Deluxe / Explicit / Clean —
// combined when an edition is more than one of those ("Deluxe ·
// Explicit"). Each edition is its own catalog album with its own
// tracklist, so picking a version downloads just that version.
const editionOut = albumOut.extend({ versionLabel: z.string() });
type EditionOut = z.infer<typeof editionOut>;

const trackOut = z.object({
  title: z.string(),
  artist: z.string(),
  artistId: z.string().nullable(),
  albumTitle: z.string(),
  albumId: z.string().nullable(),
  artworkUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  fallbackPreviewUrl: z.string().nullable(),
  durationMs: z.number(),
  trackNumber: z.number(),
  // Which disc of the album this track sits on (iTunes discNumber /
  // Deezer disk_number; 1 when the source lists no discs). Track numbers
  // restart at 1 on each disc, so album pages group by this field:
  // Disc 1's tracklist first, then Disc 2 right under it.
  discNumber: z.number(),
  genre: z.string().nullable(),
  releaseLabel: z.string().nullable(),
  explicitness: explicitnessOut,
});
type TrackOut = z.infer<typeof trackOut>;

const videoOut = z.object({
  title: z.string(),
  artist: z.string(),
  artworkUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  pageUrl: z.string().nullable(),
  releaseLabel: z.string().nullable(),
  durationMs: z.number(),
});
type VideoOut = z.infer<typeof videoOut>;

const artistOut = z.object({
  name: z.string(),
  artistId: z.string().nullable(),
  genre: z.string().nullable(),
  artworkUrl: z.string().nullable(),
});

// ---------- helpers ----------

const UA = { "User-Agent": "MuseMusicApp/1.0 (personal streaming library)" };

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function monthYear(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Full release date for album pages — day next to month and year
// ("September 23, 2003") — from the catalog's own releaseDate /
// release_date. Null when the source gives no usable date; album pages
// then fall back to the month-year label.
function fullDate(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function bigArt(url: string | undefined | null): string | null {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb\.jpg$/, "/600x600bb.jpg");
}

type Raw = Record<string, unknown>;
function resultsOf(json: Record<string, unknown> | null): Raw[] {
  const r = json?.["results"];
  return Array.isArray(r) ? (r as Raw[]) : [];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// iTunes labels renditions "explicit" / "cleaned" / "notExplicit";
// Deezer flags explicit_lyrics true/false. Map both onto our enum.
function itunesExplicitness(v: unknown): Explicitness {
  if (v === "explicit") return "explicit";
  if (v === "cleaned") return "clean";
  return "none";
}

function toAlbum(r: Raw): AlbumOut {
  return {
    catalogId: String(r["collectionId"] ?? r["id"] ?? ""),
    title: str(r["collectionName"] ?? r["title"]),
    artist: str(r["artistName"] ?? r["artist"]),
    artistId:
      r["artistId"] != null ? String(r["artistId"]) : null,
    artworkUrl: bigArt(strOrNull(r["artworkUrl100"]) ?? strOrNull(r["cover_xl"])),
    genre: strOrNull(r["primaryGenreName"]),
    releaseLabel: monthYear(strOrNull(r["releaseDate"] ?? r["release_date"])),
    releaseDateIso: strOrNull(r["releaseDate"] ?? r["release_date"]),
    trackCount: num(r["trackCount"] ?? r["nb_tracks"]),
    explicitness: itunesExplicitness(r["collectionExplicitness"]),
  };
}

// A Deezer album (search result or artist-discography row) as an
// AlbumOut. Deezer-only releases — albums iTunes doesn't carry at all,
// like Lil Baby's FRESH (Deezer album 1134254181, November 6, 2026) —
// reach the app's search results and artist profiles only through
// this mapping; the "dz-" catalogId prefix routes their album pages
// to resolveDeezerAlbum, which reads the real tracklist and previews
// from Deezer. Deezer's album SEARCH rows carry no release_date, so
// callers that need dates fill them from the album detail (see
// enrichDeezerAlbumDates); the artist-discography rows do carry one.
function toDeezerAlbum(r: Raw): AlbumOut {
  const artist = r["artist"] as Raw | undefined;
  return {
    catalogId: r["id"] != null ? `dz-${String(r["id"])}` : "",
    title: str(r["title"]),
    artist: str(artist?.["name"] ?? r["artist"]),
    artistId: artist?.["id"] != null ? String(artist["id"]) : null,
    artworkUrl: strOrNull(r["cover_xl"]) ?? strOrNull(r["cover_big"]),
    genre: null,
    releaseLabel: monthYear(strOrNull(r["release_date"])),
    releaseDateIso: strOrNull(r["release_date"]),
    trackCount: num(r["nb_tracks"]),
    explicitness:
      r["explicit_lyrics"] === true ? ("explicit" as const) : ("none" as const),
  };
}

// Deezer's own album search — the second catalog album search runs
// alongside iTunes, so an album that exists only on Deezer still
// shows up when the user searches its title or its artist.
async function deezerAlbumSearch(
  query: string,
  limit = 15,
): Promise<AlbumOut[]> {
  const json = await fetchJson(
    `https://api.deezer.com/search/album?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  const data = json?.["data"];
  if (!Array.isArray(data)) return [];
  return (data as Raw[])
    .map(toDeezerAlbum)
    .filter((a) => a.title && a.catalogId);
}

// Fill release dates (and track counts) onto Deezer albums whose
// search rows didn't carry them, from each album's own Deezer detail
// — capped, in parallel, failures keep the null (the album still
// lists; it just sorts with the undated ones).
async function enrichDeezerAlbumDates(
  albums: AlbumOut[],
  cap = 10,
): Promise<void> {
  const need = albums
    .filter(
      (a) =>
        a.catalogId.startsWith("dz-") && (!a.releaseDateIso || !a.trackCount),
    )
    .slice(0, cap);
  await Promise.all(
    need.map(async (a) => {
      const detail = await fetchJson(
        `https://api.deezer.com/album/${encodeURIComponent(a.catalogId.slice(3))}`,
      ).catch(() => null);
      if (!detail) return;
      a.releaseDateIso = strOrNull(detail["release_date"]);
      a.releaseLabel = monthYear(a.releaseDateIso);
      if (!a.trackCount) a.trackCount = num(detail["nb_tracks"]);
    }),
  );
}

// The artist's full Deezer discography, newest releases included —
// the profile merge that puts Deezer-only albums (FRESH and its
// bonus-track edition) on the artist's page. The artist is picked by
// name match with the most fans, the same rule deezerArtistTopInfo
// uses (a same-named minor artist can sit ahead of the real one).
async function deezerArtistAlbums(name: string): Promise<AlbumOut[]> {
  const json = await fetchJson(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`,
  );
  const data = json?.["data"];
  if (!Array.isArray(data)) return [];
  let bestId: string | null = null;
  let bestName = name;
  let bestFans = -1;
  for (const r of data as Raw[]) {
    const cand = str(r["name"]);
    if (cand && artistsMatch(cand, name)) {
      const fans = num(r["nb_fan"]);
      if (fans > bestFans) {
        bestFans = fans;
        bestId = r["id"] != null ? String(r["id"]) : null;
        bestName = cand;
      }
    }
  }
  if (!bestId) return [];
  const list = await fetchJson(
    `https://api.deezer.com/artist/${encodeURIComponent(bestId)}/albums?limit=100`,
  );
  const rows = list?.["data"];
  if (!Array.isArray(rows)) return [];
  // The discography rows carry no artist object of their own (the
  // artist is the endpoint's owner) and no track count — stamp the
  // artist we resolved onto each row so titles dedupe and display
  // like every other album; counts are filled by the caller.
  return (rows as Raw[])
    .map((r) =>
      toDeezerAlbum({
        ...r,
        artist: (r["artist"] as Raw | undefined) ?? {
          id: bestId,
          name: bestName,
        },
      }),
    )
    .filter((a) => a.title && a.catalogId);
}

// Album lists run newest first: the release date decides, so this
// year's albums sit at the top. ISO dates compare lexicographically
// (iTunes datetimes and Deezer dates share the YYYY-MM-DD prefix);
// albums with no known date keep their relative order at the end.
// Stable — equal dates keep the order the caller ranked them in.
function sortAlbumsNewestFirst(albums: AlbumOut[]): AlbumOut[] {
  return albums
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const dx = x.a.releaseDateIso ?? "";
      const dy = y.a.releaseDateIso ?? "";
      if (dx !== dy) return dx > dy ? -1 : 1;
      return x.i - y.i;
    })
    .map((x) => x.a);
}

function toTrack(r: Raw): TrackOut {
  return {
    title: str(r["trackName"] ?? r["title"]),
    artist: str(r["artistName"] ?? r["artist"]),
    artistId: r["artistId"] != null ? String(r["artistId"]) : null,
    albumTitle: str(r["collectionName"] ?? r["albumTitle"]),
    albumId: r["collectionId"] != null ? String(r["collectionId"]) : null,
    artworkUrl: bigArt(strOrNull(r["artworkUrl100"])),
    previewUrl: strOrNull(r["previewUrl"] ?? r["preview"]),
    fallbackPreviewUrl: null,
    durationMs: num(r["trackTimeMillis"]),
    trackNumber: num(r["trackNumber"]),
    discNumber: num(r["discNumber"]) || 1,
    genre: strOrNull(r["primaryGenreName"]),
    releaseLabel: monthYear(strOrNull(r["releaseDate"])),
    explicitness: itunesExplicitness(r["trackExplicitness"]),
  };
}

function toVideo(r: Raw): VideoOut {
  return {
    title: str(r["trackName"]),
    artist: str(r["artistName"]),
    artworkUrl: bigArt(strOrNull(r["artworkUrl100"])),
    previewUrl: strOrNull(r["previewUrl"]),
    pageUrl: strOrNull(r["trackViewUrl"]),
    releaseLabel: monthYear(strOrNull(r["releaseDate"])),
    durationMs: num(r["trackTimeMillis"]),
  };
}

async function itunes(
  path: string,
): Promise<Record<string, unknown> | null> {
  return fetchJson(`https://itunes.apple.com/${path}`);
}

// One LibriVox book from the public feed (extended=1): author comes
// from the authors list ("First Last"), total length from
// totaltimesecs, chapters from num_sections. LibriVox carries no
// cover art in the feed, so artworkUrl stays null — never invented.
type LibrivoxBook = {
  source: "librivox";
  id: string;
  title: string;
  author: string;
  artworkUrl: string | null;
  durationMs: number;
  chapterCount: number | null;
  description: string | null;
  previewUrl: string | null;
};

function parseLibrivoxBooks(
  json: Record<string, unknown> | null,
): LibrivoxBook[] {
  const rows = (json?.["books"] ?? []) as Record<string, unknown>[];
  return rows
    .map((b) => {
      const authors = (b["authors"] ?? []) as Record<string, unknown>[];
      const author = authors
        .map((a) =>
          `${str(a["first_name"])} ${str(a["last_name"])}`.trim(),
        )
        .filter(Boolean)
        .join(", ");
      const descRaw = strOrNull(b["description"]);
      const description = descRaw
        ? descRaw.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 400) ||
          null
        : null;
      return {
        source: "librivox" as const,
        id: b["id"] != null ? String(b["id"]) : "",
        title: str(b["title"]),
        author,
        artworkUrl: null,
        durationMs:
          (typeof b["totaltimesecs"] === "number"
            ? b["totaltimesecs"]
            : Number(b["totaltimesecs"]) || 0) * 1000,
        chapterCount:
          typeof b["num_sections"] === "number"
            ? b["num_sections"]
            : Number(b["num_sections"]) || null,
        description,
        previewUrl: null,
      };
    })
    .filter((b) => b.id && b.title);
}

// ---------- catalog album resolution ----------
// Album lists come from two catalogs whose numeric IDs live in different
// namespaces: search / artist / spotlight albums carry iTunes collection
// IDs, while the Home feed's trending albums come from the Deezer chart
// and carry Deezer album IDs (minted with a "dz-" prefix). An iTunes
// lookup with a Deezer ID returns no rows at all — the album page used
// to render with a blank title and an empty tracklist. resolveCatalogAlbum
// handles both: iTunes IDs go through the iTunes lookup as before, and
// "dz-" IDs — plus any bare ID the iTunes lookup doesn't know — resolve
// against Deezer's own album + tracklist endpoints, whose tracks carry
// Deezer's playable 30-second previews.
type ResolvedAlbum = {
  album: AlbumOut & { label: string | null; copyright: string | null };
  tracks: TrackOut[];
  contributors: string[];
  // The catalog's raw release date (day precision) for album pages;
  // the album's releaseLabel stays month-year for cards and lists.
  releaseDateIso: string | null;
};

async function resolveDeezerAlbum(
  dzId: string,
  catalogId: string,
): Promise<ResolvedAlbum | null> {
  const detail = await fetchJson(
    `https://api.deezer.com/album/${encodeURIComponent(dzId)}`,
  );
  if (!detail || detail["error"]) return null;
  const title = str(detail["title"]);
  if (!title) return null;
  const artistObj = detail["artist"] as Raw | undefined;
  const artist = str(artistObj?.["name"]);
  const cover =
    strOrNull(detail["cover_xl"]) ?? strOrNull(detail["cover_big"]);
  const genres = detail["genres"] as Raw | undefined;
  const genreData = genres?.["data"];
  const genre = Array.isArray(genreData)
    ? strOrNull((genreData[0] as Raw | undefined)?.["name"])
    : null;
  const releaseLabel = monthYear(strOrNull(detail["release_date"]));
  const contributorsRaw = detail["contributors"];
  const contributors = Array.isArray(contributorsRaw)
    ? contributorsRaw.map((c) => str((c as Raw)["name"])).filter(Boolean)
    : [];
  const tracksJson = await fetchJson(
    `https://api.deezer.com/album/${encodeURIComponent(dzId)}/tracks?limit=100`,
  );
  const embedded = (detail["tracks"] as Raw | undefined)?.["data"];
  const listed = tracksJson?.["data"];
  const rowsRaw = Array.isArray(listed) ? listed : embedded;
  const rows = Array.isArray(rowsRaw) ? (rowsRaw as Raw[]) : [];
  const tracks: TrackOut[] = rows
    .map((r, i) => {
      const ta = r["artist"] as Raw | undefined;
      return {
        title: str(r["title"] ?? r["title_short"]),
        artist: str(ta?.["name"]) || artist,
        artistId: ta?.["id"] != null ? String(ta["id"]) : null,
        albumTitle: title,
        albumId: catalogId,
        artworkUrl: cover,
        previewUrl: strOrNull(r["preview"]),
        fallbackPreviewUrl: null,
        durationMs: num(r["duration"]) * 1000,
        trackNumber: num(r["track_position"]) || i + 1,
        discNumber: num(r["disk_number"]) || 1,
        genre,
        releaseLabel,
        explicitness:
          r["explicit_lyrics"] === true
            ? ("explicit" as const)
            : ("none" as const),
      };
    })
    .filter((t) => t.title)
    // Disc 1's whole tracklist first, then Disc 2 right under it —
    // track_position restarts at 1 on each disc, so sort disc-major.
    .sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
  return {
    album: {
      catalogId,
      title,
      artist,
      artistId: artistObj?.["id"] != null ? String(artistObj["id"]) : null,
      artworkUrl: cover,
      genre,
      releaseLabel,
      releaseDateIso: strOrNull(detail["release_date"]),
      trackCount: num(detail["nb_tracks"]) || tracks.length,
      explicitness:
        detail["explicit_lyrics"] === true
          ? ("explicit" as const)
          : ("none" as const),
      label: strOrNull(detail["label"]),
      copyright: null,
    },
    tracks,
    contributors,
    releaseDateIso: strOrNull(detail["release_date"]),
  };
}

async function resolveCatalogAlbum(
  catalogId: string,
): Promise<ResolvedAlbum | null> {
  if (catalogId.startsWith("dz-")) {
    return resolveDeezerAlbum(catalogId.slice(3), catalogId);
  }
  const lookup = await itunes(
    `lookup?id=${encodeURIComponent(catalogId)}&entity=song&country=US`,
  );
  const rows = resultsOf(lookup);
  const albumRow = rows.find((r) => r["wrapperType"] === "collection");
  const trackRows = rows
    .filter((r) => r["kind"] === "song")
    // Disc-major order: all of Disc 1, then Disc 2 right under it.
    // iTunes trackNumber restarts at 1 on each disc.
    .sort(
      (a, b) =>
        (num(a["discNumber"]) || 1) - (num(b["discNumber"]) || 1) ||
        num(a["trackNumber"]) - num(b["trackNumber"]),
    );
  if (!albumRow && trackRows.length === 0) {
    // Not an iTunes collection ID — it may be a bare Deezer album ID
    // from a list minted before the "dz-" prefix existed.
    return resolveDeezerAlbum(catalogId, catalogId);
  }
  let album: AlbumOut & { label: string | null; copyright: string | null } = {
    catalogId,
    title: "",
    artist: "",
    artistId: null,
    artworkUrl: null,
    genre: null,
    releaseLabel: null,
    releaseDateIso: null,
    trackCount: 0,
    explicitness: "none" as const,
    label: null,
    copyright: null,
  };
  if (albumRow) {
    const base = toAlbum(albumRow);
    album = { ...base, label: null, copyright: strOrNull(albumRow["copyright"]) };
  } else if (trackRows[0]) {
    const t = toTrack(trackRows[0]);
    album = {
      ...album,
      title: t.albumTitle,
      artist: t.artist,
      artistId: t.artistId,
      artworkUrl: t.artworkUrl,
      genre: t.genre,
      releaseLabel: t.releaseLabel,
      releaseDateIso: strOrNull(trackRows[0]["releaseDate"]),
      trackCount: trackRows.length,
    };
  }
  return {
    album,
    tracks: trackRows.map(toTrack),
    contributors: [],
    releaseDateIso: albumRow
      ? strOrNull(albumRow["releaseDate"])
      : trackRows[0]
        ? strOrNull(trackRows[0]["releaseDate"])
        : null,
  };
}

// Normalized title key so the same song matches across catalogs even when
// one writes "Ruff Ryders' Anthem" and the other "Ruff Ryders Anthem", or
// one appends "(Up in Here)".
function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Base key for "the same album" across its editions: normTitle already
// strips "(Deluxe Edition)"-style parentheticals; this also drops
// trailing edition words a title carries bare ("… Deluxe Edition",
// "… Remastered"). Two catalog albums with the same base key and the
// same artist are editions of one album.
function albumBaseKey(title: string): string {
  return normTitle(title)
    .replace(
      /(\s+(deluxe|expanded|special|bonus|platinum|anniversary|remastered|explicit|clean)(\s+edition)?|\s+edition|\s+version)+$/,
      "",
    )
    .trim();
}

// The version name an edition goes by in the album page's version
// filter, from the catalog's own signals only: "Deluxe" in the title,
// and the catalog's explicit/clean label. An edition with neither is
// the Original.
function versionLabelOf(a: AlbumOut): string {
  const parts: string[] = [];
  if (/\bdeluxe\b/i.test(a.title)) parts.push("Deluxe");
  if (a.explicitness === "explicit") parts.push("Explicit");
  else if (a.explicitness === "clean") parts.push("Clean");
  return parts.length > 0 ? parts.join(" · ") : "Original";
}

// Normalized artist key for filing uploaded albums to an artist profile.
// Strips feat./ft. tails, punctuation and case so "DMX", "dmx" and
// "DMX feat. Swizz Beatz" (main artist) resolve to the same profile.
// A run of single-letter tokens is merged into one token: dotted
// initials are the same artist with or without the dots — "T.I."
// tokenizes to "t i" while a typed/spoken "TI" tokenizes to "ti", and
// before this merge the two keys never matched, so every album was
// filtered off T.I.'s profile (opened as "TI") and the canonical-ID
// fallback never fired. The merge also covers "B.o.B" → "bob" style
// names. A lone single letter ("A Tribe Called Quest") is untouched.
function artistKey(s: string): string {
  const spaced = s
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/)[0]!
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!spaced) return spaced;
  const tokens = spaced.split(" ");
  const merged: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length >= 2) merged.push(run.join(""));
    else merged.push(...run);
    run = [];
  };
  for (const t of tokens) {
    if (t.length === 1) {
      run.push(t);
    } else {
      flush();
      merged.push(t);
    }
  }
  flush();
  return merged.join(" ");
}

function artistsMatch(a: string, b: string): boolean {
  const ka = artistKey(a);
  const kb = artistKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  // "Lil Wayne" vs "Wayne" style partials: one key fully contains the other
  // only counts when the shorter side is at least 3 chars, to avoid noise.
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return shorter.length >= 3 && longer.includes(shorter);
}

// Look up the canonical catalog artist for a name the user typed. Returns
// the catalog's own spelling + id when there's a confident match, else null.
async function catalogArtistFor(
  name: string,
): Promise<{ name: string; artistId: string } | null> {
  const json = await itunes(
    `search?term=${encodeURIComponent(name)}&media=music&entity=musicArtist&limit=8&country=US`,
  );
  const rows = resultsOf(json);
  for (const r of rows) {
    const cand = str(r["artistName"]);
    if (cand && artistsMatch(cand, name)) {
      return {
        name: cand,
        artistId: r["artistId"] != null ? String(r["artistId"]) : "",
      };
    }
  }
  return null;
}

// Version key for matching the SAME rendition of the SAME song across
// catalogs: normalized base title + artist + any variant words from the
// title's parentheses (remix, karaoke, sped up…). A subtitle like
// "(Up in Here)" is not a variant — the same song — but "(Trap Remix)"
// is a different rendition and must never borrow another version's
// preview. Artist-scoping matters too: Hilary Duff's "Party Up" is not
// DMX's "Party Up".
const VARIANT_WORDS = [
  "remix",
  "karaoke",
  "instrumental",
  "sped",
  "slowed",
  "reverb",
  "live",
  "acoustic",
  "dubstep",
  "cover",
  "remaster",
  "recorded",
];
// The primary artist only, for cross-catalog version matching: iTunes
// credits a collab as "Lil Baby & Gunna" / "Lil Baby & Drake" while
// Deezer credits the same recording to "Lil Baby" alone, so keying on
// the full credit string made the two catalogs' renditions of the same
// song never match (Drip Too Hard / Yes Indeed showed clean-only).
// Primary-artist scoping keeps the cross-artist protection: a different
// lead artist still produces a different key.
function primaryArtistKey(artist: string): string {
  const main =
    artist.split(/&|,|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/i)[0] ?? "";
  return artistKey(main);
}

function versionKey(title: string, artist: string): string {
  const parens = [...title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]/g)]
    .map((m) => (m[1] ?? m[2] ?? "").toLowerCase())
    .join(" ");
  const variants = VARIANT_WORDS.filter((w) => parens.includes(w)).sort();
  return `${normTitle(title)}|${primaryArtistKey(artist)}|${variants.join(",")}`;
}

// ---------- library duplicate prevention ----------
// One album, one copy in the library — no matter which door it came
// through (upload, device scan, share import, AI fill, or a catalog /
// YouTube save). Every path that adds an album checks title + artist
// against the library FIRST, with this key: the album's base title
// (edition words stripped, so "400 Degreez" matches however it was
// spelled) plus the primary artist. When a copy is already there, the
// add returns that copy instead of creating a second one. The copy
// carrying the user's own uploaded full files always wins over a
// preview/imported copy: an upload replaces a preview copy of the
// same album, and nothing ever replaces or duplicates the full-file
// copy. (This is the 400 Degreez fix: Juvenile's album landed twice —
// once as the user's uploaded full version, once as an imported
// preview version.)
function libraryAlbumKey(title: string, artist: string): string {
  return `${albumBaseKey(title)}|${primaryArtistKey(artist)}`;
}

type SavedAlbumRow = typeof schema.savedAlbums.$inferSelect;

async function libraryAlbumMatches(
  ctx: Ctx,
  title: string,
  artist: string,
): Promise<SavedAlbumRow[]> {
  const db = ctx.db<typeof schema>();
  const key = libraryAlbumKey(title, artist);
  const all = await db.select().from(schema.savedAlbums);
  return all.filter((a) => libraryAlbumKey(a.title, a.artist) === key);
}

async function albumHasFullFiles(ctx: Ctx, albumId: number): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const tracks = await db
    .select()
    .from(schema.savedTracks)
    .where(eq(schema.savedTracks.albumId, albumId));
  return tracks.some((t) => t.blobKey != null);
}

// The copy to keep among same-album matches: the one with the user's
// full files when there is one, otherwise the earliest copy.
async function preferredLibraryCopy(
  ctx: Ctx,
  matches: SavedAlbumRow[],
): Promise<SavedAlbumRow | null> {
  let best: SavedAlbumRow | null = null;
  for (const m of matches) {
    if (!best) {
      best = m;
      continue;
    }
    const mFull = await albumHasFullFiles(ctx, m.id);
    if (mFull && !(await albumHasFullFiles(ctx, best.id))) best = m;
  }
  return best;
}

async function deleteLibraryAlbum(ctx: Ctx, albumId: number): Promise<void> {
  const db = ctx.db<typeof schema>();
  const tracks = await db
    .select()
    .from(schema.savedTracks)
    .where(eq(schema.savedTracks.albumId, albumId));
  for (const t of tracks) {
    if (t.blobKey) {
      try {
        await ctx.blobs.delete(t.blobKey);
      } catch {
        // blob already gone; row removal still proceeds
      }
    }
  }
  const albumRows = await db
    .select()
    .from(schema.savedAlbums)
    .where(eq(schema.savedAlbums.id, albumId));
  const artKey = albumRows[0]?.artworkBlobKey;
  if (artKey) {
    try {
      await ctx.blobs.delete(artKey);
    } catch {
      // blob already gone; row removal still proceeds
    }
  }
  await db
    .delete(schema.savedTracks)
    .where(eq(schema.savedTracks.albumId, albumId));
  await db
    .delete(schema.savedAlbums)
    .where(eq(schema.savedAlbums.id, albumId));
}

// Deezer preview + its explicit flag per version key. This is where
// the explicit rendition actually comes from: for songs like DMX's
// "Party Up", the iTunes preview is the cleaned rendition while Deezer's
// preview of the same song is flagged explicit_lyrics — the two catalogs
// carry the two different versions.
type DzInfo = { url: string; explicit: boolean };
async function deezerInfoFor(
  query: string,
  limit = 25,
): Promise<Map<string, DzInfo>> {
  const map = new Map<string, DzInfo>();
  const json = await fetchJson(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  const data = json?.["data"];
  if (Array.isArray(data)) {
    for (const r of data as Raw[]) {
      const artist = r["artist"] as Raw | undefined;
      const key = versionKey(
        str(r["title"] ?? r["title_short"]),
        str(artist?.["name"]),
      );
      const preview = strOrNull(r["preview"]);
      if (preview && !map.has(key)) {
        map.set(key, { url: preview, explicit: r["explicit_lyrics"] === true });
      }
    }
  }
  return map;
}

// The artist's OWN top tracks on Deezer, keyed like deezerInfoFor.
// A plain Deezer text search for a name like "Lil Baby" surfaces other
// artists' songs and features first, so the version map misses the
// artist's own hits; the artist's top-tracks list is the reliable
// source for their explicit renditions. The artist is picked by name
// match with the most fans — Deezer search can return a same-named
// minor artist first (a 440-fan "Lil Baby" sits ahead of the real one,
// 1.4M fans), so first-match is not enough.
async function deezerArtistTopInfo(
  name: string,
): Promise<Map<string, DzInfo>> {
  const map = new Map<string, DzInfo>();
  const json = await fetchJson(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=10`,
  );
  const data = json?.["data"];
  if (!Array.isArray(data)) return map;
  let bestId: string | null = null;
  let bestFans = -1;
  for (const r of data as Raw[]) {
    const cand = str(r["name"]);
    if (cand && artistsMatch(cand, name)) {
      const fans = num(r["nb_fan"]);
      if (fans > bestFans) {
        bestFans = fans;
        bestId = r["id"] != null ? String(r["id"]) : null;
      }
    }
  }
  if (!bestId) return map;
  const top = await fetchJson(
    `https://api.deezer.com/artist/${encodeURIComponent(bestId)}/top?limit=50`,
  );
  const rows = top?.["data"];
  if (!Array.isArray(rows)) return map;
  for (const r of rows as Raw[]) {
    const artist = r["artist"] as Raw | undefined;
    const key = versionKey(
      str(r["title"] ?? r["title_short"]),
      str(artist?.["name"]),
    );
    const preview = strOrNull(r["preview"]);
    if (preview && !map.has(key)) {
      map.set(key, { url: preview, explicit: r["explicit_lyrics"] === true });
    }
  }
  return map;
}

// Expand a track list so BOTH renditions are listed when the sources
// carry both: the iTunes rendition (often the clean edit) stays as its
// own row, and a second row for the same song carries Deezer's explicit
// rendition, each labeled by its own source metadata. Version rows get
// fallbackPreviewUrl=null so a version never silently falls back to
// playing the other version. When only one rendition exists anywhere,
// the song stays a single row.
function expandVersions(
  tracks: TrackOut[],
  dz: Map<string, DzInfo>,
): TrackOut[] {
  if (dz.size === 0) return tracks;
  const out: TrackOut[] = [];
  for (const t of tracks) {
    const info = dz.get(versionKey(t.title, t.artist));
    if (!info || !info.explicit || !t.previewUrl || info.url === t.previewUrl) {
      // No explicit counterpart on Deezer — still attach Deezer as the
      // error fallback when it's a different URL for the same rendition.
      if (info && !info.explicit && t.previewUrl && info.url !== t.previewUrl) {
        out.push({ ...t, fallbackPreviewUrl: info.url });
      } else {
        out.push(t);
      }
      continue;
    }
    if (t.explicitness === "explicit") {
      // iTunes already carries the explicit rendition; Deezer's explicit
      // preview of the same song is a same-version fallback.
      out.push({ ...t, fallbackPreviewUrl: info.url });
      continue;
    }
    // iTunes rendition is the clean edit (or unlabeled) and Deezer's is
    // explicit: list both, clean first, explicit right after it.
    out.push({ ...t, fallbackPreviewUrl: null });
    out.push({
      ...t,
      previewUrl: info.url,
      fallbackPreviewUrl: null,
      explicitness: "explicit",
    });
  }
  return out;
}

// Deezer artist photo for a name (their artist search, matched by name).
async function deezerArtistFor(
  name: string,
): Promise<{ name: string; photoUrl: string | null } | null> {
  const json = await fetchJson(
    `https://api.deezer.com/search/artist?q=${encodeURIComponent(name)}&limit=8`,
  );
  const data = json?.["data"];
  if (!Array.isArray(data)) return null;
  for (const r of data as Raw[]) {
    const cand = str(r["name"]);
    if (cand && artistsMatch(cand, name)) {
      return {
        name: cand,
        photoUrl: strOrNull(r["picture_xl"]) ?? strOrNull(r["picture_big"]),
      };
    }
  }
  return null;
}

// The music videos that belong to an album: the artist's catalog music
// videos whose song title matches one of the album's track titles.
// Returns only real matches — an album with no videos gets an empty
// list, never another song's video.
async function videosForAlbumTracks(
  artist: string,
  trackTitles: string[],
): Promise<VideoOut[]> {
  if (!artist || trackTitles.length === 0) return [];
  const json = await itunes(
    `search?term=${encodeURIComponent(artist)}&media=musicVideo&entity=musicVideo&attribute=artistTerm&limit=30&country=US`,
  ).catch(() => null);
  const titleKeys = new Set(trackTitles.map((t) => normTitle(t)));
  return resultsOf(json)
    .map(toVideo)
    .filter((v) => v.title && titleKeys.has(normTitle(v.title)))
    .slice(0, 8);
}

type ProfileRow = typeof schema.artistProfiles.$inferSelect;

// Create the artist's stored profile if they don't have one yet: name,
// photo, bio/description and genre gathered from real sources —
// Wikipedia (bio + photo), Deezer (artist photo), iTunes (genre from
// their albums). Anything no source has stays null, never invented; the
// user can fill it in from the profile page. Returns the stored row.
async function ensureArtistProfile(
  ctx: Ctx,
  artistName: string,
  artistId: string | null,
): Promise<ProfileRow | null> {
  const key = artistKey(artistName);
  if (!key) return null;
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select()
    .from(schema.artistProfiles)
    .where(eq(schema.artistProfiles.artistKey, key))
    .limit(1);
  if (existing[0]) {
    if (artistId && !existing[0].artistId) {
      await db
        .update(schema.artistProfiles)
        .set({ artistId, updatedAt: new Date() })
        .where(eq(schema.artistProfiles.id, existing[0].id));
      return { ...existing[0], artistId };
    }
    return existing[0];
  }
  const [wiki, dzArtist, albumJson] = await Promise.all([
    wikiSummary([
      `${artistName} (musician)`,
      `${artistName} (rapper)`,
      `${artistName} (singer)`,
      artistName,
    ]).catch(() => null),
    deezerArtistFor(artistName).catch(() => null),
    itunes(
      `search?term=${encodeURIComponent(artistName)}&media=music&entity=album&attribute=artistTerm&limit=3&country=US`,
    ).catch(() => null),
  ]);
  const genre =
    resultsOf(albumJson)
      .map(toAlbum)
      .find((a) => artistsMatch(a.artist, artistName))?.genre ?? null;
  const inserted = await db
    .insert(schema.artistProfiles)
    .values({
      name: artistName,
      artistKey: key,
      artistId,
      photoUrl: wiki?.photo ?? dzArtist?.photoUrl ?? null,
      backgroundUrl: wiki?.photo ?? dzArtist?.photoUrl ?? null,
      bio: wiki?.extract ?? null,
      description: wiki?.description ?? null,
      genre,
      wikiUrl: wiki?.url ?? null,
      source: "ai-created",
    })
    .returning();
  return inserted[0] ?? null;
}

function parseContributors(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// A saved album's display artwork: the cover picture the user uploaded
// themselves (an owned blob — e.g. the cover.jpg inside an uploaded
// album folder) wins over the catalog URL borrowed at save time. Blob
// URLs are resolved fresh on every read, like track playback URLs.
async function albumArtwork(
  ctx: Ctx,
  album: { artworkUrl: string | null; artworkBlobKey: string | null },
): Promise<string | null> {
  if (album.artworkBlobKey) {
    try {
      return await ctx.blobs.getUrl(album.artworkBlobKey);
    } catch {
      return album.artworkUrl;
    }
  }
  return album.artworkUrl;
}

// Fill an album's credits from real sources: who's on it (Deezer
// contributors + the featuring artists named on its own tracks), the
// producer (named in the album's Wikipedia summary, extracted by AI —
// null when no source names one), the label (Deezer), and an about
// paragraph (the Wikipedia summary itself). Only fills fields that are
// currently empty, so a re-run never wipes better data.
async function enrichAlbumCredits(
  ctx: Ctx,
  albumId: number,
): Promise<{
  producer: string | null;
  contributors: string[];
  albumInfo: string | null;
  label: string | null;
}> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.savedAlbums)
    .where(eq(schema.savedAlbums.id, albumId))
    .limit(1);
  const album = rows[0];
  if (!album) throw new Error("That album isn't in your library anymore.");
  const tracks = await db
    .select()
    .from(schema.savedTracks)
    .where(eq(schema.savedTracks.albumId, albumId));

  const names = new Set<string>();
  names.add(album.artist);
  const featNames = (s: string): string[] => {
    const m = s.match(/(?:feat\.?|ft\.?|featuring)\s+([^()]+)/i);
    if (!m?.[1]) return [];
    return m[1]
      .split(/,|&/)
      .map((p) => p.trim())
      .filter((p) => p.length > 1);
  };
  for (const t of tracks) {
    // The track's own artist credit (main artist + anyone billed with
    // them), and any guest named after a feat./ft. marker in the title.
    for (const part of t.artist.split(/,|&/)) {
      const n = (part.split(/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/i)[0] ?? "").trim();
      if (n.length > 1) names.add(n);
    }
    for (const n of featNames(t.artist)) names.add(n);
    for (const n of featNames(t.title)) names.add(n);
  }

  let label = album.label;
  // Deezer: label + official contributors for this album.
  try {
    const dz = await fetchJson(
      `https://api.deezer.com/search/album?q=${encodeURIComponent(`${album.artist} ${album.title}`)}&limit=3`,
    );
    const data = dz?.["data"];
    const first = Array.isArray(data)
      ? (data as Raw[]).find((r) => artistsMatch(str((r["artist"] as Raw | undefined)?.["name"] ?? ""), album.artist) || normTitle(str(r["title"])) === normTitle(album.title))
      : undefined;
    if (first && first["id"] != null) {
      const detail = await fetchJson(`https://api.deezer.com/album/${String(first["id"])}`);
      if (detail) {
        if (!label) label = strOrNull(detail["label"]);
        const contribs = detail["contributors"];
        if (Array.isArray(contribs)) {
          for (const c of contribs) {
            const n = str((c as Raw)["name"]);
            if (n) names.add(n);
          }
        }
      }
    }
  } catch {
    // Deezer unreachable — track-derived contributors still stand.
  }

  // Wikipedia: about-the-album text + producer named in it.
  let albumInfo = album.albumInfo;
  let producer = album.producer;
  const wiki = await wikiSummary([
    `${album.title} (album)`,
    `${album.title} (${album.artist} album)`,
    album.title,
  ]).catch(() => null);
  if (wiki) {
    if (!albumInfo) albumInfo = wiki.extract.slice(0, 1200);
    if (!producer) {
      try {
        const out = await ctx.inference.complete(
          `From this text about the album "${album.title}" by ${album.artist}, extract the producer credit exactly as named in the text. If the text does not name a producer, return null.\n\n${wiki.extract.slice(0, 3000)}`,
          { schema: z.object({ producer: z.string().nullable() }) },
        );
        producer = out.producer;
      } catch {
        producer = null;
      }
    }
  }

  // No outside source knows this album (an unreleased upload): the
  // about text is then built from the album's own real data — its
  // artist, its songs as actually uploaded, its genre/release when
  // known — never invented credits or history. A previously generated
  // fallback (recognizable by its "in your library" phrasing) is
  // regenerated so it picks up songs added since.
  const isFallbackInfo = (s: string | null): boolean =>
    s != null && s.includes("in your library");
  if (!wiki && (!albumInfo || isFallbackInfo(albumInfo))) {
    const bits: string[] = [
      `“${album.title}” is an album by ${album.artist} in your library`,
    ];
    if (album.genre) bits.push(`filed under ${album.genre}`);
    if (album.releaseLabel) bits.push(`released ${album.releaseLabel}`);
    if (tracks.length > 0) {
      bits.push(
        `with ${tracks.length} ${tracks.length === 1 ? "song" : "songs"}: ${tracks
          .slice(0, 12)
          .map((t) => t.title)
          .join(", ")}${tracks.length > 12 ? ", and more" : ""}`,
      );
    } else {
      bits.push("uploaded before its songs were added");
    }
    albumInfo = `${bits.join(", ")}.`;
  }

  // A who's-on-it list that's already there (including one the user
  // typed in themselves) is kept as-is — enrich only fills it when
  // it's empty, like every other field here, so re-running the AI
  // never wipes the user's own words.
  const existingContribs = parseContributors(album.contributors);
  const contributors =
    existingContribs.length > 0
      ? existingContribs
      : [...names].filter(Boolean).slice(0, 24);
  await db
    .update(schema.savedAlbums)
    .set({
      producer: producer ?? album.producer,
      contributors: JSON.stringify(contributors),
      albumInfo: albumInfo ?? album.albumInfo,
      label: label ?? album.label,
    })
    .where(eq(schema.savedAlbums.id, albumId));
  ctx.invalidateQueries();
  return {
    producer: producer ?? album.producer,
    contributors,
    albumInfo: albumInfo ?? album.albumInfo,
    label: label ?? album.label,
  };
}

// Does this Wikipedia extract actually talk about THIS artist? A
// bare-title album lookup can land on a same-titled page about
// somebody else's work — "FRESH" resolved to the Wikipedia page for
// Scribe's 2007 single "F.R.E.S.H.", and its extract was nearly
// presented as the About text for Lil Baby's 2026 album. An album's
// own article names its artist in the lead, so require the artist's
// name (or its longest word, for dotted/stylized spellings) to
// appear in the extract before the page is used as this album's
// info; otherwise the album honestly shows no About text.
function wikiMentionsArtist(extract: string, artist: string): boolean {
  if (!extract || !artist) return false;
  const hay = extract.toLowerCase();
  const name = artist.toLowerCase().trim();
  if (name && hay.includes(name)) return true;
  const words = name.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const longest = words.sort((a, b) => b.length - a.length)[0];
  return longest ? hay.includes(longest) : false;
}

async function wikiSummary(
  titles: string[],
): Promise<{ extract: string; photo: string | null; url: string | null; description: string | null } | null> {
  for (const t of titles) {
    const json = await fetchJson(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t)}`,
    );
    if (!json) continue;
    const extract = str(json["extract"]);
    if (!extract) continue;
    const thumb = json["thumbnail"] as Raw | undefined;
    const orig = json["originalimage"] as Raw | undefined;
    const urls = json["content_urls"] as Raw | undefined;
    const desktop = urls?.["desktop"] as Raw | undefined;
    return {
      extract,
      photo: strOrNull(orig?.["source"]) ?? strOrNull(thumb?.["source"]),
      url: strOrNull(desktop?.["page"]),
      description: strOrNull(json["description"]),
    };
  }
  return null;
}

async function buildDmxSpotlight() {
      // DMX: iTunes artistId 135710, Deezer artistId 267 (verified live).
      const [songJson, albumJson, videoJson, dzTopJson, dzArtistJson, wiki] =
        await Promise.all([
          itunes(
            `search?term=DMX&media=music&entity=song&attribute=artistTerm&limit=40&country=US`,
          ),
          itunes(`lookup?id=135710&entity=album&limit=12&country=US`),
          itunes(
            `search?term=DMX&media=musicVideo&entity=musicVideo&attribute=artistTerm&limit=8&country=US`,
          ),
          fetchJson(`https://api.deezer.com/artist/267/top?limit=50`),
          fetchJson(`https://api.deezer.com/artist/267`),
          wikiSummary(["DMX (rapper)", "DMX"]),
        ]);

      // Deezer top tracks (Deezer's own popularity order for DMX).
      const dzData = dzTopJson?.["data"];
      const dzTracks: TrackOut[] = (Array.isArray(dzData) ? (dzData as Raw[]) : [])
        .map((r) => {
          const artist = r["artist"] as Raw | undefined;
          const album = r["album"] as Raw | undefined;
          return {
            title: str(r["title_short"] ?? r["title"]),
            artist: str(artist?.["name"]) || "DMX",
            artistId: "135710",
            albumTitle: str(album?.["title"]),
            albumId: null,
            artworkUrl:
              strOrNull(album?.["cover_big"]) ?? strOrNull(album?.["cover_xl"]),
            previewUrl: strOrNull(r["preview"]),
            fallbackPreviewUrl: null,
            durationMs: num(r["duration"]) * 1000,
            trackNumber: 0,
            discNumber: 1,
            genre: null,
            releaseLabel: null,
            explicitness:
              r["explicit_lyrics"] === true ? ("explicit" as const) : ("none" as const),
          };
        })
        .filter((t) => t.title && t.previewUrl);
      const dzMap = new Map<string, string>();
      for (const t of dzTracks) {
        const k = normTitle(t.title);
        if (t.previewUrl && !dzMap.has(k)) dzMap.set(k, t.previewUrl);
      }

      // Deezer explicit info per version, from Deezer's own top list.
      const dzInfo = new Map<string, DzInfo>();
      for (const t of dzTracks) {
        const k = versionKey(t.title, t.artist);
        if (t.previewUrl && !dzInfo.has(k)) {
          dzInfo.set(k, {
            url: t.previewUrl,
            explicit: t.explicitness === "explicit",
          });
        }
      }
      void dzMap;
      // iTunes tracks where DMX is the artist or is named on the track,
      // expanded so a song whose iTunes preview is the clean edit also
      // gets its explicit Deezer rendition as its own row.
      const itTracks = expandVersions(
        resultsOf(songJson)
          .map(toTrack)
          .filter(
            (t) =>
              t.title &&
              t.previewUrl &&
              `${t.artist} ${t.title}`.toLowerCase().includes("dmx"),
          ),
        dzInfo,
      );

      // Merge: iTunes versions first (better artwork/metadata), then any
      // Deezer-top songs iTunes search didn't surface. Dedupe by title +
      // version, so the clean and explicit renditions both survive.
      const byTitle = new Map<string, TrackOut>();
      for (const t of [...itTracks, ...dzTracks]) {
        const k = `${normTitle(t.title)}|${t.explicitness}`;
        if (k && !byTitle.has(k)) byTitle.set(k, t);
      }
      const merged = [...byTitle.values()];

      // His signature songs lead the queue, in this order; the rest keep
      // catalog order after them.
      const ESSENTIALS = [
        "x gon give it to ya",
        "ruff ryders anthem",
        "party up",
        "where the hood at",
        "slippin",
        "get it on the floor",
        "what these bitches want",
        "we right here",
        "hows it goin down",
        "stop being greedy",
        "damien",
        "i can feel it",
        "lord give me a sign",
        "who we be",
        "x is coming",
      ];

      // Neither top-list carries every signature song ("Where the Hood At"
      // is missing from both), so any essential still absent gets its own
      // targeted catalog search before the queue is finalized.
      const missing = ESSENTIALS.filter(
        (e) => !merged.some((t) => normTitle(t.title) === e),
      );
      if (missing.length > 0) {
        const found = await Promise.all(
          missing.map(async (e) => {
            const [sj, dm] = await Promise.all([
              itunes(
                `search?term=${encodeURIComponent(`DMX ${e}`)}&media=music&entity=song&limit=5&country=US`,
              ),
              deezerInfoFor(`DMX ${e}`, 5).catch(
                () => new Map<string, DzInfo>(),
              ),
            ]);
            const cands = expandVersions(resultsOf(sj).map(toTrack), dm).filter(
              (t) =>
                normTitle(t.title) === e &&
                t.previewUrl &&
                `${t.artist} ${t.title}`.toLowerCase().includes("dmx"),
            );
            // One row per missing essential in the spotlight queue —
            // prefer its explicit rendition when both exist.
            return (
              cands.find((t) => t.explicitness === "explicit") ??
              cands[0] ??
              null
            );
          }),
        );
        for (const f of found) if (f) merged.push(f);
      }

      const rank = (t: TrackOut) => {
        const i = ESSENTIALS.indexOf(normTitle(t.title));
        return i === -1 ? ESSENTIALS.length : i;
      };
      merged.sort((a, b) => rank(a) - rank(b));

      const albums = resultsOf(albumJson)
        .filter((r) => r["wrapperType"] === "collection")
        .map(toAlbum)
        .filter((a) => a.title && a.artist.toLowerCase().includes("dmx"));
      const videos = resultsOf(videoJson).map(toVideo).filter((v) => v.title);
      const dzPhoto =
        strOrNull(dzArtistJson?.["picture_xl"]) ??
        strOrNull(dzArtistJson?.["picture_big"]);
      return {
        artistName: "DMX",
        artistId: "135710",
        photoUrl: wiki?.photo ?? dzPhoto,
        tracks: merged.slice(0, 24),
        albums: albums.slice(0, 8),
        videos: videos.slice(0, 6),
      };
}

// ---------- YouTube search ----------
// Both sources are youtube.com itself: first the youtubei search endpoint
// (the API youtube.com's own web client calls; its key is the public
// web-client key printed in every youtube.com page source, not a user
// credential or secret), then — if that returns nothing — the public
// youtube.com search-results page, whose embedded ytInitialData carries the
// same video results. Queries never leave youtube.com. Both return real
// YouTube videos: title, channel, thumbnail, and duration, verified live.

const youtubeVideoOut = z.object({
  videoId: z.string(),
  title: z.string(),
  channel: z.string(),
  thumbnailUrl: z.string().nullable(),
  durationLabel: z.string().nullable(),
  durationSecs: z.number(),
  viewCountLabel: z.string().nullable(),
  publishedLabel: z.string().nullable(),
  watchUrl: z.string(),
  embedUrl: z.string(),
});
type YoutubeVideoOut = z.infer<typeof youtubeVideoOut>;

function ytText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as Raw;
  if (typeof n["simpleText"] === "string") return n["simpleText"];
  const runs = n["runs"];
  if (Array.isArray(runs)) {
    return runs.map((r) => str((r as Raw)["text"])).join("");
  }
  return "";
}

function collectVideoRenderers(node: unknown, out: Raw[]): void {
  if (Array.isArray(node)) {
    for (const v of node) collectVideoRenderers(v, out);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Raw;
    const vr = o["videoRenderer"];
    if (vr && typeof vr === "object") out.push(vr as Raw);
    for (const v of Object.values(o)) collectVideoRenderers(v, out);
  }
}

function parseDurationLabel(label: string | null): number {
  if (!label) return 0;
  const parts = label.split(":").map((p) => Number(p));
  if (parts.length === 0 || parts.some((p) => Number.isNaN(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function toYoutubeVideo(
  videoId: string,
  title: string,
  channel: string,
  thumbnailUrl: string | null,
  durationLabel: string | null,
  viewCountLabel: string | null,
  publishedLabel: string | null,
): YoutubeVideoOut {
  return {
    videoId,
    title,
    channel,
    thumbnailUrl,
    durationLabel,
    durationSecs: parseDurationLabel(durationLabel),
    viewCountLabel,
    publishedLabel,
    watchUrl: `https://www.youtube.com/watch?v=${videoId}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`,
  };
}

function renderersToVideos(json: unknown): YoutubeVideoOut[] {
  const renderers: Raw[] = [];
  collectVideoRenderers(json, renderers);
  const seen = new Set<string>();
  const out: YoutubeVideoOut[] = [];
  for (const v of renderers) {
    const videoId = str(v["videoId"]);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const title = ytText(v["title"]);
    if (!title) continue;
    const channel =
      ytText(v["ownerText"]) ||
      ytText(v["longBylineText"]) ||
      ytText(v["shortBylineText"]);
    const thumbs = (v["thumbnail"] as Raw | undefined)?.["thumbnails"];
    const thumbArr = Array.isArray(thumbs) ? (thumbs as Raw[]) : [];
    const thumbnailUrl = strOrNull(thumbArr[thumbArr.length - 1]?.["url"]);
    const durationLabel =
      strOrNull(ytText(v["lengthText"])) ??
      (Array.isArray(v["badges"]) ? "LIVE" : null);
    out.push(
      toYoutubeVideo(
        videoId,
        title,
        channel,
        thumbnailUrl,
        durationLabel,
        strOrNull(ytText(v["viewCountText"])),
        strOrNull(ytText(v["publishedTimeText"])),
      ),
    );
    if (out.length >= 15) break;
  }
  return out;
}

async function youtubeSearchInnertube(
  query: string,
): Promise<YoutubeVideoOut[]> {
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false",
      {
        method: "POST",
        signal: AbortSignal.timeout(12000),
        headers: {
          "Content-Type": "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: "2.20240111.09.00",
              hl: "en",
              gl: "US",
            },
          },
          query,
        }),
      },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as Record<string, unknown>;
    return renderersToVideos(json);
  } catch {
    return [];
  }
}

// Fallback that still never leaves youtube.com: the public search-results
// page embeds the same results as ytInitialData JSON.
async function youtubeSearchResultsPage(
  query: string,
): Promise<YoutubeVideoOut[]> {
  try {
    const res = await fetch(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`,
      {
        signal: AbortSignal.timeout(12000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          "Accept-Language": "en-US",
        },
      },
    );
    if (!res.ok) return [];
    const html = await res.text();
    const marker = "var ytInitialData = ";
    const start = html.indexOf(marker);
    if (start === -1) return [];
    const jsonStart = start + marker.length;
    const end = html.indexOf(";</script>", jsonStart);
    if (end === -1) return [];
    const data = JSON.parse(html.slice(jsonStart, end)) as unknown;
    return renderersToVideos(data);
  } catch {
    return [];
  }
}

// ---------- assistant-triggered playback ----------

const playbackRequestOut = z.object({
  id: z.number(),
  query: z.string(),
  title: z.string(),
  artist: z.string(),
  artworkUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
  fallbackPreviewUrl: z.string().nullable(),
  durationMs: z.number(),
  albumTitle: z.string().nullable(),
  savedTrackId: z.number().nullable(),
});

// ---------- hum-to-search helpers ----------
// A hummed melody is recognized by its SHAPE, not its absolute pitches:
// people hum in whatever key is comfortable and the mic detector can be
// a note off, so the matcher works on the transposition-invariant
// step sequence (semitones from the first note) and the up/down contour,
// and every candidate song the model names is verified against the live
// iTunes catalog before it is shown — only real, playable songs surface.

const HUM_NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];

type HumCandidate = { title: string; artist: string };

// How well a catalog hit actually is the candidate song the matcher
// named. Title agreement dominates; karaoke / tribute / remix / live
// renditions are pushed down unless the candidate itself asked for one,
// so the original studio recording wins the top slot.
function humHitScore(hit: TrackOut, cand: HumCandidate): number {
  const ht = normTitle(hit.title);
  const ct = normTitle(cand.title);
  if (!ht || !ct) return -1;
  let score = 0;
  if (ht === ct) score += 60;
  else if (ht.includes(ct) || ct.includes(ht)) score += 45;
  else {
    const ctWords = new Set(ct.split(" ").filter(Boolean));
    const htWords = new Set(ht.split(" ").filter(Boolean));
    let shared = 0;
    for (const w of ctWords) if (htWords.has(w)) shared++;
    if (ctWords.size > 0) score += Math.round((shared / ctWords.size) * 40);
  }
  if (cand.artist && artistsMatch(hit.artist, cand.artist)) score += 30;
  const rawTitle = hit.title.toLowerCase();
  const candRaw = cand.title.toLowerCase();
  const penalize = (word: string, pts: number) => {
    if (rawTitle.includes(word) && !candRaw.includes(word)) score -= pts;
  };
  penalize("karaoke", 60);
  penalize("tribute", 60);
  penalize("backing track", 60);
  penalize("remix", 35);
  penalize("sped up", 30);
  penalize("slowed", 30);
  penalize("instrumental", 25);
  penalize("cover", 25);
  penalize("live", 20);
  return score;
}

// Verify one named candidate against the live catalog: search iTunes
// for "title artist", keep the best-scoring playable hit, then attach
// Deezer's preview as fallback (and a separate explicit row when Deezer
// carries that rendition, same as the rest of the app). Returns [] when
// the catalog has no confident hit for the candidate — an unverified
// guess is never shown as a result.
async function humVerifyCandidate(cand: HumCandidate): Promise<TrackOut[]> {
  const term = `${cand.title} ${cand.artist}`.trim();
  if (!term) return [];
  const json = await itunes(
    `search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=8&country=US`,
  );
  let best: TrackOut | null = null;
  let bestScore = 44;
  for (const r of resultsOf(json)) {
    const t = toTrack(r);
    if (!t.title || !t.previewUrl) continue;
    const s = humHitScore(t, cand);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  if (!best) return [];
  const dz = await deezerInfoFor(term, 10).catch(
    () => new Map<string, DzInfo>(),
  );
  return expandVersions([best], dz);
}

// Deliberately lenient: the matcher model sometimes leaves the artist
// blank/null or lists extra candidates, and a strict schema turned
// those answers into a failed search. Bad entries are filtered out in
// the handler instead.
const humCandidateList = z.object({
  candidates: z
    .array(
      z.object({
        title: z.string().catch(""),
        artist: z.string().catch(""),
      }),
    )
    .catch([]),
});

// ---------- actions ----------

const okResponse = z.object({ ok: z.literal(true) });

const planTierOut = z.enum(["developer", "free", "premium"]);
const planResponse = z.object({
  tier: planTierOut,
  adsEnabled: z.boolean(),
});

export const Actions = {
  getPlan: defineAction({
    description:
      "Returns this install's plan tier (developer / free / premium) and whether ads are on. The developer's own install is ad-free; a free install shows ads; the paid premium plan removes them.",
    request: z.object({}),
    response: planResponse,
    async handler(ctx): Promise<z.infer<typeof planResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.appPlan)
        .where(eq(schema.appPlan.id, 1))
        .limit(1);
      let tier = rows[0]?.tier;
      if (!tier) {
        // First run: this install belongs to the developer, so it
        // starts on the developer tier — no ads for the owner.
        await db
          .insert(schema.appPlan)
          .values({ id: 1, tier: "developer" })
          .onConflictDoNothing();
        tier = "developer";
      }
      return { tier, adsEnabled: tier === "free" };
    },
  }),

  setPlan: defineAction({
    description:
      "Switches this install's plan tier: developer (the owner's own account, no ads), free (the free App Store version, with ads), or premium (paid, no ads). Used from Library → Settings → Your plan to preview each tier and to go premium.",
    request: z.object({ tier: planTierOut }),
    response: planResponse,
    async handler(ctx, args): Promise<z.infer<typeof planResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.appPlan)
        .where(eq(schema.appPlan.id, 1))
        .limit(1);
      if (rows[0]) {
        await db
          .update(schema.appPlan)
          .set({ tier: args.tier, updatedAt: new Date() })
          .where(eq(schema.appPlan.id, 1));
      } else {
        await db.insert(schema.appPlan).values({ id: 1, tier: args.tier });
      }
      ctx.invalidateQueries();
      return { tier: args.tier, adsEnabled: args.tier === "free" };
    },
  }),

  homeFeed: defineAction({
    description:
      "Loads the home feed: trending albums, top songs, music videos, and top artists from the live catalog charts.",
    request: z.object({}),
    response: z.object({
      albums: z.array(albumOut),
      tracks: z.array(trackOut),
      videos: z.array(videoOut),
      artists: z.array(artistOut),
    }),
    async handler() {
      const [chart, videoJson] = await Promise.all([
        fetchJson("https://api.deezer.com/chart/0"),
        itunes(
          `search?term=${encodeURIComponent("music video")}&media=musicVideo&entity=musicVideo&limit=12&country=US`,
        ),
      ]);
      const albumsRaw = (chart?.["albums"] as Raw | undefined)?.["data"];
      const tracksRaw = (chart?.["tracks"] as Raw | undefined)?.["data"];
      const artistsRaw = (chart?.["artists"] as Raw | undefined)?.["data"];
      const albums: AlbumOut[] = (Array.isArray(albumsRaw) ? albumsRaw : [])
        .slice(0, 12)
        .map((a) => {
          const artist = a["artist"] as Raw | undefined;
          return {
            // Deezer chart IDs live in Deezer's namespace, not iTunes' —
            // the "dz-" prefix tells getAlbum/saveCatalogAlbum to resolve
            // the album (and its tracklist) from Deezer instead.
            catalogId: a["id"] != null ? `dz-${String(a["id"])}` : "",
            title: str(a["title"]),
            artist: str(artist?.["name"]),
            artistId: artist?.["id"] != null ? String(artist["id"]) : null,
            artworkUrl: strOrNull(a["cover_xl"]) ?? strOrNull(a["cover_big"]),
            genre: null,
            releaseLabel: null,
            releaseDateIso: null,
            trackCount: 0,
            explicitness:
              a["explicit_lyrics"] === true ? ("explicit" as const) : ("none" as const),
          };
        })
        .filter((a) => a.title && a.catalogId);
      const tracks: TrackOut[] = (Array.isArray(tracksRaw) ? tracksRaw : [])
        .slice(0, 15)
        .map((t) => {
          const artist = t["artist"] as Raw | undefined;
          const album = t["album"] as Raw | undefined;
          return {
            title: str(t["title"]),
            artist: str(artist?.["name"]),
            artistId: artist?.["id"] != null ? String(artist["id"]) : null,
            albumTitle: str(album?.["title"]),
            albumId: album?.["id"] != null ? String(album["id"]) : null,
            artworkUrl:
              strOrNull(album?.["cover_big"]) ?? strOrNull(album?.["cover_xl"]),
            previewUrl: strOrNull(t["preview"]),
            fallbackPreviewUrl: null,
            durationMs: num(t["duration"]) * 1000,
            trackNumber: 0,
            discNumber: 1,
            genre: null,
            releaseLabel: null,
            explicitness:
              t["explicit_lyrics"] === true ? ("explicit" as const) : ("none" as const),
          };
        })
        .filter((t) => t.title && t.previewUrl);
      const artists = (Array.isArray(artistsRaw) ? artistsRaw : [])
        .slice(0, 10)
        .map((a) => ({
          name: str(a["name"]),
          artistId: a["id"] != null ? String(a["id"]) : null,
          genre: null as string | null,
          artworkUrl:
            strOrNull(a["picture_xl"]) ?? strOrNull(a["picture_big"]),
        }))
        .filter((a) => a.name);
      const videos = resultsOf(videoJson).map(toVideo).filter((v) => v.title);
      return { albums, tracks, videos, artists };
    },
  }),

  searchMusic: defineAction({
    description:
      "Search by artist name, song title, or album title — one query runs all three ways at once: songs are searched by song title and by artist, albums by album title and by artist in BOTH catalogs (iTunes and Deezer, so Deezer-only albums like Lil Baby's FRESH show up), artists by name, plus music videos, in the catalogs and in the user's own library (uploaded albums, songs, and artists come back as libraryMatches). Albums run newest first by release year after the exact-title match. Songs list both the clean and the explicit rendition when the catalogs carry both, each labeled.",
    request: z.object({ query: z.string().min(1).max(120) }),
    response: z.object({
      songs: z.array(trackOut),
      albums: z.array(albumOut),
      artists: z.array(artistOut),
      videos: z.array(videoOut),
      libraryMatches: z.object({
        albums: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            artist: z.string(),
            artworkUrl: z.string().nullable(),
            trackCount: z.number(),
          }),
        ),
        tracks: z.array(
          z.object({
            id: z.number(),
            albumId: z.number(),
            title: z.string(),
            artist: z.string(),
            artworkUrl: z.string().nullable(),
            previewUrl: z.string().nullable(),
            durationMs: z.number(),
            hasFullFile: z.boolean(),
          }),
        ),
        artists: z.array(z.string()),
      }),
    }),
    async handler(ctx, args) {
      const q = encodeURIComponent(args.query);
      const [
        songJson,
        songByTitle,
        songByArtist,
        albumJson,
        albumByTitle,
        albumByArtist,
        artistJson,
        videoJson,
        dzInfo,
        dzAlbums,
      ] = await Promise.all([
        itunes(`search?term=${q}&media=music&entity=song&limit=25&country=US`),
        itunes(`search?term=${q}&media=music&entity=song&attribute=songTerm&limit=15&country=US`),
        itunes(`search?term=${q}&media=music&entity=song&attribute=artistTerm&limit=15&country=US`),
        itunes(`search?term=${q}&media=music&entity=album&limit=12&country=US`),
        itunes(`search?term=${q}&media=music&entity=album&attribute=albumTerm&limit=10&country=US`),
        itunes(`search?term=${q}&media=music&entity=album&attribute=artistTerm&limit=10&country=US`),
        itunes(`search?term=${q}&media=music&entity=musicArtist&limit=8&country=US`),
        itunes(`search?term=${q}&media=musicVideo&entity=musicVideo&limit=12&country=US`),
        deezerInfoFor(args.query).catch(() => new Map<string, DzInfo>()),
        deezerAlbumSearch(args.query).catch(() => [] as AlbumOut[]),
      ]);
      const dedupeTracks = (lists: TrackOut[][]): TrackOut[] => {
        const seen = new Set<string>();
        const out: TrackOut[] = [];
        for (const list of lists) {
          for (const t of list) {
            const k = `${normTitle(t.title)}|${artistKey(t.artist)}|${t.albumId ?? ""}|${t.explicitness}|${t.previewUrl ?? ""}`;
            if (t.title && !seen.has(k)) {
              seen.add(k);
              out.push(t);
            }
          }
        }
        return out;
      };
      // Rank songs so the artist's/artist-name and exact-title matches
      // lead: when the query IS an artist's name, that artist's own
      // songs come first; when it is a song title, the exact title
      // leads.
      const qNorm = normTitle(args.query);
      const qKey = artistKey(args.query);
      const rankSongs = (list: TrackOut[]): TrackOut[] =>
        [...list]
          .map((t, i) => ({
            t,
            i,
            score:
              (artistKey(t.artist) === qKey ? 0 : 2) +
              (normTitle(t.title) === qNorm ? 0 : 1),
          }))
          .sort((a, b) => a.score - b.score || a.i - b.i)
          .map((x) => x.t);
      const songs = expandVersions(
        rankSongs(
          dedupeTracks([
            resultsOf(songJson).map(toTrack),
            resultsOf(songByTitle).map(toTrack),
            resultsOf(songByArtist).map(toTrack),
          ]).slice(0, 30),
        ),
        dzInfo,
      );
      const dedupeAlbums = (lists: AlbumOut[][]): AlbumOut[] => {
        const seen = new Set<string>();
        const out: AlbumOut[] = [];
        for (const list of lists) {
          for (const a of list) {
            if (a.title && a.catalogId && !seen.has(a.catalogId)) {
              seen.add(a.catalogId);
              out.push(a);
            }
          }
        }
        return out;
      };
      // Deezer's albums join the iTunes ones: a release that exists
      // only on Deezer (Lil Baby's FRESH — iTunes has the Dead Fresh
      // single and his older albums, but not the album) must still
      // show up when the user searches for it. A Deezer row is kept
      // when the query's words all land in its title + artist (the
      // same token rule the library match below uses), and dropped
      // when iTunes already carries the same album (same base title
      // + artist) — the iTunes copy is the richer one and wins.
      const queryTokens = args.query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1);
      const itunesAlbums = dedupeAlbums([
        resultsOf(albumJson).map(toAlbum),
        resultsOf(albumByTitle).map(toAlbum),
        resultsOf(albumByArtist).map(toAlbum),
      ]);
      const itunesBaseKeys = new Set(
        itunesAlbums.map(
          (a) => `${albumBaseKey(a.title)}|${artistKey(a.artist)}`,
        ),
      );
      const dzKept = dzAlbums.filter((a) => {
        const hay = `${a.title} ${a.artist}`.toLowerCase();
        const hit =
          queryTokens.length > 0 &&
          queryTokens.every((w) => hay.includes(w));
        if (!hit) return false;
        return !itunesBaseKeys.has(
          `${albumBaseKey(a.title)}|${artistKey(a.artist)}`,
        );
      });
      const mergedAlbums = dedupeAlbums([itunesAlbums, dzKept]);
      // Deezer search rows carry no release date — fill them from
      // the albums' own details so they sort by year like the rest.
      await enrichDeezerAlbumDates(mergedAlbums);
      // Order albums: the album the user typed by name leads (an
      // exact title match — without this the merged generic search
      // could bury the named album under an artist's bigger catalog:
      // typing "My Turn" showed other Lil Baby albums instead of My
      // Turn itself); everything else runs newest first, by release
      // year, so this year's albums sit at the top.
      const rankAlbums = (list: AlbumOut[]): AlbumOut[] =>
        [...list]
          .map((a, i) => ({ a, i }))
          .sort((x, y) => {
            const ex = normTitle(x.a.title) === qNorm ? 0 : 1;
            const ey = normTitle(y.a.title) === qNorm ? 0 : 1;
            if (ex !== ey) return ex - ey;
            const dx = x.a.releaseDateIso ?? "";
            const dy = y.a.releaseDateIso ?? "";
            if (dx !== dy) return dx > dy ? -1 : 1;
            const ax = artistKey(x.a.artist) === qKey ? 0 : 1;
            const ay = artistKey(y.a.artist) === qKey ? 0 : 1;
            if (ax !== ay) return ax - ay;
            return x.i - y.i;
          })
          .map((x) => x.a);
      const albums = rankAlbums(mergedAlbums).slice(0, 16);

      // The user's own library, matched the same three ways: by artist
      // name, by song title, and by album title.
      const db = ctx.db<typeof schema>();
      const tokens = args.query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1);
      const hits = (hay: string) =>
        tokens.length > 0 &&
        tokens.every((w) => hay.toLowerCase().includes(w));
      const savedAlbums = await db.select().from(schema.savedAlbums);
      const libAlbums = savedAlbums.filter((a) =>
        hits(`${a.title} ${a.artist}`),
      );
      const libAlbumIds = new Set(libAlbums.map((a) => a.id));
      const savedTracks = await db.select().from(schema.savedTracks);
      const libTracks = savedTracks
        .filter(
          (t) =>
            hits(`${t.title} ${t.artist}`) ||
            (t.albumId != null && libAlbumIds.has(t.albumId)),
        )
        .slice(0, 20);
      const libArtists = [
        ...new Set(
          savedAlbums
            .filter((a) => hits(a.artist))
            .map((a) => a.artist),
        ),
      ].slice(0, 6);
      const albumArt = new Map<number, string | null>();
      await Promise.all(
        savedAlbums.map(async (a) => {
          albumArt.set(a.id, await albumArtwork(ctx, a));
        }),
      );
      const libAlbumsOut = [];
      for (const a of libAlbums.slice(0, 8)) {
        libAlbumsOut.push({
          id: a.id,
          title: a.title,
          artist: a.artist,
          artworkUrl: albumArt.get(a.id) ?? null,
          trackCount: savedTracks.filter((t) => t.albumId === a.id).length,
        });
      }
      // Artists: put the artist whose name the query actually is first
      // (exact/starts-with match, then most albums in this catalog),
      // and give each artist a real photo from the tested sources
      // (Deezer's artist picture, else the Wikipedia photo) so the
      // search-bar dropdown and the Artists section show the artist,
      // not an initial. Artists with no photo anywhere keep null and
      // the UI falls back to the initial — never invented.
      const artistRows = resultsOf(artistJson)
        .map((r) => ({
          name: str(r["artistName"]),
          artistId: r["artistId"] != null ? String(r["artistId"]) : null,
          genre: strOrNull(r["primaryGenreName"]),
          artworkUrl: null as string | null,
        }))
        .filter((a) => a.name);
      const albumCountByArtist = new Map<string, number>();
      for (const a of albums) {
        const k = artistKey(a.artist);
        albumCountByArtist.set(k, (albumCountByArtist.get(k) ?? 0) + 1);
      }
      // iTunes lists the same person under several artist IDs (the
      // "Lil Baby" search returns six "Lil Baby" rows) — dedupe by
      // name after ranking so the best entry (most albums here) is
      // the one that pops up, once.
      const seenArtistKeys = new Set<string>();
      const rankedArtists = [...artistRows]
        .map((a, i) => {
          const ak = artistKey(a.name);
          const nameScore =
            ak === qKey
              ? 0
              : ak.startsWith(qKey) || qKey.startsWith(ak)
                ? 1
                : 2;
          return { a, i, nameScore, count: albumCountByArtist.get(ak) ?? 0 };
        })
        .sort(
          (x, y) =>
            x.nameScore - y.nameScore || y.count - x.count || x.i - y.i,
        )
        .map((x) => x.a)
        .filter((a) => {
          const k = artistKey(a.name);
          if (seenArtistKeys.has(k)) return false;
          seenArtistKeys.add(k);
          return true;
        })
        .slice(0, 8);
      await Promise.all(
        rankedArtists.slice(0, 8).map(async (a) => {
          try {
            const dz = await fetchJson(
              `https://api.deezer.com/search/artist?q=${encodeURIComponent(a.name)}&limit=5`,
            );
            const rows = dz?.["data"];
            if (Array.isArray(rows)) {
              const hit = (rows as Raw[]).find(
                (r) => artistKey(str(r["name"])) === artistKey(a.name),
              );
              const pic = strOrNull(hit?.["picture_medium"]);
              // Deezer sometimes returns an empty-hash URL that 404s —
              // treat it as no photo.
              a.artworkUrl =
                pic && !pic.includes("/artist//") ? pic : null;
            }
          } catch {
            a.artworkUrl = null;
          }
          if (!a.artworkUrl) {
            const wiki = await wikiSummary([
              `${a.name} (musician)`,
              `${a.name} (rapper)`,
              `${a.name} (singer)`,
              a.name,
            ]).catch(() => null);
            a.artworkUrl = wiki?.photo ?? null;
          }
        }),
      );
      return {
        songs,
        albums,
        artists: rankedArtists,
        videos: resultsOf(videoJson).map(toVideo).filter((v) => v.title),
        libraryMatches: {
          albums: libAlbumsOut,
          tracks: libTracks.map((t) => ({
            id: t.id,
            albumId: t.albumId ?? 0,
            title: t.title,
            artist: t.artist,
            artworkUrl: t.artworkUrl ?? (t.albumId ? albumArt.get(t.albumId) ?? null : null),
            previewUrl: t.previewUrl,
            durationMs: t.durationMs,
            hasFullFile: t.blobKey != null,
          })),
          artists: libArtists,
        },
      };
    },
  }),

  dmxSpotlight: defineAction({
    description:
      "DMX artist spotlight for in-app playback: his essential tracks with playable official previews from two catalog sources (Apple Music/iTunes primary, Deezer fallback), plus his albums and music videos. Built so tapping play on DMX starts playback inside the app without Spotify or any other service.",
    request: z.object({}),
    response: z.object({
      artistName: z.string(),
      artistId: z.string(),
      photoUrl: z.string().nullable(),
      tracks: z.array(trackOut),
      albums: z.array(albumOut),
      videos: z.array(videoOut),
    }),
    async handler() {
      return buildDmxSpotlight();
    },
  }),

  getAlbum: defineAction({
    description:
      "Gets one album's full details: ordered tracklist with previews (both the clean and the explicit rendition of each song when the catalogs carry both, each labeled), grouped by disc on multi-disc albums — every track carries its discNumber and the list runs disc-major, Disc 1 first and Disc 2 right under it — plus the full release date (day, month, and year from the catalog's own date, as releaseDateLabel), label, who's on the album, producer credits where a source lists them, the about-the-album text, the alternate edition (the explicit or clean version of this same album) when the catalog sells it as a separate edition, and every edition of the album (editions, each with its versionLabel — Original / Deluxe / Explicit / Clean / combos) for the page's version filter, so the user can pick one version and save/download just that version. When the album is in the user's library, the user's own saved edits to its info (updateAlbumInfo) are shown instead of the catalog values.",
    request: z.object({ catalogId: z.string().min(1) }),
    response: z.object({
      album: albumOut.extend({
        label: z.string().nullable(),
        copyright: z.string().nullable(),
      }),
      // Full release date for the album page header — day, month, and
      // year from the catalog's own date; falls back to the month-year
      // label when the catalog gives no day-precision date.
      releaseDateLabel: z.string().nullable(),
      tracks: z.array(trackOut),
      contributors: z.array(z.string()),
      producer: z.string().nullable(),
      // About-the-album text (the album's Wikipedia summary, or what
      // the user typed in themselves on their library copy).
      albumInfo: z.string().nullable(),
      wikiUrl: z.string().nullable(),
      savedId: z.number().nullable(),
      downloaded: z.boolean(),
      alternateEdition: albumOut.nullable(),
      // All editions of this album (see the handler): the version
      // filter's options, this page's own edition included.
      editions: z.array(editionOut),
      videos: z.array(videoOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      // Resolves iTunes collection IDs AND Deezer album IDs ("dz-…", from
      // the Home feed's trending albums) to the album + its tracklist.
      const resolved = await resolveCatalogAlbum(args.catalogId);
      let album: AlbumOut & { label: string | null; copyright: string | null } =
        resolved?.album ?? {
          catalogId: args.catalogId,
          title: "",
          artist: "",
          artistId: null,
          artworkUrl: null,
          genre: null,
          releaseLabel: null,
          releaseDateIso: null,
          trackCount: 0,
          explicitness: "none" as const,
          label: null,
          copyright: null,
        };
      const tracks = resolved?.tracks ?? [];

      // Deezer enrichment: label + everyone on the album.
      let contributors: string[] = resolved?.contributors ?? [];
      if (album.title) {
        const dz = await fetchJson(
          `https://api.deezer.com/search/album?q=${encodeURIComponent(`${album.artist} ${album.title}`)}&limit=1`,
        );
        const data = dz?.["data"];
        const first = Array.isArray(data) ? (data[0] as Raw | undefined) : undefined;
        if (first && first["id"] != null) {
          const detail = await fetchJson(
            `https://api.deezer.com/album/${String(first["id"])}`,
          );
          if (detail) {
            if (!album.label) album.label = strOrNull(detail["label"]);
            const contribs = detail["contributors"];
            if (Array.isArray(contribs)) {
              contributors = contribs
                .map((c) => str((c as Raw)["name"]))
                .filter(Boolean);
            }
          }
        }
      }
      if (contributors.length === 0 && album.artist) {
        const names = new Set<string>([album.artist]);
        for (const t of tracks) {
          for (const part of t.artist.split(/,|&| feat\.? | ft\.? /i)) {
            const n = part.trim();
            if (n) names.add(n);
          }
        }
        contributors = [...names];
      }

      // Producer: mined from the album's Wikipedia summary when it names one.
      let producer: string | null = null;
      let wikiUrl: string | null = null;
      let albumInfo: string | null = null;
      if (album.title) {
        const wikiRaw = await wikiSummary([
          `${album.title} (album)`,
          `${album.title} (${album.artist} album)`,
          album.title,
        ]);
        // Only this artist's page counts as this album's info — a
        // same-titled page about someone else's work is discarded,
        // never presented as the album's About text.
        const wiki =
          wikiRaw && wikiMentionsArtist(wikiRaw.extract, album.artist)
            ? wikiRaw
            : null;
        if (wiki) {
          wikiUrl = wiki.url;
          albumInfo = wiki.extract ? wiki.extract.slice(0, 1200) : null;
          try {
            const out = await ctx.inference.complete(
              `From this text about the album "${album.title}" by ${album.artist}, extract the producer credit exactly as named in the text. If the text does not name a producer, return null.\n\n${wiki.extract.slice(0, 3000)}`,
              {
                schema: z.object({ producer: z.string().nullable() }),
              },
            );
            producer = out.producer;
          } catch {
            producer = null;
          }
        }
      }
      if (album.label == null && album.copyright) {
        album.label = album.copyright.replace(/^℗\s*\d{4}\s*/, "");
      }

      // Both renditions per song: Deezer's tracklist for this same album
      // carries the explicit rendition of songs whose iTunes preview is
      // the clean edit — expand so each version is its own playable row.
      let expandedTracks = tracks;
      if (album.title) {
        try {
          const dzSearch = await fetchJson(
            `https://api.deezer.com/search/album?q=${encodeURIComponent(`${album.artist} ${album.title}`)}&limit=3`,
          );
          const dzData = dzSearch?.["data"];
          const dzFirst = Array.isArray(dzData) ? (dzData[0] as Raw | undefined) : undefined;
          if (dzFirst && dzFirst["id"] != null) {
            const dzTracksJson = await fetchJson(
              `https://api.deezer.com/album/${String(dzFirst["id"])}/tracks?limit=60`,
            );
            const dzRows = dzTracksJson?.["data"];
            if (Array.isArray(dzRows)) {
              const info = new Map<string, DzInfo>();
              for (const r of dzRows as Raw[]) {
                const dzArtist = r["artist"] as Raw | undefined;
                const k = versionKey(
                  str(r["title"] ?? r["title_short"]),
                  str(dzArtist?.["name"]) || album.artist,
                );
                const url = strOrNull(r["preview"]);
                if (url && !info.has(k)) {
                  info.set(k, { url, explicit: r["explicit_lyrics"] === true });
                }
              }
              expandedTracks = expandVersions(tracks, info);
            }
          }
        } catch {
          expandedTracks = tracks;
        }
      }

      // Every edition of this album the catalog sells as its own
      // collection — Original, Deluxe, Explicit, Clean, and combos —
      // for the album page's version filter. Each edition is a
      // separate catalog album with its own tracklist; the page the
      // user is on is one edition, and picking another in the filter
      // opens that edition's page, so saving/downloading always takes
      // just the picked version. Same-named editions (reissues) keep
      // the one with the most tracks; this album's own entry is never
      // replaced by a same-version twin from the other catalog.
      let editions: EditionOut[] = [];
      if (album.title && album.artist) {
        try {
          const edSearch = await itunes(
            `search?term=${encodeURIComponent(`${album.artist} ${album.title}`)}&media=music&entity=album&limit=25&country=US`,
          );
          const baseKey = albumBaseKey(album.title);
          const byLabel = new Map<string, EditionOut>();
          byLabel.set(versionLabelOf(album), {
            ...album,
            versionLabel: versionLabelOf(album),
          });
          for (const a of resultsOf(edSearch).map(toAlbum)) {
            if (!a.catalogId || a.catalogId === album.catalogId) continue;
            if (!artistsMatch(a.artist, album.artist)) continue;
            if (albumBaseKey(a.title) !== baseKey) continue;
            const ed: EditionOut = { ...a, versionLabel: versionLabelOf(a) };
            const prev = byLabel.get(ed.versionLabel);
            if (!prev) {
              byLabel.set(ed.versionLabel, ed);
            } else if (
              prev.catalogId !== album.catalogId &&
              ed.trackCount > prev.trackCount
            ) {
              byLabel.set(ed.versionLabel, ed);
            }
          }
          const order = [
            "Original",
            "Deluxe",
            "Explicit",
            "Clean",
            "Deluxe · Explicit",
            "Deluxe · Clean",
          ];
          const rank = (label: string) => {
            const i = order.indexOf(label);
            return i === -1 ? order.length : i;
          };
          editions = [...byLabel.values()].sort(
            (x, y) => rank(x.versionLabel) - rank(y.versionLabel),
          );
        } catch {
          editions = [];
        }
      }
      const alternateEdition: AlbumOut | null = (() => {
        const alt = editions.find(
          (e) =>
            e.catalogId !== album.catalogId &&
            e.explicitness === "explicit",
        );
        if (!alt) return null;
        return {
          catalogId: alt.catalogId,
          title: alt.title,
          artist: alt.artist,
          artistId: alt.artistId,
          artworkUrl: alt.artworkUrl,
          genre: alt.genre,
          releaseLabel: alt.releaseLabel,
          releaseDateIso: alt.releaseDateIso,
          trackCount: alt.trackCount,
          explicitness: alt.explicitness,
        };
      })();

      const albumVideos = await videosForAlbumTracks(
        album.artist,
        tracks.map((t) => t.title),
      ).catch(() => [] as VideoOut[]);

      const saved = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.catalogId, args.catalogId))
        .limit(1);
      const savedRow = saved[0];

      // The user's own words win: when this album is in their library,
      // anything they typed in themselves (or had filled in on the
      // library copy) replaces the live catalog value on this page, so
      // their fixes and fill-ins are what the album shows. Fields the
      // library copy doesn't have keep the live catalog values.
      let shownAlbum = album;
      let shownProducer = producer;
      let shownContributors = contributors;
      let shownAlbumInfo = albumInfo;
      let shownReleaseDateLabel =
        fullDate(resolved?.releaseDateIso) ?? album.releaseLabel;
      if (savedRow) {
        const savedContribs = parseContributors(savedRow.contributors);
        const savedArt = await albumArtwork(ctx, savedRow);
        shownAlbum = {
          ...album,
          title: savedRow.title || album.title,
          artist: savedRow.artist || album.artist,
          genre: savedRow.genre ?? album.genre,
          releaseLabel: savedRow.releaseLabel ?? album.releaseLabel,
          label: savedRow.label ?? album.label,
          artworkUrl: savedArt ?? album.artworkUrl,
        };
        if (savedRow.producer) shownProducer = savedRow.producer;
        if (savedContribs.length > 0) shownContributors = savedContribs;
        if (savedRow.albumInfo) shownAlbumInfo = savedRow.albumInfo;
        if (savedRow.releaseDateLabel)
          shownReleaseDateLabel = savedRow.releaseDateLabel;
      }
      return {
        album: shownAlbum,
        releaseDateLabel: shownReleaseDateLabel,
        tracks: expandedTracks,
        contributors: shownContributors,
        producer: shownProducer,
        albumInfo: shownAlbumInfo,
        wikiUrl,
        savedId: savedRow ? savedRow.id : null,
        downloaded: savedRow ? savedRow.downloaded === 1 : false,
        alternateEdition,
        editions,
        videos: albumVideos,
      };
    },
  }),

  getArtist: defineAction({
    description:
      "Gets an artist profile: the artist's name and photo, bio and info, their catalog albums from both iTunes and Deezer (Deezer-only albums included) ordered newest first by release year — with the explicit edition and the clean edition of the same album listed as separate albums side by side (deluxe editions listed too) whenever the catalogs sell both — top songs (clean and explicit renditions listed separately where both exist), and music videos, plus any albums the user uploaded that AI filed to this artist — those appear in the profile's Albums section. When the artist has a stored AI-created profile (made at upload time), its photo/bio/genre are used first; an uploaded artist with no profile yet gets one created on the spot from the same real sources.",
    request: z.object({
      artistId: z.string().nullable().default(null),
      name: z.string().min(1).max(120),
    }),
    response: z.object({
      name: z.string(),
      genre: z.string().nullable(),
      bio: z.string().nullable(),
      photoUrl: z.string().nullable(),
      backgroundUrl: z.string().nullable(),
      wikiUrl: z.string().nullable(),
      description: z.string().nullable(),
      profileId: z.number().nullable(),
      albums: z.array(albumOut),
      uploadedAlbums: z.array(
        z.object({
          id: z.number(),
          catalogId: z.string(),
          title: z.string(),
          artist: z.string(),
          artworkUrl: z.string().nullable(),
          genre: z.string().nullable(),
          releaseLabel: z.string().nullable(),
          trackCount: z.number(),
          source: z.string(),
        }),
      ),
      videos: z.array(videoOut),
      topTracks: z.array(trackOut),
    }),
    async handler(ctx, args) {
      const q = encodeURIComponent(args.name);
      const [
        lookupJson,
        albumSearchJson,
        songJson,
        videoJson,
        wiki,
        dzMap,
        dzTopMap,
        dzDiscography,
      ] = await Promise.all([
        args.artistId
          ? itunes(
              `lookup?id=${encodeURIComponent(args.artistId)}&entity=album&limit=200&country=US`,
            )
          : Promise.resolve(null),
        itunes(
          `search?term=${q}&media=music&entity=album&attribute=artistTerm&limit=200&country=US`,
        ),
        itunes(
          `search?term=${q}&media=music&entity=song&attribute=artistTerm&limit=50&country=US`,
        ),
        itunes(`search?term=${q}&media=musicVideo&entity=musicVideo&attribute=artistTerm&limit=10&country=US`),
        wikiSummary([
          `${args.name} (musician)`,
          `${args.name} (rapper)`,
          `${args.name} (singer)`,
          args.name,
        ]),
        deezerInfoFor(args.name).catch(() => new Map<string, DzInfo>()),
        deezerArtistTopInfo(args.name).catch(() => new Map<string, DzInfo>()),
        deezerArtistAlbums(args.name).catch(() => [] as AlbumOut[]),
      ]);
      // The artistId a page hands us is not always an iTunes ID: an
      // album page opened from the Deezer-sourced home feed carries a
      // DEEZER artist ID, and an iTunes lookup with it returns zero
      // rows — the profile then wrongly showed "No albums listed"
      // (exactly what happened on Lil Baby's profile, opened from his
      // Deezer FRESH album). So never trust the ID alone: filter every
      // source's albums to this artist by name, prefer the ID lookup
      // when it genuinely returns this artist's albums, retry with the
      // canonical iTunes artist ID when it doesn't, and merge in the
      // by-name album search either way.
      const ownAlbums = (json: Record<string, unknown> | null) =>
        resultsOf(json)
          .filter((r) => r["wrapperType"] === "collection")
          .map(toAlbum)
          .filter((a) => a.title && artistsMatch(a.artist, args.name));
      let albums = ownAlbums(lookupJson);
      // The catalog's own spelling of the name, when the retry below
      // resolves one — so a profile opened as "TI" still titles itself
      // "T.I.", the way the catalog (and the artist) spell it.
      let canonName: string | null = null;
      if (albums.length === 0) {
        const canon = await catalogArtistFor(args.name).catch(() => null);
        if (canon?.name && canon.name !== args.name) canonName = canon.name;
        if (canon?.artistId && canon.artistId !== args.artistId) {
          const canonJson = await itunes(
            `lookup?id=${encodeURIComponent(canon.artistId)}&entity=album&limit=200&country=US`,
          ).catch(() => null);
          albums = ownAlbums(canonJson);
        }
      }
      {
        const seenIds = new Set(albums.map((a) => a.catalogId));
        for (const a of ownAlbums(albumSearchJson)) {
          if (!seenIds.has(a.catalogId)) {
            seenIds.add(a.catalogId);
            albums.push(a);
          }
        }
        // Deezer's discography for this artist joins too: releases
        // that exist only on Deezer (Lil Baby's FRESH and its
        // bonus-track edition) belong on the profile next to the
        // iTunes albums. A Deezer row is dropped only when iTunes
        // already carries the same album (same base title + artist)
        // or the same Deezer album is already in.
        {
          const itunesBaseKeys = new Set(
            albums.map(
              (a) => `${albumBaseKey(a.title)}|${artistKey(a.artist)}`,
            ),
          );
          const dzPushed: AlbumOut[] = [];
          for (const a of dzDiscography) {
            if (seenIds.has(a.catalogId)) continue;
            if (
              itunesBaseKeys.has(
                `${albumBaseKey(a.title)}|${artistKey(a.artist)}`,
              )
            ) {
              continue;
            }
            seenIds.add(a.catalogId);
            albums.push(a);
            dzPushed.push(a);
          }
          // Discography rows carry no track count — fill counts
          // (and any missing dates) from the albums' own details.
          await enrichDeezerAlbumDates(dzPushed, 12);
        }
        // Edition pairing (the user's ask: the explicit album AND the
        // clean version album showing as separate albums, side by
        // side, on every artist's profile). The catalog sells the
        // explicit and clean editions as separate collections with the
        // same title, and the full-catalog fetches above (limit 200)
        // bring both in — but raw catalog order scatters them. Group
        // editions of the same album together (normTitle strips the
        // "(Deluxe)" / "(Explicit)" style tags, so a deluxe edition
        // groups with its standard editions and stays listed too, as
        // its own album), order each group explicit first, then clean,
        // standard editions before deluxe ones — and order the GROUPS
        // newest first, by the newest release date in the group, so
        // the discography runs from this year's albums at the top
        // down to the oldest. The grid renders list order, so paired
        // editions land side by side and the newest album leads.
        const expRank = (a: AlbumOut) =>
          a.explicitness === "explicit" ? 0 : a.explicitness === "clean" ? 1 : 2;
        const deluxeRank = (a: AlbumOut) =>
          /\b(deluxe|expanded)\b/i.test(a.title) ? 1 : 0;
        const groups = new Map<string, AlbumOut[]>();
        for (const a of albums) {
          const k = `${normTitle(a.title)}|${primaryArtistKey(a.artist)}`;
          const g = groups.get(k);
          if (g) g.push(a);
          else groups.set(k, [a]);
        }
        const groupList = [...groups.values()]
          .map((g, gi) => ({
            g,
            gi,
            newest: g.reduce(
              (m, a) => (a.releaseDateIso && a.releaseDateIso > m ? a.releaseDateIso : m),
              "",
            ),
          }))
          .sort((x, y) =>
            x.newest !== y.newest
              ? x.newest > y.newest
                ? -1
                : 1
              : x.gi - y.gi,
          );
        const paired: AlbumOut[] = [];
        for (const { g } of groupList) {
          // Sub-group by the full title (minus explicit/clean tags) so
          // a variant like "Exodus (Instrumentals & Acapellas)" keeps
          // its own explicit→clean pair instead of interleaving into
          // the standard album's pair. Sub-groups keep catalog order,
          // with deluxe/expanded sub-groups after the standard album.
          const subKey = (a: AlbumOut) =>
            a.title
              .toLowerCase()
              .replace(/\((explicit|clean|edited)\)|\[(explicit|clean|edited)\]/gi, " ")
              .replace(/\s+/g, " ")
              .trim();
          const subs = new Map<string, AlbumOut[]>();
          for (const a of g) {
            const k = subKey(a);
            const s = subs.get(k);
            if (s) s.push(a);
            else subs.set(k, [a]);
          }
          const orderedSubs = [...subs.values()].sort(
            (s1, s2) =>
              deluxeRank(s1[0] as AlbumOut) - deluxeRank(s2[0] as AlbumOut),
          );
          for (const s of orderedSubs) {
            paired.push(...[...s].sort((x, y) => expRank(x) - expRank(y)));
          }
        }
        albums = paired.slice(0, 60);
      }
      // Version data for the Top songs: the artist's own Deezer top
      // tracks fill in the explicit renditions a plain name search
      // misses, so clean + explicit rows both show on the profile.
      for (const [k, v] of dzTopMap) {
        if (!dzMap.has(k)) dzMap.set(k, v);
      }
      const genre =
        albums[0]?.genre ??
        strOrNull(resultsOf(songJson)[0]?.["primaryGenreName"]);
      // The user's own uploads filed to this artist: any saved album whose
      // artist matches this profile (by catalog artistId when both have
      // one, otherwise by normalized artist name). These render inside
      // the profile's Albums section alongside the catalog albums.
      const db = ctx.db<typeof schema>();
      const allSaved = await db
        .select()
        .from(schema.savedAlbums)
        .orderBy(desc(schema.savedAlbums.id));
      const catalogIds = new Set(albums.map((a) => a.catalogId));
      const matched = allSaved.filter((a) => {
        if (catalogIds.has(a.catalogId)) return false;
        if (
          args.artistId &&
          a.artistId &&
          String(a.artistId) === String(args.artistId)
        )
          return true;
        return artistsMatch(a.artist, args.name);
      });
      const uploadedAlbums = [];
      for (const a of matched) {
        const tracks = await db
          .select()
          .from(schema.savedTracks)
          .where(eq(schema.savedTracks.albumId, a.id));
        uploadedAlbums.push({
          id: a.id,
          catalogId: a.catalogId,
          title: a.title,
          artist: a.artist,
          artworkUrl: await albumArtwork(ctx, a),
          genre: a.genre,
          releaseLabel: a.releaseLabel,
          trackCount: tracks.length,
          source: a.source,
        });
      }
      // Stored AI-created profile (made when an album was uploaded):
      // its name/photo/bio lead. An uploaded artist without one gets it
      // created now, from the same real sources.
      let profile: ProfileRow | null = null;
      const key = artistKey(args.name);
      if (key) {
        const rows = await db
          .select()
          .from(schema.artistProfiles)
          .where(eq(schema.artistProfiles.artistKey, key))
          .limit(1);
        profile = rows[0] ?? null;
        if (!profile && uploadedAlbums.length > 0) {
          profile = await ensureArtistProfile(ctx, args.name, args.artistId).catch(
            () => null,
          );
        }
      }
      let profilePhoto = profile?.photoUrl ?? null;
      if (profile?.photoBlobKey) {
        try {
          profilePhoto = await ctx.blobs.getUrl(profile.photoBlobKey);
        } catch {
          profilePhoto = profile?.photoUrl ?? null;
        }
      }
      // The page's background picture: the profile's own background
      // (uploaded by the user, or the artist's photo the AI found when
      // it created the profile), falling back to the artist photo.
      let backgroundUrl = profile?.backgroundUrl ?? null;
      if (profile?.backgroundBlobKey) {
        try {
          backgroundUrl = await ctx.blobs.getUrl(profile.backgroundBlobKey);
        } catch {
          backgroundUrl = profile?.backgroundUrl ?? null;
        }
      }
      return {
        name: profile?.name ?? canonName ?? args.name,
        genre: profile?.genre ?? genre,
        bio: profile?.bio ?? wiki?.extract ?? null,
        photoUrl: profilePhoto ?? wiki?.photo ?? null,
        backgroundUrl: backgroundUrl ?? profilePhoto ?? wiki?.photo ?? null,
        wikiUrl: profile?.wikiUrl ?? wiki?.url ?? null,
        description: profile?.description ?? wiki?.description ?? null,
        profileId: profile?.id ?? null,
        albums,
        uploadedAlbums,
        videos: resultsOf(videoJson).map(toVideo).filter((v) => v.title),
        // Top songs lead with the artist's OWN songs: an artistTerm
        // search also returns other artists' songs that merely feature
        // (or name-check) this artist, and at a small limit those
        // crowded out the artist's own hits entirely.
        topTracks: expandVersions(
          (() => {
            const all = resultsOf(songJson)
              .map(toTrack)
              .filter((t) => t.title);
            const own = all.filter((t) => artistsMatch(t.artist, args.name));
            const rest = all.filter((t) => !artistsMatch(t.artist, args.name));
            return [...own, ...rest].slice(0, 14);
          })(),
          dzMap,
        ),
      };
    },
  }),

  findCovers: defineAction({
    description:
      "AI cover search: finds real album-cover candidates for a title + artist from the catalog so the user can pick one and attach it.",
    request: z.object({
      title: z.string().min(1).max(160),
      artist: z.string().max(160).default(""),
    }),
    response: z.object({
      covers: z.array(
        z.object({ url: z.string(), source: z.string(), albumTitle: z.string() }),
      ),
    }),
    async handler(_ctx, args) {
      const q = encodeURIComponent(`${args.artist} ${args.title}`.trim());
      const [it, dz] = await Promise.all([
        itunes(`search?term=${q}&media=music&entity=album&limit=8&country=US`),
        fetchJson(`https://api.deezer.com/search/album?q=${q}&limit=8`),
      ]);
      const covers: { url: string; source: string; albumTitle: string }[] = [];
      const seen = new Set<string>();
      for (const r of resultsOf(it)) {
        const u = bigArt(strOrNull(r["artworkUrl100"]));
        if (u && !seen.has(u)) {
          seen.add(u);
          covers.push({ url: u, source: "Apple Music catalog", albumTitle: str(r["collectionName"]) });
        }
      }
      const dzData = dz?.["data"];
      if (Array.isArray(dzData)) {
        for (const r of dzData as Raw[]) {
          const u = strOrNull(r["cover_xl"]) ?? strOrNull(r["cover_big"]);
          if (u && !seen.has(u)) {
            seen.add(u);
            covers.push({ url: u, source: "Deezer catalog", albumTitle: str(r["title"]) });
          }
        }
      }
      return { covers: covers.slice(0, 10) };
    },
  }),

  aiFillAlbum: defineAction({
    description:
      "AI album fill: finds the album in the catalog and saves it into the library complete with cover, info, and the full tracklist with playable previews.",
    request: z.object({
      artistName: z.string().min(1).max(160),
      albumTitle: z.string().min(1).max(200),
    }),
    response: z.object({
      savedId: z.number(),
      catalogId: z.string(),
      title: z.string(),
      trackCount: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const q = encodeURIComponent(`${args.artistName} ${args.albumTitle}`);
      const search = await itunes(`search?term=${q}&media=music&entity=album&limit=5&country=US`);
      const candidates = resultsOf(search).map(toAlbum).filter((a) => a.title);
      const titleLc = args.albumTitle.toLowerCase();
      const match =
        candidates.find((a) => a.title.toLowerCase().includes(titleLc)) ??
        candidates[0];
      if (!match) {
        throw new Error(
          `Could not find "${args.albumTitle}" by ${args.artistName} in the catalog. Check the spelling and try again.`,
        );
      }
      const existing = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.catalogId, match.catalogId))
        .limit(1);
      if (existing[0]) {
        // An uploaded full copy of the same album (title + artist)
        // outranks this catalog copy — report the full copy instead.
        const matches0 = await libraryAlbumMatches(
          ctx,
          existing[0].title,
          existing[0].artist,
        );
        const keep0 = await preferredLibraryCopy(ctx, matches0);
        const chosen = keep0 ?? existing[0];
        const count = await db
          .select()
          .from(schema.savedTracks)
          .where(eq(schema.savedTracks.albumId, chosen.id));
        return {
          savedId: chosen.id,
          catalogId: chosen.catalogId,
          title: chosen.title,
          trackCount: count.length,
        };
      }
      // Duplicate prevention: same title + artist already in the
      // library under a different catalog id (e.g. the user's uploaded
      // full copy) — keep that copy, don't fill a second one.
      const dupMatches = await libraryAlbumMatches(ctx, match.title, match.artist);
      if (dupMatches.length > 0) {
        const keep = await preferredLibraryCopy(ctx, dupMatches);
        if (keep) {
          const count = await db
            .select()
            .from(schema.savedTracks)
            .where(eq(schema.savedTracks.albumId, keep.id));
          return {
            savedId: keep.id,
            catalogId: keep.catalogId,
            title: keep.title,
            trackCount: count.length,
          };
        }
      }
      const lookup = await itunes(
        `lookup?id=${encodeURIComponent(match.catalogId)}&entity=song&country=US`,
      );
      const lookupRows = resultsOf(lookup);
      const collRow = lookupRows.find((r) => r["wrapperType"] === "collection");
      const trackRows = lookupRows
        .filter((r) => r["kind"] === "song")
        .sort(
          (a, b) =>
            (num(a["discNumber"]) || 1) - (num(b["discNumber"]) || 1) ||
            num(a["trackNumber"]) - num(b["trackNumber"]),
        )
        .map(toTrack);
      const inserted = await db
        .insert(schema.savedAlbums)
        .values({
          catalogId: match.catalogId,
          title: match.title,
          artist: match.artist,
          artistId: match.artistId,
          artworkUrl: match.artworkUrl,
          genre: match.genre,
          releaseLabel: match.releaseLabel,
          releaseDateLabel: fullDate(strOrNull(collRow?.["releaseDate"])),
          source: "catalog",
          downloaded: 0,
        })
        .returning({ id: schema.savedAlbums.id });
      const albumRow = inserted[0];
      if (!albumRow) throw new Error("aiFillAlbum: insert returned no rows");
      if (trackRows.length > 0) {
        await db.insert(schema.savedTracks).values(
          trackRows.map((t) => ({
            albumId: albumRow.id,
            catalogTrackId: null,
            title: t.title,
            artist: t.artist,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
            durationMs: t.durationMs,
            previewUrl: t.previewUrl,
            artworkUrl: t.artworkUrl,
          })),
        );
      }
      ctx.invalidateQueries();
      return {
        savedId: albumRow.id,
        catalogId: match.catalogId,
        title: match.title,
        trackCount: trackRows.length,
      };
    },
  }),

  humSearch: defineAction({
    description:
      "Hum-to-search: takes the melody notes hummed into the mic (plus an optional typed description), identifies candidate songs from the melody's shape, verifies each against the live internet catalog (iTunes, with Deezer preview fallback), and returns the real playable matches.",
    request: z.object({
      notes: z.array(z.number().int().min(0).max(127)).max(64),
      description: z.string().max(300).default(""),
    }),
    response: z.object({
      matches: z.array(trackOut),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const description = args.description.trim();
      // The melody with held/repeated notes collapsed — the shape the
      // matcher works on. Steps are relative to the first note, so the
      // key the user happened to hum in doesn't matter.
      const melody: number[] = [];
      for (const n of args.notes) {
        if (melody.length === 0 || melody[melody.length - 1] !== n) {
          melody.push(n);
        }
      }
      const first = melody[0] ?? 0;
      const steps = melody.map((n) => n - first);
      const noteNames = melody.map(
        (n) =>
          `${HUM_NOTE_NAMES[n % 12] ?? "?"}${Math.floor(n / 12) - 1}`,
      );
      const contourParts: string[] = [];
      for (let i = 1; i < melody.length; i++) {
        const d = (melody[i] ?? 0) - (melody[i - 1] ?? 0);
        if (d > 0) contourParts.push(d >= 5 ? `leaps up ${d}` : `up ${d}`);
        else if (d < 0)
          contourParts.push(d <= -5 ? `leaps down ${-d}` : `down ${-d}`);
      }
      const contour = contourParts.join(", ");

      const seenTracks = new Set<string>();
      const matches: TrackOut[] = [];
      const collect = (rows: TrackOut[]) => {
        for (const t of rows) {
          const key =
            `${normTitle(t.title)}|${primaryArtistKey(t.artist)}|${t.explicitness}`.toLowerCase();
          if (t.previewUrl && !seenTracks.has(key)) {
            seenTracks.add(key);
            matches.push(t);
          }
        }
      };
      const verifyAll = async (candidates: HumCandidate[]) => {
        const fresh = candidates.filter((c) => c.title.trim());
        if (fresh.length === 0) return;
        // Verify every candidate against the catalog IN PARALLEL and
        // collect in candidate order — verifying one by one made the
        // user wait on a dozen sequential round trips before the song
        // could pop up.
        const rowsList = await Promise.all(
          fresh.map((c) => humVerifyCandidate(c).catch(() => [] as TrackOut[])),
        );
        for (const rows of rowsList) {
          if (matches.length >= 10) break;
          collect(rows);
        }
      };

      const tried = new Set<string>();
      let inferenceWorked = false;

      // The matcher call fails intermittently (a malformed answer, a
      // timeout, a brief rate-limit window), which used to surface to
      // the user as "no match" for a perfectly good hum — so each pass
      // retries before the search gives up on it. Backoffs stay short:
      // the user is staring at a "Searching…" button, and the common
      // case (first attempt works) never waits at all.
      const inferCandidates = async (
        prompt: string,
      ): Promise<HumCandidate[] | null> => {
        const backoffMs = [0, 400, 1000];
        for (let attempt = 0; attempt < backoffMs.length; attempt++) {
          const wait = backoffMs[attempt] ?? 0;
          if (wait > 0) {
            await new Promise((resolve) => setTimeout(resolve, wait));
          }
          try {
            const out = await ctx.inference.complete(prompt, {
              schema: humCandidateList,
            });
            return out.candidates;
          } catch {
            // fall through to the next retry
          }
        }
        return null;
      };
      const freshCandidates = (list: HumCandidate[]): HumCandidate[] =>
        list.slice(0, 6).filter((c) => {
          const k = `${normTitle(c.title)}|${artistKey(c.artist)}`;
          if (!c.title.trim() || tried.has(k)) return false;
          tried.add(k);
          return true;
        });

      // Pass 1: identify from the full melodic shape.
      if (melody.length >= 3 || description) {
        const named = await inferCandidates(
          `A user is using hum-to-search in a music app: they hummed a melody they remember into the microphone, and they want the song found on the internet so it pops up in the app and they can play it.

The melody the app heard, as note names in order (held notes collapsed): ${noteNames.length > 0 ? noteNames.join(" ") : "(no notes captured)"}
The same melody as steps in semitones from the first note (0 = the starting note, positive = higher, negative = lower): [${steps.join(", ")}]
The melodic contour: ${contour || "(too short to tell)"}
The user also described the song as: "${description || "(no description)"}"

Name the songs this could be. Match the SHAPE of the melody — the pattern of rises, falls, leaps and repeated notes — not the exact pitches: people hum in any key, sing a few notes off, and the detector can mishear an occasional note. Favour extremely well-known songs (big hits, famous hooks, standards) whose best-known melody follows this shape. When the description names a genre, era, singer or lyric fragment, weight it heavily. Return up to 6 candidates, most likely first.`,
        );
        if (named) {
          inferenceWorked = true;
          await verifyAll(freshCandidates(named));
        }
      }

      // Pass 2: contour-only retry with a wider net when the first pass
      // verified fewer than two songs.
      if (matches.length < 2 && melody.length >= 4) {
        const triedList = [...tried]
          .map((k) => k.split("|")[0] ?? k)
          .filter(Boolean)
          .join("; ");
        const named = await inferCandidates(
          `Second attempt at naming a tune a user hummed into a music app. Ignore the exact intervals this time and match ONLY the up/down contour and the number of notes.

Number of notes in the melody (held notes collapsed): ${melody.length}
Contour: ${contour}
Steps in semitones from the first note: [${steps.join(", ")}]
The user described the song as: "${description || "(no description)"}"

List very famous songs from ANY era or genre — pop, rock, R&B, hip-hop hooks, soul, country, standards, hymns, TV and film themes, children's songs — whose famous melody follows this contour. Do not repeat these already-tried songs: ${triedList || "(none)"}. Return up to 6 candidates, most likely first.`,
        );
        if (named) {
          inferenceWorked = true;
          await verifyAll(freshCandidates(named));
        }
      }

      // Last resort: if the matcher named nothing usable but the user
      // described the song, search the catalog for the description
      // itself (a plain internet catalog search, clearly labeled).
      let usedDescriptionSearch = false;
      if (matches.length === 0 && description) {
        usedDescriptionSearch = true;
        const json = await itunes(
          `search?term=${encodeURIComponent(description)}&media=music&entity=song&limit=8&country=US`,
        );
        const rows = resultsOf(json)
          .map(toTrack)
          .filter((t) => t.title && t.previewUrl);
        if (rows.length > 0) {
          const dz = await deezerInfoFor(description, 10).catch(
            () => new Map<string, DzInfo>(),
          );
          collect(expandVersions(rows.slice(0, 4), dz));
        }
      }

      let note: string;
      if (matches.length > 0 && usedDescriptionSearch) {
        note =
          "I couldn't pin the melody itself down, but these catalog songs match your description — tap one to play it.";
      } else if (matches.length > 0) {
        note =
          "Found these for your hum — tap one to play it and check if it's your song.";
      } else if (melody.length > 0 && melody.length < 4 && !description) {
        note =
          "I only caught a few notes from that hum, so there wasn't enough melody to search with. Hum a longer stretch — the chorus works best — or add anything you remember about the song below.";
      } else if (!inferenceWorked && !description) {
        note =
          "The song matcher couldn't run just now. Add anything you remember about the song below — a singer, a genre, a word from the lyrics — and search again.";
      } else {
        note =
          "Couldn't pin that hum to a song in the catalog this time. Try humming the chorus a little slower, or add anything you remember — a singer, a genre, a word from the lyrics — and search again.";
      }
      return { matches: matches.slice(0, 10), note };
    },
  }),

  suggest: defineAction({
    description:
      "First-letter search suggestions: given even a single typed letter, returns catalog artists, albums, songs and music videos whose names/titles begin with the text (whole name or any word in it) or whose artist's name contains the text, plus matching artists, albums and songs from the user's own library — fast enough to refresh on every keystroke.",
    request: z.object({ query: z.string().min(1).max(60) }),
    response: z.object({
      artists: z.array(artistOut),
      albums: z.array(albumOut),
      songs: z.array(trackOut),
      videos: z.array(videoOut),
      libraryMatches: z.object({
        albums: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            artist: z.string(),
            artworkUrl: z.string().nullable(),
          }),
        ),
        artists: z.array(z.string()),
        tracks: z.array(
          z.object({
            id: z.number(),
            title: z.string(),
            artist: z.string(),
            artworkUrl: z.string().nullable(),
            previewUrl: z.string().nullable(),
            durationMs: z.number(),
          }),
        ),
      }),
    }),
    async handler(ctx, args) {
      const qRaw = args.query.trim();
      const q = encodeURIComponent(qRaw);
      const [artistJson, albumJson, songJson, videoJson, dzSuggestAlbums] =
        await Promise.all([
          itunes(
            `search?term=${q}&media=music&entity=musicArtist&limit=12&country=US`,
          ),
          itunes(
            `search?term=${q}&media=music&entity=album&limit=12&country=US`,
          ),
          itunes(
            `search?term=${q}&media=music&entity=song&limit=12&country=US`,
          ),
          itunes(
            `search?term=${q}&media=musicVideo&entity=musicVideo&limit=12&country=US`,
          ),
          deezerAlbumSearch(qRaw, 25).catch(() => [] as AlbumOut[]),
        ]);
      const qn = normTitle(qRaw);
      // Squashed (space-free) forms so dotted initials match a typed
      // query without dots: "T.I." normalizes to "t i", which neither
      // starts with nor contains a word starting with "ti" — squashed,
      // "ti" starts with "ti" and the artist surfaces as expected.
      const qSquash = qn.replace(/ /g, "");
      // 0 = the whole name/title starts with the text, 1 = a word in it
      // does, -1 = doesn't begin with it at all.
      const begins = (name: string): number => {
        const n = normTitle(name);
        if (!n || !qn) return -1;
        if (n.startsWith(qn)) return 0;
        if (qSquash && n.replace(/ /g, "").startsWith(qSquash)) return 0;
        if (n.split(" ").some((w) => w.startsWith(qn))) return 1;
        return -1;
      };
      // Tier 2: the artist's name contains the typed text at all —
      // typing "j" surfaces Juvenile's songs even when neither the
      // song title nor a word in it starts with J.
      const artistHas = (artist: string): boolean => {
        const n = normTitle(artist);
        if (!n || !qn) return false;
        if (n.includes(qn)) return true;
        if (qSquash && n.replace(/ /g, "").includes(qSquash)) return true;
        return false;
      };
      const pick = <T,>(
        rows: T[],
        nameOf: (r: T) => string,
        cap: number,
        artistOf?: (r: T) => string,
      ): T[] =>
        rows
          .map((r) => {
            let s = begins(nameOf(r));
            if (s < 0 && artistOf && artistHas(artistOf(r))) s = 2;
            return { r, s };
          })
          .filter((x) => x.s >= 0)
          .sort((a, b) => a.s - b.s)
          .slice(0, cap)
          .map((x) => x.r);
      const seenArtists = new Set<string>();
      const artists = pick(
        resultsOf(artistJson).map((r) => ({
          name: str(r["artistName"]),
          artistId: r["artistId"] != null ? String(r["artistId"]) : null,
          genre: strOrNull(r["primaryGenreName"]),
          artworkUrl: null as string | null,
        })),
        (a) => a.name,
        8,
        (a) => a.name,
      ).filter((a) => {
        const k = artistKey(a.name);
        if (!a.name || seenArtists.has(k)) return false;
        seenArtists.add(k);
        return true;
      }).slice(0, 4);
      // Deezer-only albums (Lil Baby's FRESH) join the dropdown too,
      // unless iTunes already carries the same album; the picked few
      // then run newest first like every other album list. Deezer
      // search rows carry no release date, so fill dates in first —
      // an undated album would sort last and fall out of the pick.
      await enrichDeezerAlbumDates(dzSuggestAlbums);
      const itunesSuggestAlbums = resultsOf(albumJson).map(toAlbum);
      const itunesSuggestKeys = new Set(
        itunesSuggestAlbums.map(
          (a) => `${albumBaseKey(a.title)}|${artistKey(a.artist)}`,
        ),
      );
      // Newest first BEFORE the pick caps the list: the pick keeps
      // its match tiers, and inside a tier the stable order is the
      // order given — so a 2026 album beats older same-tier matches
      // for the few dropdown slots instead of losing to them.
      const albums = sortAlbumsNewestFirst(
        pick(
          sortAlbumsNewestFirst([
            ...itunesSuggestAlbums,
            ...dzSuggestAlbums.filter(
              (a) =>
                !itunesSuggestKeys.has(
                  `${albumBaseKey(a.title)}|${artistKey(a.artist)}`,
                ),
            ),
          ]),
          (a) => a.title,
          4,
          (a) => a.artist,
        ),
      );
      const songs = pick(
        resultsOf(songJson)
          .map(toTrack)
          .filter((t) => t.previewUrl),
        (t) => t.title,
        4,
        (t) => t.artist,
      );
      const videos = pick(
        resultsOf(videoJson).map(toVideo),
        (v) => v.title,
        3,
        (v) => v.artist,
      );
      // The user's own library, matched by the same rule: title or
      // artist begins with the text, or the artist's name contains it.
      const libScore = (title: string, artist: string): number => {
        const cands = [begins(title), begins(artist)].filter((x) => x >= 0);
        if (artistHas(artist)) cands.push(2);
        return cands.length > 0 ? Math.min(...cands) : 9;
      };
      const db = ctx.db<typeof schema>();
      const savedAlbums = await db.select().from(schema.savedAlbums);
      const libAlbumRows = savedAlbums
        .map((a) => ({ a, s: libScore(a.title, a.artist) }))
        .filter((x) => x.s <= 2)
        .sort((x, y) => x.s - y.s)
        .slice(0, 3);
      const libAlbums = await Promise.all(
        libAlbumRows.map(async (x) => ({
          id: x.a.id,
          title: x.a.title,
          artist: x.a.artist,
          artworkUrl: await albumArtwork(ctx, x.a),
        })),
      );
      const libArtists = [
        ...new Set(
          savedAlbums
            .filter((a) => begins(a.artist) >= 0 || artistHas(a.artist))
            .map((a) => a.artist),
        ),
      ].slice(0, 3);
      // The library's own songs too, so an uploaded song pops up in
      // the dropdown and plays straight from it.
      const savedTracks = await db.select().from(schema.savedTracks);
      const albumById = new Map(savedAlbums.map((a) => [a.id, a]));
      const libTrackRows = savedTracks
        .map((t) => ({ t, s: libScore(t.title, t.artist) }))
        .filter((x) => x.s <= 2)
        .sort((x, y) => x.s - y.s)
        .slice(0, 4);
      const libTracks = await Promise.all(
        libTrackRows.map(async (x) => {
          const alb =
            x.t.albumId != null ? albumById.get(x.t.albumId) : undefined;
          return {
            id: x.t.id,
            title: x.t.title,
            artist: x.t.artist,
            artworkUrl:
              x.t.artworkUrl ?? (alb ? await albumArtwork(ctx, alb) : null),
            previewUrl: x.t.previewUrl,
            durationMs: x.t.durationMs,
          };
        }),
      );
      return {
        artists,
        albums,
        songs,
        videos,
        libraryMatches: {
          albums: libAlbums,
          artists: libArtists,
          tracks: libTracks,
        },
      };
    },
  }),

  podcastCharts: defineAction({
    description:
      "Trending podcasts from Apple's public podcast charts (US Top Podcasts RSS): each show's cover, title, host and genre, plus its latest episode's title and date — what fills the Podcasts tab when it opens, before any search. No account or key needed.",
    request: z.object({}),
    response: z.object({
      shows: z.array(
        z.object({
          collectionId: z.string(),
          title: z.string(),
          host: z.string(),
          artworkUrl: z.string().nullable(),
          genre: z.string().nullable(),
          latestEpisodeTitle: z.string().nullable(),
          latestEpisodeDate: z.string().nullable(),
        }),
      ),
    }),
    async handler() {
      const json = await fetchJson(
        "https://rss.marketingtools.apple.com/api/v2/us/podcasts/top/15/podcasts.json",
      );
      const feed = (json?.["feed"] ?? null) as Record<string, unknown> | null;
      const results = (feed?.["results"] ?? []) as Record<string, unknown>[];
      const base = results
        .map((r) => {
          const genres = (r["genres"] ?? []) as Record<string, unknown>[];
          return {
            collectionId: str(r["id"]),
            title: str(r["name"]),
            host: str(r["artistName"]),
            artworkUrl: strOrNull(r["artworkUrl100"])?.replace(/100x100bb\.(jpg|png|jpeg)/, "600x600bb.$1") ?? null,
            genre: genres[0] ? strOrNull(genres[0]["name"]) : null,
          };
        })
        .filter((s) => s.collectionId && s.title);
      // Each show's latest episode, from the same public iTunes
      // lookup the episodes page uses — in parallel, best-effort.
      const shows = await Promise.all(
        base.map(async (s) => {
          let latestEpisodeTitle: string | null = null;
          let latestEpisodeDate: string | null = null;
          try {
            const lookup = await itunes(
              `lookup?id=${encodeURIComponent(s.collectionId)}&media=podcast&entity=podcastEpisode&limit=2&country=US`,
            );
            const ep = resultsOf(lookup).find(
              (r) => r["kind"] === "podcast-episode",
            );
            if (ep) {
              latestEpisodeTitle = strOrNull(ep["trackName"]);
              latestEpisodeDate = fullDate(strOrNull(ep["releaseDate"]));
            }
          } catch {
            // The show still lists without its latest episode.
          }
          return { ...s, latestEpisodeTitle, latestEpisodeDate };
        }),
      );
      return { shows };
    },
  }),

  searchPodcasts: defineAction({
    description:
      "Searches podcasts by show name or topic on the public iTunes podcast catalog (no account or key): matching shows with cover, title, host, genre and episode count. Podcasts live in their own section, never mixed into music results.",
    request: z.object({ query: z.string().min(1).max(120) }),
    response: z.object({
      shows: z.array(
        z.object({
          collectionId: z.string(),
          title: z.string(),
          host: z.string(),
          artworkUrl: z.string().nullable(),
          genre: z.string().nullable(),
          episodeCount: z.number().nullable(),
        }),
      ),
    }),
    async handler(_ctx, args) {
      const json = await itunes(
        `search?term=${encodeURIComponent(args.query.trim())}&media=podcast&entity=podcast&limit=24&country=US`,
      );
      const shows = resultsOf(json)
        .map((r) => ({
          collectionId: r["collectionId"] != null ? String(r["collectionId"]) : "",
          title: str(r["collectionName"]),
          host: str(r["artistName"]),
          artworkUrl:
            strOrNull(r["artworkUrl100"])?.replace(/100x100bb\.(jpg|png|jpeg)/, "600x600bb.$1") ?? null,
          genre: strOrNull(r["primaryGenreName"]),
          episodeCount:
            typeof r["trackCount"] === "number" ? r["trackCount"] : null,
        }))
        .filter((s) => s.collectionId && s.title);
      return { shows };
    },
  }),

  getPodcastEpisodes: defineAction({
    description:
      "One podcast show's episodes from the public iTunes podcast catalog: title, release date, length and the episode's own audio file URL for each episode, newest first, plus the show's title/host/cover. Episodes play in full in the app's player.",
    request: z.object({ collectionId: z.string().min(1).max(40) }),
    response: z.object({
      show: z.object({
        title: z.string(),
        host: z.string(),
        artworkUrl: z.string().nullable(),
        genre: z.string().nullable(),
      }),
      episodes: z.array(
        z.object({
          episodeId: z.string(),
          title: z.string(),
          dateLabel: z.string().nullable(),
          durationMs: z.number(),
          audioUrl: z.string(),
          description: z.string().nullable(),
        }),
      ),
    }),
    async handler(_ctx, args) {
      const json = await itunes(
        `lookup?id=${encodeURIComponent(args.collectionId)}&media=podcast&entity=podcastEpisode&limit=100&country=US`,
      );
      const rows = resultsOf(json);
      const head = rows.find((r) => r["kind"] === "podcast") ?? rows[0];
      const show = {
        title: head ? str(head["collectionName"]) : "",
        host: head ? str(head["artistName"]) : "",
        artworkUrl:
          (head ? strOrNull(head["artworkUrl600"]) : null) ??
          (head
            ? strOrNull(head["artworkUrl100"])?.replace(/100x100bb\.(jpg|png|jpeg)/, "600x600bb.$1") ?? null
            : null),
        genre: head ? strOrNull(head["primaryGenreName"]) : null,
      };
      const strip = (s: string | null): string | null => {
        if (!s) return null;
        const t = s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        return t ? t.slice(0, 400) : null;
      };
      const episodes = rows
        .filter((r) => r["kind"] === "podcast-episode")
        .map((r) => ({
          episodeId: r["trackId"] != null ? String(r["trackId"]) : "",
          title: str(r["trackName"]),
          dateLabel: fullDate(strOrNull(r["releaseDate"])),
          durationMs: num(r["trackTimeMillis"]),
          audioUrl: str(r["episodeUrl"] ?? r["previewUrl"]),
          description: strip(
            strOrNull(r["shortDescription"]) ?? strOrNull(r["description"]),
          ),
        }))
        .filter((e) => e.episodeId && e.title && e.audioUrl);
      return { show, episodes };
    },
  }),

  audiobookHome: defineAction({
    description:
      "Free public-domain audiobooks from LibriVox to fill the Audiobooks tab when it opens: real books with author, total length and chapter counts, each playable in full from its LibriVox chapters. No account or key needed.",
    request: z.object({}),
    response: z.object({
      books: z.array(
        z.object({
          source: z.literal("librivox"),
          id: z.string(),
          title: z.string(),
          author: z.string(),
          artworkUrl: z.string().nullable(),
          durationMs: z.number(),
          chapterCount: z.number().nullable(),
          description: z.string().nullable(),
          previewUrl: z.string().nullable(),
        }),
      ),
    }),
    async handler() {
      const json = await fetchJson(
        "https://librivox.org/api/feed/audiobooks?format=json&limit=12&extended=1",
      );
      return { books: parseLibrivoxBooks(json) };
    },
  }),

  searchAudiobooks: defineAction({
    description:
      "Searches audiobooks by title or author in two places: LibriVox (free public-domain books that play in full, chapter by chapter) and the iTunes audiobook catalog (commercial books — only their official preview plays here, labeled as such). Audiobooks live in their own section, never mixed into music.",
    request: z.object({ query: z.string().min(1).max(120) }),
    response: z.object({
      books: z.array(
        z.object({
          source: z.enum(["librivox", "itunes"]),
          id: z.string(),
          title: z.string(),
          author: z.string(),
          artworkUrl: z.string().nullable(),
          durationMs: z.number(),
          chapterCount: z.number().nullable(),
          description: z.string().nullable(),
          previewUrl: z.string().nullable(),
        }),
      ),
    }),
    async handler(_ctx, args) {
      const q = encodeURIComponent(args.query.trim());
      const [byTitle, byAuthor, itunesJson] = await Promise.all([
        fetchJson(
          `https://librivox.org/api/feed/audiobooks?title=${q}&format=json&limit=10&extended=1`,
        ),
        fetchJson(
          `https://librivox.org/api/feed/audiobooks?author=${q}&format=json&limit=10&extended=1`,
        ),
        itunes(
          `search?term=${q}&media=audiobook&entity=audiobook&limit=12&country=US`,
        ),
      ]);
      const seen = new Set<string>();
      const lv = [...parseLibrivoxBooks(byTitle), ...parseLibrivoxBooks(byAuthor)]
        .filter((b) => {
          if (seen.has(b.id)) return false;
          seen.add(b.id);
          return true;
        })
        .slice(0, 12);
      const it = resultsOf(itunesJson)
        .map((r) => ({
          source: "itunes" as const,
          id: r["collectionId"] != null ? String(r["collectionId"]) : "",
          title: str(r["collectionName"]),
          author: str(r["artistName"]),
          artworkUrl:
            strOrNull(r["artworkUrl100"])?.replace(/100x100bb\.(jpg|png|jpeg)/, "600x600bb.$1") ?? null,
          durationMs: num(r["trackTimeMillis"]),
          chapterCount: null,
          description: null,
          previewUrl: strOrNull(r["previewUrl"]),
        }))
        .filter((b) => b.id && b.title);
      return { books: [...lv, ...it] };
    },
  }),

  getLibrivoxChapters: defineAction({
    description:
      "The chapters of a LibriVox audiobook: each chapter's title, length and its free archive.org audio file, in book order, ready to play in full in the app's player.",
    request: z.object({ projectId: z.string().min(1).max(20) }),
    response: z.object({
      chapters: z.array(
        z.object({
          chapterId: z.string(),
          number: z.number(),
          title: z.string(),
          audioUrl: z.string(),
          durationMs: z.number(),
        }),
      ),
    }),
    async handler(_ctx, args) {
      const json = await fetchJson(
        `https://librivox.org/api/feed/audiotracks?project_id=${encodeURIComponent(args.projectId)}&format=json`,
      );
      const sections = (json?.["sections"] ?? []) as Record<string, unknown>[];
      const chapters = sections
        .map((s) => ({
          chapterId: s["id"] != null ? String(s["id"]) : "",
          number:
            typeof s["section_number"] === "number"
              ? s["section_number"]
              : Number(s["section_number"]) || 0,
          title: str(s["title"]),
          audioUrl: str(s["listen_url"]),
          durationMs:
            (typeof s["playtime"] === "number"
              ? s["playtime"]
              : Number(s["playtime"]) || 0) * 1000,
        }))
        .filter((c) => c.chapterId && c.title && c.audioUrl)
        .sort((a, b) => a.number - b.number);
      return { chapters };
    },
  }),

  createUploadedBook: defineAction({
    description:
      "Creates an audiobook in the user's own audiobooks (Audiobooks tab) for chapter files they're about to upload — the book plays in full in the app, like uploaded music, and stays out of the music library.",
    request: z.object({
      title: z.string().min(1).max(200),
      author: z.string().min(1).max(200),
    }),
    response: z.object({ bookId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.uploadedBooks)
        .values({ title: args.title.trim(), author: args.author.trim() })
        .returning({ id: schema.uploadedBooks.id });
      const row = inserted[0];
      if (!row) throw new Error("createUploadedBook: insert returned no rows");
      ctx.invalidateQueries();
      return { bookId: row.id };
    },
  }),

  uploadBookChapter: defineAction({
    description:
      "Uploads one chapter audio file for one of the user's own audiobooks, stored as an owned blob that plays in full in the app's player.",
    request: z.object({
      bookId: z.number().int().positive(),
      title: z.string().min(1).max(300),
      chapterNumber: z.number().int().min(0).max(999),
      fileName: z.string().min(1).max(300),
      dataBase64: z.string().min(10).max(64_000_000),
      mimeType: z.string().max(100),
    }),
    response: z.object({ chapterId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const books = await db
        .select()
        .from(schema.uploadedBooks)
        .where(eq(schema.uploadedBooks.id, args.bookId))
        .limit(1);
      if (!books[0]) throw new Error("That audiobook isn't in your books anymore.");
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.length === 0) throw new Error("That chapter file looks empty.");
      if (bytes.length > 48 * 1024 * 1024) {
        throw new Error("Chapter files are capped at 48 MB in the app.");
      }
      const key = `book-chapter/${args.bookId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await ctx.blobs.put(key, bytes, {
        contentType: args.mimeType || "audio/mpeg",
      });
      const inserted = await db
        .insert(schema.uploadedBookChapters)
        .values({
          bookId: args.bookId,
          title: args.title.trim(),
          chapterNumber: args.chapterNumber,
          blobKey: key,
          fileName: args.fileName,
        })
        .returning({ id: schema.uploadedBookChapters.id });
      const row = inserted[0];
      if (!row) throw new Error("uploadBookChapter: insert returned no rows");
      ctx.invalidateQueries();
      return { chapterId: row.id };
    },
  }),

  listUploadedBooks: defineAction({
    description:
      "Lists the user's own uploaded audiobooks with their chapters in order, for the Audiobooks tab's 'Your audiobooks' section.",
    request: z.object({}),
    response: z.object({
      books: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          author: z.string(),
          chapters: z.array(
            z.object({
              id: z.number(),
              title: z.string(),
              chapterNumber: z.number(),
              durationMs: z.number(),
              fileName: z.string().nullable(),
            }),
          ),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const bookRows = await db
        .select()
        .from(schema.uploadedBooks)
        .orderBy(desc(schema.uploadedBooks.id));
      const books = [];
      for (const b of bookRows) {
        const chapters = await db
          .select()
          .from(schema.uploadedBookChapters)
          .where(eq(schema.uploadedBookChapters.bookId, b.id))
          .orderBy(
            asc(schema.uploadedBookChapters.chapterNumber),
            asc(schema.uploadedBookChapters.id),
          );
        books.push({
          id: b.id,
          title: b.title,
          author: b.author,
          chapters: chapters.map((c) => ({
            id: c.id,
            title: c.title,
            chapterNumber: c.chapterNumber,
            durationMs: c.durationMs,
            fileName: c.fileName,
          })),
        });
      }
      return { books };
    },
  }),

  getBookChapterPlayback: defineAction({
    description:
      "Returns a playable URL for an uploaded audiobook chapter's full file.",
    request: z.object({ chapterId: z.number().int().positive() }),
    response: z.object({ url: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.uploadedBookChapters)
        .where(eq(schema.uploadedBookChapters.id, args.chapterId))
        .limit(1);
      const c = rows[0];
      if (!c?.blobKey) return { url: null };
      return { url: await ctx.blobs.getUrl(c.blobKey) };
    },
  }),

  removeUploadedBook: defineAction({
    description:
      "Removes one of the user's own uploaded audiobooks and all its chapter files from the app.",
    request: z.object({ bookId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const chapters = await db
        .select()
        .from(schema.uploadedBookChapters)
        .where(eq(schema.uploadedBookChapters.bookId, args.bookId));
      for (const c of chapters) {
        if (c.blobKey) {
          try {
            await ctx.blobs.delete(c.blobKey);
          } catch {
            // blob already gone; row removal still proceeds
          }
        }
      }
      await db
        .delete(schema.uploadedBookChapters)
        .where(eq(schema.uploadedBookChapters.bookId, args.bookId));
      await db
        .delete(schema.uploadedBooks)
        .where(eq(schema.uploadedBooks.id, args.bookId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  submitAppRequest: defineAction({
    description:
      "Saves an 'Ask Tiana' app-change request the user typed or spoke inside the app, for Tiana to act on. App changes take a short build — this only saves the request; nothing in the app changes instantly. Playing a song stays instant and does not go through here.",
    request: z.object({ text: z.string().min(1).max(1000) }),
    response: z.object({ requestId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.appRequests)
        .values({ text: args.text.trim(), status: "pending" })
        .returning({ id: schema.appRequests.id });
      const row = inserted[0];
      if (!row) throw new Error("submitAppRequest: insert returned no rows");
      ctx.invalidateQueries();
      return { requestId: row.id };
    },
  }),

  listAppRequests: defineAction({
    description:
      "Lists the user's Ask Tiana requests, newest first: the ones still waiting to be built (pending) and the ones already built (done, with Tiana's short note and whether the Updated note has been dismissed yet).",
    request: z.object({}),
    response: z.object({
      requests: z.array(
        z.object({
          id: z.number(),
          text: z.string(),
          status: z.enum(["pending", "done"]),
          resolutionNote: z.string().nullable(),
          seenDone: z.boolean(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.appRequests)
        .orderBy(desc(schema.appRequests.id))
        .limit(30);
      return {
        requests: rows.map((r) => ({
          id: r.id,
          text: r.text,
          status: r.status,
          resolutionNote: r.resolutionNote,
          seenDone: r.seenDone === 1,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  markAppRequestSeen: defineAction({
    description:
      "Dismisses the 'Updated' note for one finished Ask Tiana request, so it stops showing on open. The request itself stays in the Settings list.",
    request: z.object({ requestId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.appRequests)
        .set({ seenDone: 1, updatedAt: new Date() })
        .where(eq(schema.appRequests.id, args.requestId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  resolveAppRequest: defineAction({
    description:
      "For Tiana: marks an Ask Tiana request as built (done) with a short note saying what changed. The app then shows the user an 'Updated' note with that text on next open/reload. Call this only after the change is actually built into the app.",
    request: z.object({
      requestId: z.number().int().positive(),
      note: z.string().min(1).max(300),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.appRequests)
        .set({
          status: "done",
          resolutionNote: args.note.trim(),
          seenDone: 0,
          updatedAt: new Date(),
        })
        .where(eq(schema.appRequests.id, args.requestId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getLyrics: defineAction({
    description:
      "Real lyrics for a song from LRCLIB (timed/synced LRC lyrics where the source has them, plain text otherwise), with Lyrics.ovh as a plain-text fallback. Returns status 'none' when no source has the song — lyrics are never generated or guessed.",
    request: z.object({
      title: z.string().min(1).max(200),
      artist: z.string().min(1).max(200),
      albumTitle: z.string().max(200).nullable().default(null),
      durationMs: z.number().int().min(0).default(0),
    }),
    response: z.object({
      status: z.enum(["synced", "plain", "none"]),
      lines: z.array(
        z.object({ timeMs: z.number().nullable(), text: z.string() }),
      ),
      source: z.string().nullable(),
      instrumental: z.boolean(),
    }),
    async handler(_ctx, args) {
      type LyricsResult = {
        status: "synced" | "plain" | "none";
        lines: { timeMs: number | null; text: string }[];
        source: string | null;
        instrumental: boolean;
      };
      const none: LyricsResult = {
        status: "none",
        lines: [],
        source: null,
        instrumental: false,
      };
      const primaryArtist = (
        args.artist.split(/\s*(?:&|,|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b)/i)[0] ??
        args.artist
      ).trim();
      const cleanTitle =
        args.title
          .replace(/\s*\([^)]*\)/g, " ")
          .replace(/\s*\[[^\]]*\]/g, " ")
          .replace(/\s+/g, " ")
          .trim() || args.title.trim();
      const durationSec =
        args.durationMs > 0 ? Math.round(args.durationMs / 1000) : 0;

      const fetchLyr = async (url: string): Promise<unknown> => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        try {
          const res = await fetch(url, {
            headers: {
              "User-Agent": "SMLifeStreaming/1.0 (personal music app)",
            },
            signal: ctrl.signal,
          });
          if (!res.ok) return null;
          return (await res.json()) as unknown;
        } catch {
          return null;
        } finally {
          clearTimeout(t);
        }
      };

      type LrcRecord = {
        trackName?: unknown;
        artistName?: unknown;
        duration?: unknown;
        instrumental?: unknown;
        plainLyrics?: unknown;
        syncedLyrics?: unknown;
      };
      const parseLrc = (
        synced: string,
      ): { timeMs: number; text: string }[] => {
        const out: { timeMs: number; text: string }[] = [];
        for (const line of synced.split("\n")) {
          const stamps = [
            ...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g),
          ];
          if (stamps.length === 0) continue;
          const text = line.replace(/\[[^\]]*\]/g, "").trim();
          for (const m of stamps) {
            const mins = Number(m[1] ?? 0);
            const secs = Number(m[2] ?? 0);
            const frac = Number((m[3] ?? "0").padEnd(3, "0").slice(0, 3));
            out.push({ timeMs: (mins * 60 + secs) * 1000 + frac, text });
          }
        }
        return out.sort((a, b) => a.timeMs - b.timeMs);
      };
      const plainLines = (
        plain: string,
      ): { timeMs: null; text: string }[] =>
        plain
          .replace(/\r\n/g, "\n")
          .split("\n")
          .map((text) => ({ timeMs: null, text }));
      // One LRCLIB record → a result, or null when it carries no lyrics.
      const fromRecord = (rec: LrcRecord | null): LyricsResult | null => {
        if (!rec) return null;
        if (rec.instrumental === true) {
          return { status: "none", lines: [], source: "LRCLIB", instrumental: true };
        }
        if (typeof rec.syncedLyrics === "string" && rec.syncedLyrics.trim()) {
          const lines = parseLrc(rec.syncedLyrics);
          if (lines.length > 0) {
            return { status: "synced", lines, source: "LRCLIB", instrumental: false };
          }
        }
        if (typeof rec.plainLyrics === "string" && rec.plainLyrics.trim()) {
          return {
            status: "plain",
            lines: plainLines(rec.plainLyrics),
            source: "LRCLIB",
            instrumental: false,
          };
        }
        return null;
      };

      // 1) LRCLIB exact get (track + artist + album + duration).
      const getParams = new URLSearchParams({
        track_name: cleanTitle,
        artist_name: primaryArtist,
      });
      if (args.albumTitle) getParams.set("album_name", args.albumTitle);
      if (durationSec > 0) getParams.set("duration", String(durationSec));
      let best = fromRecord(
        (await fetchLyr(
          `https://lrclib.net/api/get?${getParams.toString()}`,
        )) as LrcRecord | null,
      );
      // 2) LRCLIB search — another pressing of the same song may carry
      // the timed lyrics even when the exact-get record doesn't.
      if (!best || best.status !== "synced") {
        const sParams = new URLSearchParams({
          track_name: cleanTitle,
          artist_name: primaryArtist,
        });
        const arr = (await fetchLyr(
          `https://lrclib.net/api/search?${sParams.toString()}`,
        )) as LrcRecord[] | null;
        if (Array.isArray(arr)) {
          let bestRec: LrcRecord | null = null;
          let bestScore = -1;
          for (const rec of arr.slice(0, 10)) {
            if (normTitle(str(rec.trackName)) !== normTitle(cleanTitle)) {
              continue;
            }
            const recArtist = str(rec.artistName);
            if (
              recArtist &&
              !artistsMatch(recArtist, primaryArtist) &&
              artistKey(recArtist) !== artistKey(primaryArtist)
            ) {
              continue;
            }
            let s = 0;
            if (typeof rec.syncedLyrics === "string" && rec.syncedLyrics) {
              s += 10;
            }
            if (typeof rec.plainLyrics === "string" && rec.plainLyrics) {
              s += 4;
            }
            if (durationSec > 0 && typeof rec.duration === "number") {
              s += Math.max(0, 3 - Math.abs(rec.duration - durationSec) / 2);
            }
            if (s > bestScore) {
              bestScore = s;
              bestRec = rec;
            }
          }
          const fromSearch = fromRecord(bestRec);
          if (fromSearch && (!best || fromSearch.status === "synced")) {
            best = fromSearch;
          }
        }
      }
      if (best && best.status !== "none") return best;
      if (best?.instrumental) return best;
      // 3) Lyrics.ovh plain-text fallback.
      const ovh = (await fetchLyr(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(primaryArtist)}/${encodeURIComponent(cleanTitle)}`,
      )) as { lyrics?: unknown } | null;
      const ovhText = typeof ovh?.lyrics === "string" ? ovh.lyrics : "";
      if (ovhText.trim()) {
        const ovhResult: LyricsResult = {
          status: "plain",
          lines: plainLines(ovhText),
          source: "Lyrics.ovh",
          instrumental: false,
        };
        return ovhResult;
      }
      return none;
    },
  }),

  importShared: defineAction({
    description:
      "Share-to-app import: takes text or a link shared from another music player (album/song name or a catalog link) and imports the whole matching album into the library, filled with its tracklist.",
    request: z.object({ text: z.string().min(1).max(2000) }),
    response: z.object({
      savedId: z.number(),
      title: z.string(),
      artist: z.string(),
      trackCount: z.number(),
    }),
    async handler(ctx, args) {
      const text = args.text.trim();
      // A pasted Apple Music / iTunes link carries the album id in the URL.
      const idMatch = text.match(/album\/[^/]+\/(\d+)/) ?? text.match(/[?&]i=(\d+)/);
      let catalogId: string | null = idMatch?.[1] ?? null;
      if (!catalogId) {
        const cleaned = text
          .replace(/https?:\/\/\S+/g, " ")
          .replace(/shared|via|from my music player/gi, " ")
          .trim();
        const parts = cleaned.split(/\s+[-–—]\s+/);
        const query =
          parts.length >= 2
            ? `${parts[0]} ${parts[1]}`
            : cleaned || text;
        const search = await itunes(
          `search?term=${encodeURIComponent(query)}&media=music&entity=album&limit=5&country=US`,
        );
        const first = resultsOf(search)
          .map(toAlbum)
          .find((a) => a.title);
        if (!first) {
          throw new Error(
            "Couldn't match that share to an album in the catalog. Try pasting the album and artist name, like: Artist - Album.",
          );
        }
        catalogId = first.catalogId;
      }
      // Reuse the fill path: resolve details, then save album + tracks.
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.catalogId, catalogId))
        .limit(1);
      const lookup = await itunes(
        `lookup?id=${encodeURIComponent(catalogId)}&entity=song&country=US`,
      );
      const rows = resultsOf(lookup);
      const albumRow = rows.find((r) => r["wrapperType"] === "collection");
      const trackRows = rows
        .filter((r) => r["kind"] === "song")
        .sort(
          (a, b) =>
            (num(a["discNumber"]) || 1) - (num(b["discNumber"]) || 1) ||
            num(a["trackNumber"]) - num(b["trackNumber"]),
        )
        .map(toTrack);
      if (existing[0]) {
        // An uploaded full copy of the same album (title + artist)
        // outranks this imported preview copy — report the full copy.
        const matches0 = await libraryAlbumMatches(
          ctx,
          existing[0].title,
          existing[0].artist,
        );
        const keep0 = await preferredLibraryCopy(ctx, matches0);
        if (keep0 && keep0.id !== existing[0].id) {
          const count = await db
            .select()
            .from(schema.savedTracks)
            .where(eq(schema.savedTracks.albumId, keep0.id));
          return {
            savedId: keep0.id,
            title: keep0.title,
            artist: keep0.artist,
            trackCount: count.length,
          };
        }
        return {
          savedId: existing[0].id,
          title: existing[0].title,
          artist: existing[0].artist,
          trackCount: trackRows.length,
        };
      }
      if (!albumRow) {
        throw new Error("That shared album could not be loaded from the catalog.");
      }
      const base = toAlbum(albumRow);
      // Duplicate prevention: same title + artist already in the
      // library (e.g. the user's uploaded full copy of this album) —
      // keep that copy; importing must never land a preview twin next
      // to it. This is the exact 400 Degreez case.
      const dupMatches = await libraryAlbumMatches(ctx, base.title, base.artist);
      if (dupMatches.length > 0) {
        const keep = await preferredLibraryCopy(ctx, dupMatches);
        if (keep) {
          const count = await db
            .select()
            .from(schema.savedTracks)
            .where(eq(schema.savedTracks.albumId, keep.id));
          return {
            savedId: keep.id,
            title: keep.title,
            artist: keep.artist,
            trackCount: count.length,
          };
        }
      }
      const inserted = await db
        .insert(schema.savedAlbums)
        .values({
          catalogId,
          title: base.title,
          artist: base.artist,
          artistId: base.artistId,
          artworkUrl: base.artworkUrl,
          genre: base.genre,
          releaseLabel: base.releaseLabel,
          releaseDateLabel: fullDate(strOrNull(albumRow["releaseDate"])),
          source: "imported",
          downloaded: 0,
        })
        .returning({ id: schema.savedAlbums.id });
      const row = inserted[0];
      if (!row) throw new Error("importShared: insert returned no rows");
      if (trackRows.length > 0) {
        await db.insert(schema.savedTracks).values(
          trackRows.map((t) => ({
            albumId: row.id,
            title: t.title,
            artist: t.artist,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
            durationMs: t.durationMs,
            previewUrl: t.previewUrl,
            artworkUrl: t.artworkUrl,
          })),
        );
      }
      ctx.invalidateQueries();
      return {
        savedId: row.id,
        title: base.title,
        artist: base.artist,
        trackCount: trackRows.length,
      };
    },
  }),

  // ---------- library ----------

  listLibrary: defineAction({
    description:
      "Lists the user's library: saved albums with their tracks, playlists, and recent play history.",
    request: z.object({}),
    response: z.object({
      albums: z.array(
        z.object({
          id: z.number(),
          catalogId: z.string(),
          title: z.string(),
          artist: z.string(),
          artworkUrl: z.string().nullable(),
          genre: z.string().nullable(),
          releaseLabel: z.string().nullable(),
          releaseDateLabel: z.string().nullable(),
          label: z.string().nullable(),
          producer: z.string().nullable(),
          contributors: z.array(z.string()),
          albumInfo: z.string().nullable(),
          source: z.string(),
          downloaded: z.boolean(),
          tracks: z.array(
            z.object({
              id: z.number(),
              title: z.string(),
              artist: z.string(),
              trackNumber: z.number(),
              discNumber: z.number(),
              durationMs: z.number(),
              previewUrl: z.string().nullable(),
              artworkUrl: z.string().nullable(),
              hasFullFile: z.boolean(),
              fileName: z.string().nullable(),
            }),
          ),
        }),
      ),
      playlists: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          items: z.array(
            z.object({
              id: z.number(),
              title: z.string(),
              artist: z.string(),
              previewUrl: z.string().nullable(),
              artworkUrl: z.string().nullable(),
              durationMs: z.number(),
              hasFullFile: z.boolean(),
            }),
          ),
        }),
      ),
      history: z.array(
        z.object({
          id: z.number(),
          title: z.string(),
          artist: z.string(),
          artworkUrl: z.string().nullable(),
          playedAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const albumRows = await db
        .select()
        .from(schema.savedAlbums)
        .orderBy(desc(schema.savedAlbums.id));
      const albums = [];
      for (const a of albumRows) {
        const tracks = await db
          .select()
          .from(schema.savedTracks)
          .where(eq(schema.savedTracks.albumId, a.id))
          .orderBy(
            asc(schema.savedTracks.discNumber),
            asc(schema.savedTracks.trackNumber),
            asc(schema.savedTracks.id),
          );
        const art = await albumArtwork(ctx, a);
        albums.push({
          id: a.id,
          catalogId: a.catalogId,
          title: a.title,
          artist: a.artist,
          artworkUrl: art,
          genre: a.genre,
          releaseLabel: a.releaseLabel,
          releaseDateLabel: a.releaseDateLabel,
          label: a.label,
          producer: a.producer,
          contributors: parseContributors(a.contributors),
          albumInfo: a.albumInfo,
          source: a.source,
          downloaded: a.downloaded === 1,
          tracks: tracks.map((t) => ({
            id: t.id,
            title: t.title,
            artist: t.artist,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
            durationMs: t.durationMs,
            previewUrl: t.previewUrl,
            artworkUrl: t.artworkUrl ?? art,
            hasFullFile: t.blobKey != null,
            fileName: t.fileName,
          })),
        });
      }
      const playlistRows = await db
        .select()
        .from(schema.playlists)
        .orderBy(desc(schema.playlists.id));
      const playlists = [];
      for (const p of playlistRows) {
        const items = await db
          .select()
          .from(schema.playlistItems)
          .where(eq(schema.playlistItems.playlistId, p.id))
          .orderBy(asc(schema.playlistItems.id));
        playlists.push({
          id: p.id,
          name: p.name,
          items: items.map((i) => ({
            id: i.id,
            title: i.title,
            artist: i.artist,
            previewUrl: i.previewUrl,
            artworkUrl: i.artworkUrl,
            durationMs: i.durationMs,
            hasFullFile: i.blobKey != null,
          })),
        });
      }
      const historyRows = await db
        .select()
        .from(schema.playHistory)
        .orderBy(desc(schema.playHistory.id))
        .limit(30);
      return {
        albums,
        playlists,
        history: historyRows.map((h) => ({
          id: h.id,
          title: h.title,
          artist: h.artist,
          artworkUrl: h.artworkUrl,
          playedAt: h.playedAt.toISOString(),
        })),
      };
    },
  }),

  saveCatalogAlbum: defineAction({
    description: "Saves a catalog album (with its tracklist and previews) into the user's library.",
    request: z.object({ catalogId: z.string().min(1) }),
    response: z.object({ savedId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.catalogId, args.catalogId))
        .limit(1);
      if (existing[0]) {
        // Even on the fast path, an uploaded full copy of the same
        // album (title + artist) outranks this preview copy.
        const matches = await libraryAlbumMatches(
          ctx,
          existing[0].title,
          existing[0].artist,
        );
        const keep = await preferredLibraryCopy(ctx, matches);
        return { savedId: keep ? keep.id : existing[0].id };
      }
      // Same resolution as getAlbum: iTunes collection IDs and Deezer
      // album IDs ("dz-…", e.g. Home-feed trending albums) both save
      // with their real tracklist.
      const resolved = await resolveCatalogAlbum(args.catalogId);
      if (!resolved || !resolved.album.title) {
        throw new Error("Album not found in the catalog.");
      }
      const base = resolved.album;
      // Duplicate prevention: same title + artist already in the
      // library (e.g. the user's own uploaded full copy) — keep the
      // copy that's there and never save a second one.
      const dupMatches = await libraryAlbumMatches(ctx, base.title, base.artist);
      if (dupMatches.length > 0) {
        const keep = await preferredLibraryCopy(ctx, dupMatches);
        if (keep) return { savedId: keep.id };
      }
      const trackRows = resolved.tracks;
      const inserted = await db
        .insert(schema.savedAlbums)
        .values({
          catalogId: args.catalogId,
          title: base.title,
          artist: base.artist,
          artistId: base.artistId,
          artworkUrl: base.artworkUrl,
          genre: base.genre,
          releaseLabel: base.releaseLabel,
          releaseDateLabel: fullDate(resolved.releaseDateIso),
          source: "catalog",
          downloaded: 0,
        })
        .returning({ id: schema.savedAlbums.id });
      const row = inserted[0];
      if (!row) throw new Error("saveCatalogAlbum: insert returned no rows");
      if (trackRows.length > 0) {
        await db.insert(schema.savedTracks).values(
          trackRows.map((t) => ({
            albumId: row.id,
            title: t.title,
            artist: t.artist,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
            durationMs: t.durationMs,
            previewUrl: t.previewUrl,
            artworkUrl: t.artworkUrl,
          })),
        );
      }
      ctx.invalidateQueries();
      return { savedId: row.id };
    },
  }),

  removeSavedAlbum: defineAction({
    description: "Removes an album and its tracks from the user's library.",
    request: z.object({ albumId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const tracks = await db
        .select()
        .from(schema.savedTracks)
        .where(eq(schema.savedTracks.albumId, args.albumId));
      for (const t of tracks) {
        if (t.blobKey) {
          try {
            await ctx.blobs.delete(t.blobKey);
          } catch {
            // blob already gone; row removal still proceeds
          }
        }
      }
      await db
        .delete(schema.savedTracks)
        .where(eq(schema.savedTracks.albumId, args.albumId));
      await db
        .delete(schema.savedAlbums)
        .where(eq(schema.savedAlbums.id, args.albumId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setAlbumDownloaded: defineAction({
    description:
      "Marks a library album as downloaded for offline listening (or removes the download mark).",
    request: z.object({
      albumId: z.number().int().positive(),
      downloaded: z.boolean(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.savedAlbums)
        .set({ downloaded: args.downloaded ? 1 : 0 })
        .where(eq(schema.savedAlbums.id, args.albumId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  applyCover: defineAction({
    description:
      "Sets a chosen cover-art URL on a saved library album. The chosen cover replaces any cover picture the user uploaded earlier (the uploaded blob key is cleared), so the cover they just picked is the one that shows everywhere the album appears.",
    request: z.object({
      albumId: z.number().int().positive(),
      artworkUrl: z.string().url().max(2000),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.savedAlbums)
        .set({ artworkUrl: args.artworkUrl, artworkBlobKey: null })
        .where(eq(schema.savedAlbums.id, args.albumId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  updateAlbumInfo: defineAction({
    description:
      "Saves the user's own edits to a library album's info — title, artist, genre, release date, label, producer, who's on the album, the about-the-album text, and a cover-art URL — so they can fix any wrong words on an album and fill in by hand anything the catalog or the AI couldn't find. Fields left out of the request stay as they are; a text field sent blank is cleared. A pasted cover URL replaces an uploaded cover picture, so the cover the user just picked is the one that shows.",
    request: z.object({
      albumId: z.number().int().positive(),
      title: z.string().max(200).optional(),
      artist: z.string().max(200).optional(),
      genre: z.string().max(120).nullable().optional(),
      releaseLabel: z.string().max(120).nullable().optional(),
      releaseDateLabel: z.string().max(120).nullable().optional(),
      label: z.string().max(300).nullable().optional(),
      producer: z.string().max(300).nullable().optional(),
      contributors: z.array(z.string().max(120)).max(40).optional(),
      albumInfo: z.string().max(4000).nullable().optional(),
      artworkUrl: z.string().url().max(2000).nullable().optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.id, args.albumId))
        .limit(1);
      if (!rows[0]) throw new Error("That album isn't in your library anymore.");
      const blankToNull = (v: string | null): string | null => {
        if (v === null) return null;
        const t = v.trim();
        return t === "" ? null : t;
      };
      const set: Partial<typeof schema.savedAlbums.$inferInsert> = {};
      if (args.title !== undefined) {
        const t = args.title.trim();
        if (!t) throw new Error("The album title can't be blank.");
        set.title = t;
      }
      if (args.artist !== undefined) {
        const t = args.artist.trim();
        if (!t) throw new Error("The artist name can't be blank.");
        set.artist = t;
      }
      if (args.genre !== undefined) set.genre = blankToNull(args.genre);
      if (args.releaseLabel !== undefined)
        set.releaseLabel = blankToNull(args.releaseLabel);
      if (args.releaseDateLabel !== undefined)
        set.releaseDateLabel = blankToNull(args.releaseDateLabel);
      if (args.label !== undefined) set.label = blankToNull(args.label);
      if (args.producer !== undefined)
        set.producer = blankToNull(args.producer);
      if (args.albumInfo !== undefined)
        set.albumInfo = blankToNull(args.albumInfo);
      if (args.contributors !== undefined) {
        const names = args.contributors
          .map((n) => n.trim())
          .filter((n) => n.length > 0)
          .slice(0, 40);
        set.contributors = names.length > 0 ? JSON.stringify(names) : null;
      }
      if (args.artworkUrl !== undefined) {
        set.artworkUrl = args.artworkUrl;
        // A cover the user just pasted/chose wins over a cover picture
        // they uploaded earlier (albumArtwork prefers the blob).
        if (args.artworkUrl) set.artworkBlobKey = null;
      }
      if (Object.keys(set).length > 0) {
        await db
          .update(schema.savedAlbums)
          .set(set)
          .where(eq(schema.savedAlbums.id, args.albumId));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  updateSavedTrack: defineAction({
    description:
      "Saves the user's own edits to one song on a library album — its title, the artist credited on the song, its track number, and its disc number — so they can fix a wrong name and put the songs in the order they want (the album page lists songs disc-first, then by track number). Only the fields sent change; the song's file and preview are untouched.",
    request: z.object({
      trackId: z.number().int().positive(),
      title: z.string().max(300).optional(),
      artist: z.string().max(300).optional(),
      trackNumber: z.number().int().min(0).max(999).optional(),
      discNumber: z.number().int().min(1).max(99).optional(),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedTracks)
        .where(eq(schema.savedTracks.id, args.trackId))
        .limit(1);
      if (!rows[0]) throw new Error("That song isn't in your library anymore.");
      const set: Partial<typeof schema.savedTracks.$inferInsert> = {};
      if (args.title !== undefined) {
        const t = args.title.trim();
        if (!t) throw new Error("The song title can't be blank.");
        set.title = t;
      }
      if (args.artist !== undefined) {
        const t = args.artist.trim();
        if (!t) throw new Error("The artist name can't be blank.");
        set.artist = t;
      }
      if (args.trackNumber !== undefined) set.trackNumber = args.trackNumber;
      if (args.discNumber !== undefined) set.discNumber = args.discNumber;
      if (Object.keys(set).length > 0) {
        await db
          .update(schema.savedTracks)
          .set(set)
          .where(eq(schema.savedTracks.id, args.trackId));
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  removeSavedTrack: defineAction({
    description:
      "Removes one song from a library album at the user's own request (the Edit song panel's Remove button): deletes the song's row and its uploaded file, and takes it out of any playlist that pointed at it. The album itself and its other songs stay.",
    request: z.object({ trackId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedTracks)
        .where(eq(schema.savedTracks.id, args.trackId))
        .limit(1);
      const t = rows[0];
      if (!t) throw new Error("That song isn't in your library anymore.");
      if (t.blobKey) {
        try {
          await ctx.blobs.delete(t.blobKey);
        } catch {
          // blob already gone; row removal still proceeds
        }
      }
      await db
        .delete(schema.playlistItems)
        .where(eq(schema.playlistItems.savedTrackId, args.trackId));
      await db
        .delete(schema.savedTracks)
        .where(eq(schema.savedTracks.id, args.trackId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  createUserAlbum: defineAction({
    description:
      "Creates an album in the library for the user's own uploaded tracks and AI-files it to the right artist profile: the AI cleans the artist name the user typed (fixing case, dropping feat. tails), matches it to the catalog's canonical artist when there is one, and stores that artist name + catalog artistId on the album so the album shows up in that artist's Albums section. When the artist isn't in the catalog (an independent or unreleased artist), the album is still filed under the cleaned name the user gave, so their own artist profile shows it. Duplicate prevention: if the same title + artist is already in the library, no second copy is created — an existing uploaded full copy is kept and returned with alreadyInLibrary=true (the caller must not upload the files again), and a preview/imported copy is replaced by this upload so the album lives in the library once, as the full version.",
    request: z.object({
      title: z.string().min(1).max(200),
      artist: z.string().min(1).max(200),
    }),
    response: z.object({
      albumId: z.number(),
      artist: z.string(),
      artistId: z.string().nullable(),
      filedNote: z.string(),
      // True when this album (same title + artist) was already in the
      // library and the existing copy was kept — the caller must not
      // upload the files again into it.
      alreadyInLibrary: z.boolean(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rawArtist = args.artist.trim();
      const rawTitle = args.title.trim();
      // Duplicate prevention, first pass on the names as typed: an
      // uploaded full copy of this album is already in the library —
      // keep it and stop here, before any AI/catalog work.
      const rawMatches = await libraryAlbumMatches(ctx, rawTitle, rawArtist);
      if (rawMatches.length > 0) {
        const keep = await preferredLibraryCopy(ctx, rawMatches);
        if (keep && (await albumHasFullFiles(ctx, keep.id))) {
          return {
            albumId: keep.id,
            artist: keep.artist,
            artistId: keep.artistId,
            filedNote: `“${keep.title}” by ${keep.artist} is already in your library with your full songs — that copy was kept, so no second copy was made.`,
            alreadyInLibrary: true,
          };
        }
      }
      // 1) AI cleans the artist credit: main artist only, proper casing.
      let cleanedArtist = rawArtist
        .split(/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/i)[0]!
        .trim() || rawArtist;
      try {
        const out = await ctx.inference.complete(
          `A user is uploading their own album "${rawTitle}" and typed the artist credit as: "${rawArtist}". Return the main artist's name exactly as it should appear on an artist profile: the primary artist only (drop any feat./ft./featuring guests), with correct capitalization and spelling for that artist if it is a known artist, otherwise the typed name cleaned of extra spaces and punctuation. Do not invent a different artist.`,
          {
            schema: z.object({ canonicalArtist: z.string().min(1).max(200) }),
          },
        );
        if (out.canonicalArtist.trim()) cleanedArtist = out.canonicalArtist.trim();
      } catch {
        // Inference unavailable — keep the deterministically cleaned name.
      }
      // 2) Match to the catalog's canonical artist when one exists.
      let filedArtist = cleanedArtist;
      let filedArtistId: string | null = null;
      let matchedCatalog = false;
      try {
        const cat = await catalogArtistFor(cleanedArtist);
        if (cat) {
          filedArtist = cat.name;
          filedArtistId = cat.artistId || null;
          matchedCatalog = true;
        }
      } catch {
        // Catalog unreachable — file under the cleaned name as-is.
      }
      // 3) If this exact album exists in the catalog for that artist,
      // borrow its cover + genre so the upload looks complete on the
      // profile. Unreleased albums keep no cover until the user picks one.
      let artworkUrl: string | null = null;
      let genre: string | null = null;
      try {
        const search = await itunes(
          `search?term=${encodeURIComponent(`${filedArtist} ${rawTitle}`)}&media=music&entity=album&limit=5&country=US`,
        );
        const cand = resultsOf(search)
          .map(toAlbum)
          .find(
            (a) =>
              normTitle(a.title) === normTitle(rawTitle) &&
              artistsMatch(a.artist, filedArtist),
          );
        if (cand) {
          artworkUrl = cand.artworkUrl;
          genre = cand.genre;
        }
      } catch {
        // No catalog match is fine for an unreleased upload.
      }
      // Duplicate prevention, second pass under the AI-filed artist
      // name (the typed name may have been spelled differently): a
      // full copy already there is kept as-is; a preview/imported
      // copy is replaced by this upload, so the album lives in the
      // library exactly once — as the user's full version.
      let replacedPreview = false;
      const filedMatches = await libraryAlbumMatches(ctx, rawTitle, filedArtist);
      if (filedMatches.length > 0) {
        const keep = await preferredLibraryCopy(ctx, filedMatches);
        if (keep && (await albumHasFullFiles(ctx, keep.id))) {
          return {
            albumId: keep.id,
            artist: keep.artist,
            artistId: keep.artistId,
            filedNote: `“${keep.title}” by ${keep.artist} is already in your library with your full songs — that copy was kept, so no second copy was made.`,
            alreadyInLibrary: true,
          };
        }
        for (const m of filedMatches) {
          await deleteLibraryAlbum(ctx, m.id);
        }
        replacedPreview = true;
      }
      const inserted = await db
        .insert(schema.savedAlbums)
        .values({
          catalogId: `user-${Date.now()}`,
          title: rawTitle,
          artist: filedArtist,
          artistId: filedArtistId,
          artworkUrl,
          genre,
          source: "uploaded",
          downloaded: 1,
        })
        .returning({ id: schema.savedAlbums.id });
      const row = inserted[0];
      if (!row) throw new Error("createUserAlbum: insert returned no rows");
      // AI creates the artist's profile right here at upload time —
      // name, photo, bio and genre from real sources — so the album
      // lands on a complete profile, not just a name. Credits for the
      // album itself are gathered too, and re-gathered after the tracks
      // land (enrichUploadedAlbum) so features on the tracks count.
      const profile = await ensureArtistProfile(ctx, filedArtist, filedArtistId).catch(
        () => null,
      );
      await enrichAlbumCredits(ctx, row.id).catch(() => null);
      ctx.invalidateQueries();
      return {
        albumId: row.id,
        artist: filedArtist,
        artistId: filedArtistId,
        alreadyInLibrary: false,
        filedNote:
          (matchedCatalog
            ? `AI filed this album under ${filedArtist} and ${profile ? "created their artist profile with their photo and info — " : ""}it now shows in their artist profile, in the Albums section.`
            : `AI filed this album under ${filedArtist} and ${profile ? "created their artist profile — " : ""}it now shows on the ${filedArtist} artist profile, in the Albums section.`) +
          (replacedPreview
            ? " It replaced the preview copy of this album that was in your library, so the album shows just once — with your full songs."
            : ""),
      };
    },
  }),

  enrichUploadedAlbum: defineAction({
    description:
      "AI-builds an uploaded album's info after its tracks are in: who's on the album (official contributors plus the features named on its own tracks), who produced it (named in the album's Wikipedia summary, or null when no source names a producer — never guessed), what the album is about (its Wikipedia summary), and its label. Saved on the album and shown on its library page.",
    request: z.object({ albumId: z.number().int().positive() }),
    response: z.object({
      producer: z.string().nullable(),
      contributors: z.array(z.string()),
      albumInfo: z.string().nullable(),
      label: z.string().nullable(),
    }),
    async handler(ctx, args) {
      return enrichAlbumCredits(ctx, args.albumId);
    },
  }),

  albumVideos: defineAction({
    description:
      "The music videos that belong to a library album: the artist's catalog music videos whose song matches one of the album's tracks. The match set is the album's own uploaded track titles plus — when this album also exists in the catalog — the catalog edition's tracklist, so an uploaded copy of a real album still finds its videos. Only real title matches are returned.",
    request: z.object({ albumId: z.number().int().positive() }),
    response: z.object({ videos: z.array(videoOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.id, args.albumId))
        .limit(1);
      const album = rows[0];
      if (!album) throw new Error("That album isn't in your library anymore.");
      const tracks = await db
        .select()
        .from(schema.savedTracks)
        .where(eq(schema.savedTracks.albumId, args.albumId));
      const titles = new Set<string>(tracks.map((t) => t.title));
      // If the catalog has this same album, its official tracklist
      // counts too — uploaded file names don't always match exactly.
      try {
        const search = await itunes(
          `search?term=${encodeURIComponent(`${album.artist} ${album.title}`)}&media=music&entity=album&limit=5&country=US`,
        );
        const cand = resultsOf(search)
          .map(toAlbum)
          .find(
            (a) =>
              normTitle(a.title) === normTitle(album.title) &&
              artistsMatch(a.artist, album.artist),
          );
        if (cand) {
          const lookup = await itunes(
            `lookup?id=${encodeURIComponent(cand.catalogId)}&entity=song&country=US`,
          );
          for (const r of resultsOf(lookup)) {
            if (r["kind"] === "song") titles.add(str(r["trackName"]));
          }
        }
      } catch {
        // Uploaded titles alone still drive the matching.
      }
      const videos = await videosForAlbumTracks(album.artist, [...titles]).catch(
        () => [] as VideoOut[],
      );
      return { videos };
    },
  }),

  updateArtistProfile: defineAction({
    description:
      "Creates or updates an artist's stored profile with the info the user provides (bio, genre, description, photo URL) — used from the profile page's Edit profile form for artists the sources had little or nothing on, so the profile shows their name, a photo, and real info instead of blanks.",
    request: z.object({
      name: z.string().min(1).max(120),
      bio: z.string().max(4000).default(""),
      genre: z.string().max(120).default(""),
      description: z.string().max(300).default(""),
      photoUrl: z.string().max(2000).default(""),
      backgroundUrl: z.string().max(2000).default(""),
    }),
    response: z.object({ profileId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const key = artistKey(args.name);
      if (!key) throw new Error("That artist name doesn't look right.");
      const existing = await db
        .select()
        .from(schema.artistProfiles)
        .where(eq(schema.artistProfiles.artistKey, key))
        .limit(1);
      const values = {
        bio: args.bio.trim() ? args.bio.trim() : null,
        genre: args.genre.trim() ? args.genre.trim() : null,
        description: args.description.trim() ? args.description.trim() : null,
        photoUrl: args.photoUrl.trim() ? args.photoUrl.trim() : null,
        backgroundUrl: args.backgroundUrl.trim() ? args.backgroundUrl.trim() : null,
      };
      if (existing[0]) {
        await db
          .update(schema.artistProfiles)
          .set({
            // A blank photo/background URL keeps an uploaded image; the
            // other fields save exactly what the user typed.
            bio: values.bio,
            genre: values.genre,
            description: values.description,
            ...(values.photoUrl ? { photoUrl: values.photoUrl, photoBlobKey: null } : {}),
            ...(values.backgroundUrl
              ? { backgroundUrl: values.backgroundUrl, backgroundBlobKey: null }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(schema.artistProfiles.id, existing[0].id));
        ctx.invalidateQueries();
        return { profileId: existing[0].id };
      }
      const inserted = await db
        .insert(schema.artistProfiles)
        .values({
          name: args.name.trim(),
          artistKey: key,
          ...values,
          source: "user-edited",
        })
        .returning({ id: schema.artistProfiles.id });
      const row = inserted[0];
      if (!row) throw new Error("updateArtistProfile: insert returned no rows");
      ctx.invalidateQueries();
      return { profileId: row.id };
    },
  }),

  uploadArtistPhoto: defineAction({
    description:
      "Uploads the artist's photo from the user's device onto their stored profile (creating the profile first if needed), so the profile page shows that photo next to the artist's name.",
    request: z.object({
      name: z.string().min(1).max(120),
      dataBase64: z.string().min(10).max(12_000_000),
      mimeType: z.string().max(100),
    }),
    response: z.object({ profileId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.length === 0) throw new Error("That image looks empty.");
      if (bytes.length > 8 * 1024 * 1024) {
        throw new Error("Artist photos are capped at 8 MB in the app.");
      }
      const key = `artist-photo/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await ctx.blobs.put(key, bytes, {
        contentType: args.mimeType || "image/jpeg",
      });
      const profile =
        (await ensureArtistProfile(ctx, args.name.trim(), null).catch(() => null)) ??
        null;
      const akey = artistKey(args.name);
      const rows = await db
        .select()
        .from(schema.artistProfiles)
        .where(eq(schema.artistProfiles.artistKey, akey))
        .limit(1);
      const row = rows[0] ?? profile;
      if (!row) throw new Error("Could not create that artist profile.");
      await db
        .update(schema.artistProfiles)
        .set({ photoBlobKey: key, updatedAt: new Date() })
        .where(eq(schema.artistProfiles.id, row.id));
      ctx.invalidateQueries();
      return { profileId: row.id };
    },
  }),

  uploadArtistBackground: defineAction({
    description:
      "Uploads a background picture from the user's device onto the artist's stored profile (creating the profile first if needed), so the profile page — the page with their albums, videos, and tracks — shows that picture as its background banner behind the artist's name and photo.",
    request: z.object({
      name: z.string().min(1).max(120),
      dataBase64: z.string().min(10).max(16_000_000),
      mimeType: z.string().max(100),
    }),
    response: z.object({ profileId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.length === 0) throw new Error("That image looks empty.");
      if (bytes.length > 12 * 1024 * 1024) {
        throw new Error("Background pictures are capped at 12 MB in the app.");
      }
      const key = `artist-background/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await ctx.blobs.put(key, bytes, {
        contentType: args.mimeType || "image/jpeg",
      });
      const profile =
        (await ensureArtistProfile(ctx, args.name.trim(), null).catch(() => null)) ??
        null;
      const akey = artistKey(args.name);
      const rows = await db
        .select()
        .from(schema.artistProfiles)
        .where(eq(schema.artistProfiles.artistKey, akey))
        .limit(1);
      const row = rows[0] ?? profile;
      if (!row) throw new Error("Could not create that artist profile.");
      await db
        .update(schema.artistProfiles)
        .set({ backgroundBlobKey: key, updatedAt: new Date() })
        .where(eq(schema.artistProfiles.id, row.id));
      ctx.invalidateQueries();
      return { profileId: row.id };
    },
  }),

  aiFileAlbum: defineAction({
    description:
      "AI-files an existing library album to its artist profile: re-checks the album's artist (or an optional artist hint the user gives), cleans it with AI, matches it to the catalog's canonical artist when there is one, and updates the album so it appears in that artist's Albums section. Use this to fix an album that was filed under the wrong name or to file albums uploaded before automatic filing existed.",
    request: z.object({
      albumId: z.number().int().positive(),
      artistHint: z.string().max(200).default(""),
    }),
    response: z.object({
      albumId: z.number(),
      artist: z.string(),
      artistId: z.string().nullable(),
      filedNote: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.id, args.albumId))
        .limit(1);
      const album = rows[0];
      if (!album) throw new Error("That album isn't in your library anymore.");
      const rawArtist = (args.artistHint.trim() || album.artist).trim();
      let cleanedArtist = rawArtist
        .split(/\bfeat\.?\b|\bft\.?\b|\bfeaturing\b/i)[0]!
        .trim() || rawArtist;
      try {
        const out = await ctx.inference.complete(
          `A user uploaded the album "${album.title}" and its artist is currently written as: "${rawArtist}". Return the main artist's name exactly as it should appear on an artist profile: the primary artist only (drop any feat./ft./featuring guests), with correct capitalization and spelling for that artist if it is a known artist, otherwise the typed name cleaned of extra spaces and punctuation. Do not invent a different artist.`,
          {
            schema: z.object({ canonicalArtist: z.string().min(1).max(200) }),
          },
        );
        if (out.canonicalArtist.trim()) cleanedArtist = out.canonicalArtist.trim();
      } catch {
        // Keep the deterministically cleaned name.
      }
      let filedArtist = cleanedArtist;
      let filedArtistId: string | null = null;
      let matchedCatalog = false;
      try {
        const cat = await catalogArtistFor(cleanedArtist);
        if (cat) {
          filedArtist = cat.name;
          filedArtistId = cat.artistId || null;
          matchedCatalog = true;
        }
      } catch {
        // File under the cleaned name as-is.
      }
      await db
        .update(schema.savedAlbums)
        .set({ artist: filedArtist, artistId: filedArtistId })
        .where(eq(schema.savedAlbums.id, args.albumId));
      // Keep the album's tracks under the same artist credit so track
      // rows and the profile agree.
      await db
        .update(schema.savedTracks)
        .set({ artist: filedArtist })
        .where(eq(schema.savedTracks.albumId, args.albumId));
      // Make sure the (possibly corrected) artist has their profile too.
      await ensureArtistProfile(ctx, filedArtist, filedArtistId).catch(() => null);
      await enrichAlbumCredits(ctx, args.albumId).catch(() => null);
      ctx.invalidateQueries();
      return {
        albumId: args.albumId,
        artist: filedArtist,
        artistId: filedArtistId,
        filedNote: matchedCatalog
          ? `Filed under ${filedArtist} — find it in their artist profile, in the Albums section.`
          : `Filed under ${filedArtist} — find it on the ${filedArtist} artist profile, in the Albums section.`,
      };
    },
  }),

  uploadTrack: defineAction({
    description:
      "Uploads one full audio file the user owns into a library album; the file is stored and plays back in full. Optional trackNumber/discNumber place the song exactly (folder uploads pass the numbers parsed from the file names); without them the track is appended after the album's existing tracks on disc 1.",
    request: z.object({
      albumId: z.number().int().positive(),
      title: z.string().min(1).max(200),
      artist: z.string().min(1).max(200),
      dataBase64: z.string().min(10).max(24_000_000),
      mimeType: z.string().max(100),
      fileName: z.string().max(300),
      trackNumber: z.number().int().min(0).max(999).optional(),
      discNumber: z.number().int().min(1).max(99).optional(),
    }),
    response: z.object({ trackId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.length === 0) throw new Error("That file looks empty.");
      if (bytes.length > 16 * 1024 * 1024) {
        throw new Error("Files are capped at 16 MB each in the app.");
      }
      const existing = await db
        .select()
        .from(schema.savedTracks)
        .where(eq(schema.savedTracks.albumId, args.albumId));
      // Track-level duplicate prevention, same rule as albums: this
      // song is already in the album — a full file already there is
      // kept and the re-upload is a no-op; a preview-only row is
      // replaced by the full file, so the song appears once, in full.
      const dupTrack = existing.find(
        (t) => normTitle(t.title) === normTitle(args.title),
      );
      if (dupTrack?.blobKey) {
        return { trackId: dupTrack.id };
      }
      if (dupTrack) {
        await db
          .delete(schema.savedTracks)
          .where(eq(schema.savedTracks.id, dupTrack.id));
      }
      const key = `audio/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await ctx.blobs.put(key, bytes, {
        contentType: args.mimeType || "audio/mpeg",
      });
      // Keep the track under the album's AI-filed artist credit so the
      // track, the album, and the artist profile all agree.
      const albumRows = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.id, args.albumId))
        .limit(1);
      const albumArtist = albumRows[0]?.artist;
      const trackArtist =
        albumArtist && artistsMatch(albumArtist, args.artist)
          ? albumArtist
          : args.artist;
      const inserted = await db
        .insert(schema.savedTracks)
        .values({
          albumId: args.albumId,
          title: args.title,
          artist: trackArtist,
          trackNumber:
            args.trackNumber != null && args.trackNumber > 0
              ? args.trackNumber
              : dupTrack
                ? dupTrack.trackNumber
                : existing.length + 1,
          discNumber: args.discNumber ?? 1,
          durationMs: 0,
          blobKey: key,
          fileName: args.fileName,
        })
        .returning({ id: schema.savedTracks.id });
      const row = inserted[0];
      if (!row) throw new Error("uploadTrack: insert returned no rows");
      ctx.invalidateQueries();
      return { trackId: row.id };
    },
  }),

  planAlbumFolder: defineAction({
    description:
      "AI plan for uploading a whole album folder: takes the folder's file list (names + relative paths, no file bytes), groups the audio files into albums by their folder, asks the AI to read each folder's name, parent folder, and sample song file names to name the album and its artist (never inventing an artist the names give no evidence for), parses track numbers, clean song titles, and disc numbers (from 'Disc 2'/'CD1' subfolders and '1-03' style file names) deterministically, and spots the folder's cover picture (cover/folder/front image). The client shows the plan, then creates the album and uploads each file in plan order.",
    request: z.object({
      files: z
        .array(
          z.object({
            name: z.string().min(1).max(300),
            path: z.string().min(1).max(600),
            size: z.number().int().min(0),
          }),
        )
        .min(1)
        .max(400),
    }),
    response: z.object({
      albums: z.array(
        z.object({
          folderName: z.string(),
          artist: z.string(),
          title: z.string(),
          coverFileIndex: z.number().nullable(),
          tracks: z.array(
            z.object({
              fileIndex: z.number(),
              title: z.string(),
              trackNumber: z.number(),
              discNumber: z.number(),
            }),
          ),
        }),
      ),
      audioCount: z.number(),
    }),
    async handler(ctx, args) {
      const AUDIO = new Set([
        "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif",
        "aiff", "wma",
      ]);
      const IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp"]);
      const extOf = (name: string) => {
        const m = name.match(/\.([a-z0-9]+)$/i);
        return m ? m[1]!.toLowerCase() : "";
      };
      const DISC_SEG = /^(?:cd|disc|disk)\s*[-_. ]?(\d{1,2})$/i;
      const cleanText = (s: string) =>
        s.replace(/_/g, " ").replace(/\s+/g, " ").trim();

      type RawTrack = {
        fileIndex: number;
        name: string;
        path: string;
        parsedNum: number | null;
        parsedDisc: number | null;
        title: string;
      };
      type Group = {
        folderName: string;
        parentName: string;
        tracks: RawTrack[];
        coverFileIndex: number | null;
        coverSize: number;
      };
      const groups = new Map<string, Group>();
      const images: { fileIndex: number; dirKey: string; size: number }[] =
        [];
      let audioCount = 0;

      args.files.forEach((f, fileIndex) => {
        const parts = f.path.split("/").filter((p) => p.length > 0);
        const dirs = parts.slice(0, -1);
        const ext = extOf(f.name);
        if (IMAGE.has(ext)) {
          images.push({
            fileIndex,
            dirKey: dirs.join("/"),
            size: f.size,
          });
          return;
        }
        if (!AUDIO.has(ext)) return;
        audioCount += 1;
        // A trailing "Disc 2" / "CD1" subfolder belongs to the album
        // folder above it; its number is the disc number.
        let disc = 1;
        let albumDirs = dirs;
        const lastDir = dirs[dirs.length - 1];
        if (lastDir) {
          const dm = lastDir.trim().match(DISC_SEG);
          if (dm && dirs.length >= 2) {
            disc = Number(dm[1]);
            albumDirs = dirs.slice(0, -1);
          }
        }
        const dirKey = albumDirs.join("/");
        let g = groups.get(dirKey);
        if (!g) {
          g = {
            folderName: albumDirs[albumDirs.length - 1] ?? "",
            parentName:
              albumDirs.length >= 2 ? albumDirs[albumDirs.length - 2]! : "",
            tracks: [],
            coverFileIndex: null,
            coverSize: -1,
          };
          groups.set(dirKey, g);
        }
        // Parse the file name: "1-03 Title" (disc-track), "03 Title",
        // "03. Title", "03 - Title" (track number), else bare title.
        const base = f.name.replace(/\.[^.]+$/, "");
        let parsedNum: number | null = null;
        let parsedDisc: number | null = null;
        let title = cleanText(base);
        const dt = base.match(/^\s*(\d{1,2})\s*[-.]\s*(\d{1,3})\s*[-._\s]+(.+)$/);
        const tn = base.match(/^\s*(\d{1,3})\s*[-._\s]+(.+)$/);
        if (dt) {
          parsedDisc = Number(dt[1]);
          parsedNum = Number(dt[2]);
          title = cleanText(dt[3]!);
        } else if (tn) {
          parsedNum = Number(tn[1]);
          title = cleanText(tn[2]!);
        }
        g.tracks.push({
          fileIndex,
          name: f.name,
          path: f.path,
          parsedNum,
          // The "Disc N" subfolder's number counts when the file name
          // itself carries no disc number.
          parsedDisc: parsedDisc ?? (disc > 1 ? disc : null),
          title: title || cleanText(base) || f.name,
        });
      });

      // Cover picture: an image in (or beside) the album folder whose
      // name says it's the cover wins; otherwise the biggest image in
      // the album folder.
      for (const img of images) {
        const f = args.files[img.fileIndex]!;
        const stem = f.name.replace(/\.[^.]+$/, "").toLowerCase();
        const named = /cover|folder|front|album|artwork/.test(stem);
        for (const [key, g] of groups) {
          const inFolder =
            img.dirKey === key ||
            img.dirKey.startsWith(`${key}/`) ||
            key.startsWith(`${img.dirKey}/`);
          if (!inFolder) continue;
          const score = (named ? 1_000_000_000 : 0) + img.size;
          if (score > g.coverSize) {
            g.coverSize = score;
            g.coverFileIndex = img.fileIndex;
          }
        }
      }

      const groupList = [...groups.values()].filter(
        (g) => g.tracks.length > 0,
      );

      // One AI read for all the albums in the folder: folder names are
      // usually "Artist - Album", sit under an artist folder, or the
      // song files themselves are named "Artist - Song".
      const aiNames = new Map<number, { artist: string; title: string }>();
      if (groupList.length > 0) {
        try {
          const listing = groupList
            .map(
              (g, i) =>
                `Album ${i + 1}: folder "${g.folderName}"${g.parentName ? ` inside folder "${g.parentName}"` : ""}; song files: ${g.tracks
                  .slice(0, 8)
                  .map((t) => `"${t.name}"`)
                  .join(", ")}`,
            )
            .join("\n");
          const out = await ctx.inference.complete(
            `A user is uploading album folders of music they own. For each album below, work out the album title and the main artist from the folder name, the folder it sits inside, and the song file names. Folder names are often "Artist - Album", or just the album title with the artist as the folder above it, or just the album title on its own. The folder an album sits inside is usually the artist's name — and when several albums share the same parent folder, that parent folder is almost certainly the artist for all of them (an artist folder full of their albums). Return the artist exactly as it should appear on an artist profile (main artist only, no feat. guests, correct capitalization). If the names give no real evidence of who the artist is, return an empty artist string for that album — never guess or invent an artist. Return one entry per album, in order.\n\n${listing}`,
            {
              schema: z.object({
                albums: z.array(
                  z.object({
                    album: z.number().int().min(1),
                    artist: z.string().max(200),
                    title: z.string().max(200),
                  }),
                ),
              }),
            },
          );
          for (const a of out.albums) {
            aiNames.set(a.album - 1, {
              artist: a.artist.trim(),
              title: a.title.trim(),
            });
          }
        } catch {
          // Inference unavailable — the deterministic parse below still
          // names every album it can.
        }
      }

      // Parent folders that are just containers ("Music", "Downloads"…)
      // never name an artist; any other parent folder is the artist
      // folder the albums were picked from (e.g. "T.I." holding Trap
      // Musik and King), so it names the artist when nothing better
      // does. The plan card shows it for the user to correct.
      const GENERIC_PARENTS = new Set([
        "music", "downloads", "download", "audio", "albums", "album",
        "songs", "song", "mp3", "mp3s", "files", "file", "documents",
        "document", "media", "sounds", "sound", "tracks", "library",
        "storage", "sdcard", "device", "phone", "internal storage",
        "external storage", "uploads", "upload", "home", "desktop",
        "pictures", "videos", "movies", "tmp", "temp",
      ]);
      const albums = groupList.map((g, gi) => {
        // Deterministic fallback: "Artist - Album" folder names, then
        // the artist folder the album sits inside.
        let fbArtist = "";
        let fbTitle = cleanText(g.folderName);
        const dash = fbTitle.match(/^(.+?)\s+[-–—]\s+(.+)$/);
        if (dash) {
          fbArtist = cleanText(dash[1]!);
          fbTitle = cleanText(dash[2]!);
        }
        if (
          !fbArtist &&
          g.parentName &&
          !GENERIC_PARENTS.has(g.parentName.toLowerCase())
        ) {
          fbArtist = cleanText(g.parentName);
        }
        const ai = aiNames.get(gi);
        const artist = ai?.artist || fbArtist;
        const title = ai?.title || fbTitle || "Untitled album";

        // "101/205" bare prefixes mean disc+track when an album spans
        // more than one disc's worth of them.
        const bare = g.tracks.map((t) => {
          if (t.parsedNum != null) return null;
          const m = t.name
            .replace(/\.[^.]+$/, "")
            .match(/^\s*(\d)(\d{2})\s+(.+)$/);
          return m ? { d: Number(m[1]), n: Number(m[2]), rest: m[3]! } : null;
        });
        const bareDiscs = new Set<number>();
        for (const b of bare) {
          if (b) bareDiscs.add(b.d);
        }
        if (bareDiscs.size >= 2) {
          g.tracks.forEach((t, i) => {
            const b = bare[i];
            if (b) {
              t.parsedDisc = b.d;
              t.parsedNum = b.n;
              t.title = cleanText(b.rest);
            }
          });
        }
        // Drop a leading "Artist - " the files carry once the artist
        // is known, so song titles are just the songs.
        if (artist) {
          const prefix = `${artist.toLowerCase()} - `;
          for (const t of g.tracks) {
            if (t.title.toLowerCase().startsWith(prefix)) {
              t.title = t.title.slice(prefix.length).trim() || t.title;
            }
          }
        }
        const sorted = [...g.tracks].sort((a, b) => {
          const da = a.parsedDisc ?? 1;
          const db = b.parsedDisc ?? 1;
          if (da !== db) return da - db;
          const na = a.parsedNum ?? Number.MAX_SAFE_INTEGER;
          const nb = b.parsedNum ?? Number.MAX_SAFE_INTEGER;
          if (na !== nb) return na - nb;
          return a.path.localeCompare(b.path, undefined, { numeric: true });
        });
        // Keep the files' own track numbers when every song on a disc
        // has one; otherwise number the disc in sorted order.
        const byDisc = new Map<number, RawTrack[]>();
        for (const t of sorted) {
          const d = t.parsedDisc ?? 1;
          const arr = byDisc.get(d) ?? [];
          arr.push(t);
          byDisc.set(d, arr);
        }
        const tracks = sorted.map((t) => {
          const d = t.parsedDisc ?? 1;
          const discTracks = byDisc.get(d) ?? [];
          const allNumbered = discTracks.every((x) => x.parsedNum != null);
          return {
            fileIndex: t.fileIndex,
            title: t.title,
            trackNumber: allNumbered
              ? (t.parsedNum ?? discTracks.indexOf(t) + 1)
              : discTracks.indexOf(t) + 1,
            discNumber: d,
          };
        });
        return {
          folderName: g.folderName,
          artist,
          title,
          coverFileIndex: g.coverFileIndex,
          tracks,
        };
      });

      return { albums, audioCount };
    },
  }),

  uploadAlbumCover: defineAction({
    description:
      "Sets a library album's cover from a picture the user uploads (e.g. the cover.jpg from an uploaded album folder). Stored as an owned blob and shown ahead of any catalog cover the album borrowed.",
    request: z.object({
      albumId: z.number().int().positive(),
      dataBase64: z.string().min(10).max(16_000_000),
      mimeType: z.string().max(100),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedAlbums)
        .where(eq(schema.savedAlbums.id, args.albumId))
        .limit(1);
      if (!rows[0]) throw new Error("That album isn't in your library anymore.");
      const bytes = Buffer.from(args.dataBase64, "base64");
      if (bytes.length === 0) throw new Error("That picture looks empty.");
      if (bytes.length > 12 * 1024 * 1024) {
        throw new Error("Cover pictures are capped at 12 MB in the app.");
      }
      const key = `album-cover/${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await ctx.blobs.put(key, bytes, {
        contentType: args.mimeType || "image/jpeg",
      });
      await db
        .update(schema.savedAlbums)
        .set({ artworkBlobKey: key })
        .where(eq(schema.savedAlbums.id, args.albumId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  getTrackPlayback: defineAction({
    description: "Returns a playable URL for a saved track's uploaded full file.",
    request: z.object({ trackId: z.number().int().positive() }),
    response: z.object({ url: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.savedTracks)
        .where(eq(schema.savedTracks.id, args.trackId))
        .limit(1);
      const t = rows[0];
      if (!t?.blobKey) return { url: null };
      const url = await ctx.blobs.getUrl(t.blobKey);
      return { url };
    },
  }),

  getPlaylistItemPlayback: defineAction({
    description: "Returns a playable URL for a playlist item's uploaded full file.",
    request: z.object({ itemId: z.number().int().positive() }),
    response: z.object({ url: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.playlistItems)
        .where(eq(schema.playlistItems.id, args.itemId))
        .limit(1);
      const t = rows[0];
      if (!t?.blobKey) return { url: null };
      const url = await ctx.blobs.getUrl(t.blobKey);
      return { url };
    },
  }),

  createPlaylist: defineAction({
    description: "Creates a new empty playlist in the library.",
    request: z.object({ name: z.string().min(1).max(120) }),
    response: z.object({ playlistId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const inserted = await db
        .insert(schema.playlists)
        .values({ name: args.name })
        .returning({ id: schema.playlists.id });
      const row = inserted[0];
      if (!row) throw new Error("createPlaylist: insert returned no rows");
      ctx.invalidateQueries();
      return { playlistId: row.id };
    },
  }),

  addToPlaylist: defineAction({
    description: "Adds a song (catalog preview or a saved uploaded track) to a playlist.",
    request: z.object({
      playlistId: z.number().int().positive(),
      title: z.string().min(1).max(300),
      artist: z.string().min(1).max(300),
      previewUrl: z.string().nullable().default(null),
      artworkUrl: z.string().nullable().default(null),
      durationMs: z.number().int().min(0).default(0),
      savedTrackId: z.number().int().positive().nullable().default(null),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      let blobKey: string | null = null;
      if (args.savedTrackId) {
        const rows = await db
          .select()
          .from(schema.savedTracks)
          .where(eq(schema.savedTracks.id, args.savedTrackId))
          .limit(1);
        blobKey = rows[0]?.blobKey ?? null;
      }
      await db.insert(schema.playlistItems).values({
        playlistId: args.playlistId,
        title: args.title,
        artist: args.artist,
        previewUrl: args.previewUrl,
        artworkUrl: args.artworkUrl,
        durationMs: args.durationMs,
        blobKey,
        savedTrackId: args.savedTrackId,
      });
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  removePlaylistItem: defineAction({
    description: "Removes one item from a playlist.",
    request: z.object({ itemId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.playlistItems)
        .where(eq(schema.playlistItems.id, args.itemId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  deletePlaylist: defineAction({
    description: "Deletes a playlist and its items.",
    request: z.object({ playlistId: z.number().int().positive() }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.playlistItems)
        .where(eq(schema.playlistItems.playlistId, args.playlistId));
      await db
        .delete(schema.playlists)
        .where(eq(schema.playlists.id, args.playlistId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  recordPlay: defineAction({
    description: "Records a played song in the user's listening history.",
    request: z.object({
      title: z.string().min(1).max(300),
      artist: z.string().min(1).max(300),
      artworkUrl: z.string().nullable().default(null),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db.insert(schema.playHistory).values({
        title: args.title,
        artist: args.artist,
        artworkUrl: args.artworkUrl,
      });
      return { ok: true as const };
    },
  }),

  searchYouTube: defineAction({
    description:
      "Searches YouTube for videos and songs: returns real YouTube results (video title, channel, thumbnail, duration, views) that play in the app's embedded YouTube player or open on YouTube.",
    request: z.object({ query: z.string().min(1).max(120) }),
    response: z.object({
      videos: z.array(youtubeVideoOut),
      source: z.string(),
    }),
    async handler(_ctx, args) {
      const primary = await youtubeSearchInnertube(args.query);
      if (primary.length > 0) return { videos: primary, source: "YouTube" };
      const fallback = await youtubeSearchResultsPage(args.query);
      return { videos: fallback, source: "YouTube" };
    },
  }),

  requestPlayback: defineAction({
    description:
      "Muse connection — assistant-triggered playback: call this when the user asks Muse in chat or on a call to play a track (e.g. 'play a song by DMX', 'play Ruff Ryders Anthem by DMX', 'play Party Up by DMX — explicit'). It parses '<song> by <artist>' asks and explicit/clean version asks, resolves to a real playable track — the user's own uploaded file first, otherwise the catalog rendition they asked for (explicit when they ask for it or when both renditions exist and they didn't ask for clean) — and queues it as a pending request. The open app polls for it, pulls it right up in its own player within a few seconds, and acks it; poll playbackRequestStatus with the returned requestId to confirm it started.",
    request: z.object({ query: z.string().min(1).max(200) }),
    response: z.object({
      found: z.boolean(),
      requestId: z.number().nullable(),
      title: z.string().nullable(),
      artist: z.string().nullable(),
      artworkUrl: z.string().nullable(),
      source: z.string().nullable(),
      note: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const raw = args.query.trim();
      // Version ask: "explicit" / "clean" anywhere in the ask wins; with
      // no version named, the explicit rendition is preferred when both
      // exist (the user's standing preference).
      const wantsClean = /\bclean\b/i.test(raw);
      const wantsExplicit = /\bexplicit\b/i.test(raw);
      const preferVersion = (list: TrackOut[]): TrackOut | undefined => {
        if (list.length === 0) return undefined;
        if (wantsClean) {
          return (
            list.find((t) => t.explicitness === "clean") ??
            list.find((t) => t.explicitness === "none") ??
            list[0]
          );
        }
        if (wantsExplicit) {
          return list.find((t) => t.explicitness === "explicit") ?? list[0];
        }
        return list.find((t) => t.explicitness === "explicit") ?? list[0];
      };
      const cleaned =
        raw
          .replace(/^(please\s+)?(play|put on|start)\s+/i, "")
          .replace(/\b(a|the|some|track|song)\b/gi, " ")
          .replace(/\b(explicit|clean|version)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim() || raw;
      // "<song> by <artist>" — the natural way people ask Muse.
      const byParts = cleaned.split(/\s+by\s+/i);
      const songPart = (byParts[0] ?? "").trim();
      const artistPart = byParts.length > 1 ? (byParts[byParts.length - 1] ?? "").trim() : "";

      type Resolved = {
        title: string;
        artist: string;
        artworkUrl: string | null;
        previewUrl: string | null;
        fallbackPreviewUrl: string | null;
        durationMs: number;
        albumTitle: string | null;
        savedTrackId: number | null;
        source: string;
        version: string;
      };
      let resolved: Resolved | null = null;

      // 1) The user's own uploads win — a full file beats any preview.
      const tokens = cleaned
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 2);
      const saved = await db.select().from(schema.savedTracks);
      const uploads = saved.filter((t) => t.blobKey);
      const uploadMatch =
        uploads.find((t) => {
          const hay = `${t.title} ${t.artist}`.toLowerCase();
          return tokens.length > 0 && tokens.every((w) => hay.includes(w));
        }) ??
        uploads.find((t) => {
          const hay = `${t.title} ${t.artist}`.toLowerCase();
          return tokens.some((w) => hay.includes(w));
        });
      if (uploadMatch) {
        resolved = {
          title: uploadMatch.title,
          artist: uploadMatch.artist,
          artworkUrl: uploadMatch.artworkUrl,
          previewUrl: uploadMatch.previewUrl,
          fallbackPreviewUrl: null,
          durationMs: uploadMatch.durationMs,
          albumTitle: null,
          savedTrackId: uploadMatch.id,
          source: "your uploaded file",
          version: "your file",
        };
      }

      // 2) DMX asks reuse the spotlight resolution, so "play a DMX track"
      // lands on his essentials in order (X Gon' Give It to Ya first), and
      // "play Ruff Ryders Anthem by DMX" lands on that exact song.
      if (!resolved && cleaned.toLowerCase().includes("dmx")) {
        try {
          const spot = await buildDmxSpotlight();
          const rest = (artistPart ? songPart : cleaned)
            .toLowerCase()
            .replace(/dmx/g, " ")
            .replace(/\s+/g, " ")
            .trim();
          const firstTitle = spot.tracks[0]
            ? normTitle(spot.tracks[0].title)
            : "";
          let pick: TrackOut | undefined = preferVersion(
            spot.tracks.filter((t) => normTitle(t.title) === firstTitle),
          );
          if (rest.length > 2) {
            const restTokens = rest
              .split(/\s+/)
              .filter((w) => w.length > 2);
            const hits = spot.tracks.filter(
              (t) =>
                normTitle(t.title).includes(normTitle(rest)) ||
                (restTokens.length > 0 &&
                  restTokens.every((w) => normTitle(t.title).includes(w))),
            );
            if (hits.length > 0) pick = preferVersion(hits);
          }
          if (pick) {
            resolved = {
              title: pick.title,
              artist: pick.artist,
              artworkUrl: pick.artworkUrl,
              previewUrl: pick.previewUrl,
              fallbackPreviewUrl: pick.fallbackPreviewUrl,
              durationMs: pick.durationMs,
              albumTitle: pick.albumTitle || null,
              savedTrackId: null,
              source: "catalog preview",
              version: pick.explicitness,
            };
          }
        } catch {
          // fall through to the generic catalog search
        }
      }

      // 3) Generic catalog search, expanded to both renditions.
      if (!resolved) {
        const searchTerm = artistPart
          ? `${songPart} ${artistPart}`
          : cleaned;
        const [songJson, dzInfo] = await Promise.all([
          itunes(
            `search?term=${encodeURIComponent(searchTerm)}&media=music&entity=song&limit=15&country=US`,
          ),
          deezerInfoFor(searchTerm).catch(() => new Map<string, DzInfo>()),
        ]);
        const cands = expandVersions(
          resultsOf(songJson)
            .map(toTrack)
            .filter((t) => t.title && t.previewUrl),
          dzInfo,
        );
        const artistHits = artistPart
          ? cands.filter((t) => artistsMatch(t.artist, artistPart))
          : [];
        const titleHits = (artistHits.length > 0 ? artistHits : cands).filter(
          (t) =>
            !songPart ||
            !artistPart ||
            normTitle(t.title).includes(normTitle(songPart)) ||
            normTitle(songPart).includes(normTitle(t.title)),
        );
        const pool =
          titleHits.length > 0
            ? titleHits
            : artistHits.length > 0
              ? artistHits
              : cands;
        const pick = preferVersion(pool);
        if (pick) {
          resolved = {
            title: pick.title,
            artist: pick.artist,
            artworkUrl: pick.artworkUrl,
            previewUrl: pick.previewUrl,
            fallbackPreviewUrl: pick.fallbackPreviewUrl,
            durationMs: pick.durationMs,
            albumTitle: pick.albumTitle || null,
            savedTrackId: null,
            source: "catalog preview",
            version: pick.explicitness,
          };
        }
      }

      if (!resolved) {
        return {
          found: false,
          requestId: null,
          title: null,
          artist: null,
          artworkUrl: null,
          source: null,
          note: `Couldn't find a playable track for "${raw}" in the catalog or in the user's uploads. Try naming the artist and the song title.`,
        };
      }

      // Only the newest ask matters — close out anything still pending.
      await db
        .update(schema.playbackRequests)
        .set({ status: "done", updatedAt: new Date() })
        .where(eq(schema.playbackRequests.status, "pending"));
      const inserted = await db
        .insert(schema.playbackRequests)
        .values({
          query: raw,
          title: resolved.title,
          artist: resolved.artist,
          artworkUrl: resolved.artworkUrl,
          previewUrl: resolved.previewUrl,
          fallbackPreviewUrl: resolved.fallbackPreviewUrl,
          durationMs: resolved.durationMs,
          albumTitle: resolved.albumTitle,
          savedTrackId: resolved.savedTrackId,
          status: "pending",
        })
        .returning({ id: schema.playbackRequests.id });
      const row = inserted[0];
      if (!row) throw new Error("requestPlayback: insert returned no rows");
      ctx.invalidateQueries();
      return {
        found: true,
        requestId: row.id,
        title: resolved.title,
        artist: resolved.artist,
        artworkUrl: resolved.artworkUrl,
        source: resolved.source,
        note: `Queued "${resolved.title}" by ${resolved.artist} (${resolved.source}, ${resolved.version} version). If the app is open it pulls it right up in its own player within a few seconds — check playbackRequestStatus for requestId ${row.id} to confirm. If the app isn't open, it starts the next time the app is opened.`,
      };
    },
  }),

  getPendingPlayback: defineAction({
    description:
      "Returns the newest assistant playback request still waiting to be played (the app polls this and starts the track in its own player), or null when nothing is waiting.",
    request: z.object({}),
    response: z.object({ request: playbackRequestOut.nullable() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.playbackRequests)
        .where(eq(schema.playbackRequests.status, "pending"))
        .orderBy(desc(schema.playbackRequests.id))
        .limit(1);
      const r = rows[0];
      if (!r) return { request: null };
      return {
        request: {
          id: r.id,
          query: r.query,
          title: r.title,
          artist: r.artist,
          artworkUrl: r.artworkUrl,
          previewUrl: r.previewUrl,
          fallbackPreviewUrl: r.fallbackPreviewUrl,
          durationMs: r.durationMs,
          albumTitle: r.albumTitle,
          savedTrackId: r.savedTrackId,
        },
      };
    },
  }),

  ackPlayback: defineAction({
    description:
      "The app calls this after it starts (or fails to start) an assistant-requested track, so the request leaves the pending queue and its outcome can be reported back to the user.",
    request: z.object({
      requestId: z.number().int().positive(),
      status: z.enum(["playing", "done", "failed"]),
    }),
    response: okResponse,
    async handler(ctx, args): Promise<z.infer<typeof okResponse>> {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.playbackRequests)
        .set({ status: args.status, updatedAt: new Date() })
        .where(eq(schema.playbackRequests.id, args.requestId));
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  playbackRequestStatus: defineAction({
    description:
      "Checks one assistant playback request by id: which track it resolved to and whether the app has picked it up (pending), started it (playing), moved on (done), or failed to start it (failed).",
    request: z.object({ requestId: z.number().int().positive() }),
    response: z.object({
      found: z.boolean(),
      status: z.string().nullable(),
      title: z.string().nullable(),
      artist: z.string().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.playbackRequests)
        .where(eq(schema.playbackRequests.id, args.requestId))
        .limit(1);
      const r = rows[0];
      if (!r) {
        return { found: false, status: null, title: null, artist: null };
      }
      return {
        found: true,
        status: r.status,
        title: r.title,
        artist: r.artist,
      };
    },
  }),
} satisfies ActionsModule;
