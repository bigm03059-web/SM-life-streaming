import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
useMutation,
useQuery,
useQueryClient,
} from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { PlayerProvider, usePlayer, type PlayTrack } from "./player";
import {
  castReadiness,
  castViaAirplay,
  castViaGoogleCast,
  loadCastSdk,
  onCastChange,
  type CastMedia,
  type CastReadiness,
} from "./cast";
import smLifeCover from "./assets/sm-life-cover.webp";
import {
IconArrowLeft,
IconArrowRight,
IconArrowUpRight,
IconCast,
IconCheck,
IconChevronDown,
IconChevronUp,
IconDownload,
IconGauge,
IconHeadphones,
IconHome,
IconImage,
IconLibrary,
IconLyrics,
IconMic,
IconMoon,
IconMusicNote,
IconNext,
IconPause,
IconPencil,
IconPlay,
IconPlus,
IconPrev,
IconSearch,
IconShuffle,
IconSparkles,
IconSpeaker,
IconSpatial,
IconSun,
IconUpload,
IconVideo,
IconX,
} from "./icons";

type HomeFeed = ApiResponse<typeof api, "homeFeed">;
type CatalogAlbum = HomeFeed["albums"][number];
type CatalogTrack = ApiResponse<typeof api, "searchMusic">["songs"][number];
type CatalogVideo = HomeFeed["videos"][number];
type AlbumDetail = ApiResponse<typeof api, "getAlbum">;
type YouTubeVideo = ApiResponse<typeof api, "searchYouTube">["videos"][number];
type Library = ApiResponse<typeof api, "listLibrary">;
type SavedAlbum = Library["albums"][number];
type SavedTrack = SavedAlbum["tracks"][number];
type PlanTier = ApiResponse<typeof api, "getPlan">["tier"];

const PLAN_LABEL: Record<PlanTier, string> = {
  developer: "Developer",
  free: "Free",
  premium: "Premium",
};

type Overlay =
  | { type: "album"; catalogId: string }
  | { type: "artist"; name: string; artistId: string | null }
  | { type: "saved"; albumId: number }
  | null;

// ---------- small helpers ----------

function fmtDur(ms: number): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Clock readout in seconds, for the YouTube stage's progress line
// ("1:23 / 3:43" — how far in, out of the video's real full length).
function fmtClockSec(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return "0:00";
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

// Whole-album running time for the line under the tracklist, e.g.
// "42 min" or "1 hr 5 min".
function fmtAlbumLength(totalMs: number): string {
  const totalMin = Math.round(totalMs / 60000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
}

function triggerAnchor(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function downloadToDevice(url: string, filename: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("fetch failed");
    const blob = await res.blob();
    const obj = URL.createObjectURL(blob);
    triggerAnchor(obj, filename);
    window.setTimeout(() => URL.revokeObjectURL(obj), 4000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const obj = URL.createObjectURL(blob);
  triggerAnchor(obj, filename);
  window.setTimeout(() => URL.revokeObjectURL(obj), 4000);
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

function catalogToPlay(t: CatalogTrack): PlayTrack {
  return {
    // The clean and explicit renditions of the same song are separate
    // rows, so the key carries the version + its own preview source.
    key: `cat-${t.albumId ?? ""}-${t.trackNumber}-${t.title}-${t.explicitness}-${(t.previewUrl ?? "").slice(-24)}`,
    title: t.title,
    artist: t.artist,
    artworkUrl: t.artworkUrl,
    previewUrl: t.previewUrl,
    fallbackPreviewUrl: t.fallbackPreviewUrl,
    explicitness: t.explicitness,
    durationMs: t.durationMs,
    albumTitle: t.albumTitle,
    // A catalog song: tapping it plays the FULL song in the app's
    // YouTube stage, not just the catalog's 30-second preview.
    fullSong: true,
  };
}

// Version badge: E for the explicit rendition, "Clean" for the edited
// rendition of a song that also exists explicit. Ordinary songs with no
// explicit version get no badge.
function VersionBadge({
  explicitness,
  onDark = false,
}: {
  explicitness: "explicit" | "clean" | "none" | null | undefined;
  onDark?: boolean;
}) {
  if (explicitness === "explicit") {
    return (
      <span
        aria-label="Explicit version"
        title="Explicit version"
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] bg-[var(--text)] font-display text-[10px] font-extrabold text-[var(--bg)]"
      >
        E
      </span>
    );
  }
  if (explicitness === "clean") {
    return (
      <span
        aria-label="Clean version"
        title="Clean version"
        className={`inline-flex shrink-0 items-center justify-center rounded-[3px] border px-1 font-display text-[9px] font-bold uppercase tracking-wide ${
          onDark
            ? "border-white/40 text-white/80"
            : "border-[var(--border)] text-[var(--dim)]"
        }`}
      >
        Clean
      </span>
    );
  }
  return null;
}

function savedToPlay(t: SavedTrack, albumArt: string | null): PlayTrack {
  return {
    key: `saved-${t.id}`,
    title: t.title,
    artist: t.artist,
    artworkUrl: t.artworkUrl ?? albumArt,
    previewUrl: t.previewUrl,
    durationMs: t.durationMs,
    savedTrackId: t.id,
    fileName: t.fileName,
    // Library songs play in full: an uploaded track plays its own
    // file; a saved catalog album has no file, so it routes to the
    // full song on the YouTube stage like any catalog song.
    fullSong: true,
  };
}

function Cover({
  url,
  title,
  size,
}: {
  url: string | null;
  title: string;
  size: string;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt={`Cover art for ${title}`}
        className={`${size} shrink-0 rounded-[var(--radius)] object-cover`}
        loading="lazy"
      />
    );
  }
  return (
    <div
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-[var(--radius)] bg-[var(--surface2)] text-[var(--dim)]`}
    >
      <IconMusicNote className="h-6 w-6" />
    </div>
  );
}

// ---------- track row with playlist add ----------

function AddToPlaylist({
  title,
  artist,
  previewUrl,
  artworkUrl,
  durationMs,
  savedTrackId,
}: {
  title: string;
  artist: string;
  previewUrl: string | null;
  artworkUrl: string | null;
  durationMs: number;
  savedTrackId?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.listLibrary({}),
    enabled: open,
  });
  const addMut = useMutation({
    mutationFn: (playlistId: number) =>
      api.addToPlaylist({
        playlistId,
        title,
        artist,
        previewUrl,
        artworkUrl,
        durationMs,
        savedTrackId: savedTrackId ?? null,
      }),
    onSuccess: () => {
      setMsg("Added ✓");
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const createMut = useMutation({
    mutationFn: (name: string) => api.createPlaylist({ name }),
    onSuccess: (r) => {
      addMut.mutate(r.playlistId);
      setNewName("");
    },
  });
  return (
    <span className="relative inline-block">
      <button
        type="button"
        aria-label={`Add ${title} to a playlist`}
        onClick={() => {
          setOpen((v) => !v);
          setMsg(null);
        }}
        className="btn btn-secondary btn-xs"
      >
        <IconPlus className="h-3.5 w-3.5" />
        Playlist
      </button>
      {open && (
        <span className="absolute right-0 z-30 mt-2 block w-56 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 shadow-xl">
          {msg ? (
            <span className="block text-sm font-semibold text-[var(--text)]">{msg}</span>
          ) : (
            <>
              <span className="mb-2 block text-xs font-bold uppercase tracking-wide text-[var(--dim)]">
                Add to playlist
              </span>
              {(library.data?.playlists ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addMut.mutate(p.id)}
                  className="block w-full rounded-lg px-2 py-1.5 text-left text-sm text-[var(--text)] hover:bg-[var(--surface2)]"
                >
                  {p.name}
                </button>
              ))}
              <span className="mt-2 flex gap-1">
                <input
                  aria-label="New playlist name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="New playlist"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)]"
                />
                <button
                  type="button"
                  disabled={!newName.trim() || createMut.isPending}
                  onClick={() => createMut.mutate(newName.trim())}
                  className="btn btn-primary btn-xs"
                >
                  Create
                </button>
              </span>
            </>
          )}
        </span>
      )}
    </span>
  );
}

function TrackRow({
  track,
  onPlay,
  showAlbumArt = true,
  trackNumber,
}: {
  track: PlayTrack;
  onPlay: () => void;
  showAlbumArt?: boolean;
  // Album tracklists pass the song's number on the album so it reads
  // "1. Song title" — the number sits in its own fixed-width column.
  trackNumber?: number | null;
}) {
  const player = usePlayer();
  const isCurrent = player.current?.key === track.key;
  const isFullFile = Boolean(
    (track.savedTrackId || track.playlistItemId) && !track.previewUrl,
  );
  // Device download — ONLY for the user's own uploaded full file.
  // A catalog track (or a saved catalog track) has a preview URL and
  // no file of its own: it never gets a device download. Its offline
  // copy lives inside the app via the album's Download control
  // (setAlbumDownloaded), never as a file on the device. YouTube
  // content never downloads either — there is no file to fetch.
  const [downloadingFile, setDownloadingFile] = useState(false);
  const canDownloadFile =
    isFullFile &&
    (track.savedTrackId != null || track.playlistItemId != null);
  const downloadFile = async () => {
    if (!canDownloadFile || downloadingFile) return;
    setDownloadingFile(true);
    try {
      let url: string | null = null;
      if (track.savedTrackId != null) {
        const r = await api.getTrackPlayback({ trackId: track.savedTrackId });
        url = r.url;
      } else if (track.playlistItemId != null) {
        const r = await api.getPlaylistItemPlayback({
          itemId: track.playlistItemId,
        });
        url = r.url;
      }
      if (url) {
        await downloadToDevice(
          url,
          track.fileName ?? `${track.artist} - ${track.title}.mp3`,
        );
      }
    } finally {
      setDownloadingFile(false);
    }
  };
  // Tapping the track that's already loaded pauses/resumes it instead of
  // restarting it — the row itself is the play/pause control.
  const handleTap = () => {
    if (isCurrent) player.toggle();
    else onPlay();
  };
  return (
    <div
      className={`flex items-center gap-3 rounded-[var(--radius)] px-2 py-2 ${
        isCurrent ? "bg-[var(--surface2)]" : ""
      }`}
    >
      <button
        type="button"
        aria-label={
          isCurrent
            ? player.playing
              ? `Pause ${track.title}`
              : `Resume ${track.title}`
            : `Play ${trackNumber != null ? `track ${trackNumber}, ` : ""}${track.title} by ${track.artist}${
                track.explicitness === "explicit"
                  ? " (explicit version)"
                  : track.explicitness === "clean"
                    ? " (clean version)"
                    : ""
              }`
        }
        onClick={handleTap}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        {trackNumber != null && (
          <span
            aria-hidden="true"
            className={`w-6 shrink-0 text-center font-display text-sm font-bold tabular-nums ${
              isCurrent ? "text-[var(--accent)]" : "text-[var(--dim)]"
            }`}
          >
            {trackNumber}
          </span>
        )}
        {showAlbumArt && (
          <span className="relative shrink-0">
            <Cover url={track.artworkUrl} title={track.title} size="h-11 w-11" />
            {isCurrent && (
              <span className="absolute inset-0 flex items-center justify-center rounded-[var(--radius)] bg-black/55 text-white">
                {player.loading ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : player.playing ? (
                  <IconPause className="h-4 w-4" />
                ) : (
                  <IconPlay className="h-4 w-4" />
                )}
              </span>
            )}
          </span>
        )}
        <span className="min-w-0">
          <span
            className={`flex items-center gap-1.5 truncate text-sm font-semibold ${
              isCurrent ? "text-[var(--accent)]" : "text-[var(--text)]"
            }`}
          >
            <span className="truncate">
              {track.title}
              {track.savedTrackId && track.durationMs === 0 ? " · full file" : ""}
            </span>
            <VersionBadge explicitness={track.explicitness} />
          </span>
          <span className="block truncate text-xs text-[var(--dim)]">
            {track.artist}
            {track.durationMs ? ` · ${fmtDur(track.durationMs)}` : ""}
            {isCurrent
              ? player.loading
                ? " · Loading…"
                : player.playing
                  ? " · Playing now"
                  : " · Paused"
              : isFullFile
                ? ""
                : track.fullSong
                  ? " · Full song"
                  : " · 30-sec preview"}
          </span>
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1.5">
        {canDownloadFile && (
          <button
            type="button"
            aria-label={`Download ${track.title} (your file) to device`}
            disabled={downloadingFile}
            onClick={() => void downloadFile()}
            className="btn btn-secondary btn-xs"
          >
            <IconDownload className="h-3.5 w-3.5" />
            {downloadingFile ? "Saving…" : "Device"}
          </button>
        )}
        <AddToPlaylist
          title={track.title}
          artist={track.artist}
          previewUrl={track.previewUrl}
          artworkUrl={track.artworkUrl}
          durationMs={track.durationMs}
          savedTrackId={track.savedTrackId ?? null}
        />
      </span>
    </div>
  );
}

function AlbumCard({
  album,
  onOpen,
}: {
  album: CatalogAlbum;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open album ${album.title} by ${album.artist}${
        album.explicitness === "explicit"
          ? " (explicit edition)"
          : album.explicitness === "clean"
            ? " (clean edition)"
            : ""
      }`}
      className="text-left"
    >
      <span className="relative block">
        <Cover url={album.artworkUrl} title={album.title} size="aspect-square w-full" />
        {album.explicitness !== "none" && (
          <span className="absolute bottom-1.5 left-1.5">
            <VersionBadge explicitness={album.explicitness} />
          </span>
        )}
      </span>
      <span className="mt-2 block truncate font-display text-sm font-bold text-[var(--text)]">
        {album.title}
      </span>
      <span className="block truncate text-xs text-[var(--dim)]">
        {album.artist}
        {album.releaseLabel ? ` · ${album.releaseLabel}` : ""}
      </span>
    </button>
  );
}

function VideoCard({
  video,
  onOpen,
}: {
  video: CatalogVideo;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Watch music video ${video.title} by ${video.artist}`}
      className="text-left"
    >
      <span className="relative block">
        <Cover url={video.artworkUrl} title={video.title} size="aspect-video w-full" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-white">
            <IconPlay className="ml-0.5 h-5 w-5" />
          </span>
        </span>
      </span>
      <span className="mt-2 block truncate font-display text-sm font-bold text-[var(--text)]">
        {video.title}
      </span>
      <span className="block truncate text-xs text-[var(--dim)]">
        {video.artist}
        {video.releaseLabel ? ` · ${video.releaseLabel}` : ""}
      </span>
    </button>
  );
}

function YouTubeCard({
  video,
  onOpen,
}: {
  video: YouTubeVideo;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Watch in the app: ${video.title} by ${video.channel} on YouTube`}
      className="text-left"
    >
      <span className="relative block">
        {video.thumbnailUrl ? (
          <img
            src={video.thumbnailUrl}
            alt={`Thumbnail for ${video.title}`}
            className="aspect-video w-full rounded-[var(--radius)] object-cover"
            loading="lazy"
          />
        ) : (
          <Cover url={null} title={video.title} size="aspect-video w-full" />
        )}
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-9 w-12 items-center justify-center rounded-lg bg-[#ff0000] text-white">
            <IconPlay className="ml-0.5 h-4 w-4" />
          </span>
        </span>
        {video.durationLabel && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-bold text-white">
            {video.durationLabel}
          </span>
        )}
      </span>
      <span className="mt-2 block truncate font-display text-sm font-bold text-[var(--text)]">
        {video.title}
      </span>
      <span className="block truncate text-xs text-[var(--dim)]">
        {video.channel}
        {video.viewCountLabel ? ` · ${video.viewCountLabel}` : ""}
        {video.publishedLabel ? ` · ${video.publishedLabel}` : ""}
      </span>
    </button>
  );
}

// ---------- cast ----------
// A Cast button lives in the header (visible on open), in the player,
// and on the video stage. Its panel reports what this network/browser
// can actually reach — Google Cast devices (Chromecast, smart TVs,
// Fire TV / Fire Stick receivers), AirPlay on Safari — and says so
// honestly when nothing castable is found, instead of pretending.

function CastButton({
  media,
  onDark = false,
  dropUp = false,
  withLabel = true,
}: {
  /** What to hand over; null when nothing is playing yet. */
  media: CastMedia | null;
  onDark?: boolean;
  dropUp?: boolean;
  withLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<CastReadiness>(() => castReadiness());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void loadCastSdk().then(() => {
      if (live) setReady(castReadiness());
    });
    const off = onCastChange(() => setReady(castReadiness()));
    return () => {
      live = false;
      off();
    };
  }, [open ]);

  const pickGoogleCast = async () => {
    if (!media) return;
    setBusy(true);
    const r = await castViaGoogleCast(media);
    setBusy(false);
    setNote(r.message);
    if (r.ok) setReady(castReadiness());
  };
  const pickAirplay = () => {
    if (!media) return;
    setNote(castViaAirplay(media).message);
  };

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="Cast to a TV or device"
        aria-expanded={open}
        onClick={() => {
          setNote(null);
          setOpen((v) => !v);
        }}
        className={onDark ? "btn btn-on-dark btn-xs" : "btn btn-secondary"}
      >
        <IconCast className="h-4 w-4" />
        {withLabel && <span>Cast</span>}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Cast to a TV or device"
          className={`absolute right-0 z-50 w-80 max-w-[86vw] rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left shadow-xl ${
            dropUp ? "bottom-full mb-2" : "top-full mt-2"
          }`}
        >
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 font-display text-sm font-bold text-[var(--text)]">
              Cast to a TV or device
            </p>
            <button
              type="button"
              aria-label="Close cast panel"
              onClick={() => setOpen(false)}
              className="icon-btn shrink-0 !p-1.5"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
          {media ? (
            <p className="mt-0.5 truncate text-xs text-[var(--dim)]">
              {media.isVideo ? "Video" : "Now playing"}: {media.title}
              {media.subtitle ? ` — ${media.subtitle}` : ""}
            </p>
          ) : (
            <p className="mt-0.5 text-xs text-[var(--dim)]">
              Nothing is playing yet — start a song or a video first, then
              cast it from here.
            </p>
          )}
          <div className="mt-2 space-y-2">
            {ready.googleCast && ready.castDeviceFound ? (
              <button
                type="button"
                disabled={!media || busy}
                onClick={() => void pickGoogleCast()}
                aria-label="Choose a Chromecast, smart TV, or Fire TV device to cast to"
                className="btn btn-primary btn-block"
              >
                <IconCast className="h-4 w-4" />
                {busy ? "Opening the device list…" : "Choose a TV or device"}
              </button>
            ) : ready.googleCast ? (
              <p className="rounded-md bg-[var(--surface2)] px-2.5 py-2 text-xs text-[var(--dim)]">
                No castable device found on this network right now — no
                Chromecast, smart TV, or Fire TV / Fire Stick is
                reachable. Check the TV is on and on the same Wi-Fi as
                this device.
              </p>
            ) : (
              <p className="rounded-md bg-[var(--surface2)] px-2.5 py-2 text-xs text-[var(--dim)]">
                Google Cast can't run in this browser view, so TVs and
                Fire Sticks can't be reached from here. Casting works
                from Chrome or Android.
              </p>
            )}
            {ready.googleCast && ready.castDeviceFound && (
              <p className="text-[11px] text-[var(--dim)]">
                The list shows the Chromecast, smart TV, and Fire TV /
                Fire Stick receivers on your network. A Fire Stick only
                appears when it's on the same Wi-Fi and set to accept
                Cast — if yours isn't listed, it can't be reached from
                here.
              </p>
            )}
            {ready.airplay ? (
              <button
                type="button"
                disabled={!media}
                onClick={pickAirplay}
                aria-label="Choose an AirPlay TV or Apple TV to cast to"
                className="btn btn-secondary btn-block"
              >
                AirPlay — Apple TV &amp; AirPlay TVs
              </button>
            ) : (
              <p className="text-[11px] text-[var(--dim)]">
                AirPlay isn't offered by this browser (it works in Safari
                on iPhone, iPad, and Mac).
              </p>
            )}
            {ready.sessionActive && (
              <p className="text-[11px] font-semibold text-[var(--text)]">
                A cast session is live — your TV has the stream.
              </p>
            )}
            {note && (
              <p className="text-xs font-semibold text-[var(--text)]">{note}</p>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

// ---------- video dock ----------
// Videos play inside the app's own player: tapping a video opens the
// full-screen stage right here in the app and the full video starts
// playing — no separate page, no external player, and no preview
// step first. The music pauses while a video is open so the two
// never play over each other.

function usePauseMusicOnMount() {
  const { pause } = usePlayer();
  useEffect(() => {
    pause();
  }, [pause]);
}

// ---------- YouTube full-length playback (official IFrame Player API) ----------
// Full videos play through YouTube's own IFrame Player API — the player
// YouTube provides for playing a video start to finish inside another
// app, and the only route that plays the WHOLE video (the catalog clips
// elsewhere in this app are Apple's 30-second previews and can't). The
// API also reports real playback state and errors, so the stage can
// show how far in the video is, offer a replay when it ends, and say
// plainly when a video's owner has switched off playing inside other
// apps (the one case where the full video can only be watched on
// YouTube itself). If the API can't load or the API player errors, the
// stage falls back to the plain official embed iframe, and the "Open on
// YouTube" link is always there.

interface YtPlayer {
  loadVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  setVolume(volume: number): void;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  destroy(): void;
}

interface YtPlayerOptions {
  width?: string | number;
  height?: string | number;
  videoId: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (e: { target: YtPlayer }) => void;
    onStateChange?: (e: { data: number; target: YtPlayer }) => void;
    onError?: (e: { data: number; target: YtPlayer }) => void;
  };
}

interface YtNamespace {
  Player: new (el: HTMLElement, opts: YtPlayerOptions) => YtPlayer;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApiPromise: Promise<YtNamespace | null> | null = null;

// Loads YouTube's IFrame API script once (the same loader pattern the
// Cast SDK uses) and resolves with the API, or null when it can't be
// reached from this view — the caller then shows the honest
// watch-on-YouTube panel. There is no plain-iframe embed anywhere in
// the app: the API player is the only in-app YouTube player, so every
// video gets its real state, clock, resume, and error handling.
function loadYouTubeApi(): Promise<YtNamespace | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise<YtNamespace | null>((resolve) => {
    let settled = false;
    const finish = (yt: YtNamespace | null) => {
      if (settled) return;
      settled = true;
      resolve(yt);
    };
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prevReady?.();
      finish(window.YT ?? null);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => finish(null);
    document.head.appendChild(script);
    window.setTimeout(() => {
      finish(window.YT?.Player ? window.YT : null);
    }, 8000);
  });
  return ytApiPromise;
}

// The videoId inside the server's canonical watch/embed URLs — the API
// player takes the bare ID. Null when neither URL carries one.
function youtubeVideoId(video: YouTubeVideo): string | null {
  const fromEmbed = /\/embed\/([\w-]{6,})/.exec(video.embedUrl);
  if (fromEmbed?.[1]) return fromEmbed[1];
  const fromWatch = /[?&]v=([\w-]{6,})/.exec(video.watchUrl);
  return fromWatch?.[1] ?? null;
}

// A YouTube result's length from the duration label the search
// itself reports ("3:43", "1:02:33") in seconds — used to confirm
// a full-song match really is full-length before it's labeled one.
// Null when the label is missing or unreadable.
function ytDurationSecs(label: string | null | undefined): number | null {
  if (!label) return null;
  const parts = label.split(":").map((p) => Number(p));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) {
    return null;
  }
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

// ---------- Video / Song version matching ----------
// The Video / Song toggle switches between two DIFFERENT YouTube
// videos of the same song: the music video and the song version
// (the explicit audio upload — usually the artist's "- Topic"
// channel post or an "Official Audio" video). These helpers name
// the song a stage's versions belong to and score search results
// for the side being looked for, so a flip loads the real other
// version instead of guessing.

// The artist/title a version search runs on: the shell's track
// info when it has it (a catalog song or video tap), else what the
// opened video's own title/channel carry ("Artist - Title
// (Official Music Video)" on the artist's channel).
function versionSearchBase(
  video: YouTubeVideo,
  trackTitle: string | null,
  trackArtist: string | null,
): { artist: string; title: string } {
  if (trackTitle) return { artist: trackArtist ?? "", title: trackTitle };
  let title = video.title;
  let artist = video.channel.replace(/\s+-\s+Topic$/i, "").trim();
  const dash = title.indexOf(" - ");
  if (dash > 0) {
    const before = title.slice(0, dash).trim();
    if (before) artist = before;
    title = title.slice(dash + 3);
  }
  const cleaned = title
    .replace(/\s*[\(\[][^)\]]*[\)\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { artist, title: cleaned || title.trim() };
}

// How well one search result fits the side being looked for.
// The currently loaded version (and the already-known other side)
// are excluded by ID: the other version must be a different video.
function scoreVersionCandidate(
  v: YouTubeVideo,
  target: "song" | "video",
  excludeIds: Set<string>,
  refSecs: number,
): number {
  if (excludeIds.has(v.videoId)) return -Infinity;
  const t = v.title.toLowerCase();
  const ch = v.channel.toLowerCase();
  const secs = v.durationSecs || ytDurationSecs(v.durationLabel) || 0;
  let s = 0;
  if (target === "song") {
    // The song version: an audio upload, not a video production.
    if (ch.endsWith("- topic")) s += 4;
    if (t.includes("official audio")) s += 4;
    else if (t.includes("(audio)") || t.includes(" audio")) s += 2;
    if (t.includes("explicit")) s += 1;
    if (t.includes("music video") || t.includes("official video")) s -= 4;
    if (t.includes("lyric")) s -= 1;
    // A few-seconds clip is not the full song.
    if (secs > 0 && secs < 60) s -= 5;
  } else {
    if (t.includes("official music video")) s += 4;
    else if (t.includes("music video")) s += 3;
    else if (t.includes("official video")) s += 3;
    if (ch.endsWith("- topic")) s -= 4;
    if (t.includes("official audio")) s -= 4;
  }
  // Close in length to the version already playing: the two
  // versions of one song sit near each other; a different song or
  // a teaser cut usually doesn't.
  if (refSecs > 0 && secs > 0) {
    const diff = Math.abs(secs - refSecs);
    if (diff <= Math.max(20, refSecs * 0.15)) s += 2;
    else if (diff > Math.max(90, refSecs * 0.5)) s -= 2;
  }
  return s;
}

// What the stage shows in place of the player when YouTube itself
// refuses in-app playback. 101/150 = the owner disabled playing inside
// other apps; 100 = the video is gone; anything else is a player fault.
// In every case the honest move is the same: say so and hand over the
// working link out.
function youtubeBlockMessage(code: number | null): string {
  if (code === 101 || code === 150) {
    return "This video's owner has playing inside other apps switched off, so it can't play here. It plays in full on YouTube:";
  }
  if (code === 100) {
    return "YouTube says this video isn't available anymore. You can check it on YouTube:";
  }
  return "YouTube's player couldn't play this video inside the app. It plays in full on YouTube:";
}

// Where a video was left off, kept on this device so closing the
// stage (or the app) mid-video doesn't lose the place: reopening the
// same video resumes from the saved second. Cleared when the video
// plays to the end.
const YT_RESUME_KEY = "sm-life-yt-resume";

function readYtResume(id: string): number {
  try {
    const raw = window.localStorage.getItem(YT_RESUME_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { id?: unknown; t?: unknown };
    if (parsed.id !== id || typeof parsed.t !== "number") return 0;
    return parsed.t > 5 ? parsed.t : 0;
  } catch {
    return 0;
  }
}

function writeYtResume(id: string, t: number) {
  try {
    window.localStorage.setItem(YT_RESUME_KEY, JSON.stringify({ id, t }));
  } catch {
    // Storage unavailable — resume just won't persist this time.
  }
}

function clearYtResume(id: string) {
  try {
    const raw = window.localStorage.getItem(YT_RESUME_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { id?: unknown };
    if (parsed.id === id) window.localStorage.removeItem(YT_RESUME_KEY);
  } catch {
    // Nothing readable to clear.
  }
}

// ---------- Video / Song toggle (YouTube Music style) ----------
// One switch, shown in every full player: Song plays the song
// version — audio only, with the artwork, like Apple Music — and
// Video plays the music video version, the full video right inside
// this same player. Nothing ever jumps out to YouTube or YouTube
// Music. Both full players render this same control so it looks and
// works identically wherever the music is playing.
function VideoSongToggle({
  mode,
  onPick,
}: {
  mode: "song" | "video";
  onPick: (mode: "song" | "video") => void;
}) {
  return (
    <div
      role="group"
      aria-label="Choose the song version or the music video version"
      className="mx-auto flex w-full max-w-xs rounded-full bg-white/10 p-1"
    >
      <button
        type="button"
        aria-label="Song — play the song version, audio only with artwork"
        aria-pressed={mode === "song"}
        onClick={() => onPick("song")}
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-bold transition-colors ${
          mode === "song"
            ? "bg-white text-black"
            : "text-[var(--player-text)] hover:bg-white/10"
        }`}
      >
        <IconMusicNote className="h-4 w-4" />
        Song
      </button>
      <button
        type="button"
        aria-label="Video — play the music video version"
        aria-pressed={mode === "video"}
        onClick={() => onPick("video")}
        className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-sm font-bold transition-colors ${
          mode === "video"
            ? "bg-white text-black"
            : "text-[var(--player-text)] hover:bg-white/10"
        }`}
      >
        <IconVideo className="h-4 w-4" />
        Video
      </button>
    </div>
  );
}

function YouTubeDock({
  video,
  onClose,
  kind = "video",
  startAtSeconds = null,
  returnTrack = null,
  onReturnToSong,
  versionTitle = null,
  versionArtist = null,
  versionDurationMs = 0,
}: {
  video: YouTubeVideo;
  onClose: () => void;
  // "song" when the stage is playing a catalog song's full song
  // (a song tap routes here): every label then says Full song, so
  // it's plain this is the whole song, not a preview or a video.
  kind?: "video" | "song";
  // A position handed over from the audio player (the user flipped
  // a playing song to its video): the video picks up at that second
  // instead of starting over. Null for an ordinary open, which uses
  // the saved resume point as before.
  startAtSeconds?: number | null;
  // The library track this video was flipped to FROM (its own file
  // is the song version, waiting paused in the audio decks): picking
  // Song then hands playback back to that file at the video's
  // current second instead of just hiding the picture. Null when
  // this stage IS the song's player (catalog full songs and plain
  // video opens) — Song then just flips this stage's own view.
  returnTrack?: PlayTrack | null;
  onReturnToSong?: (track: PlayTrack, seconds: number) => void;
  // The song this stage's versions belong to (title / artist /
  // length), when the shell knows it (a catalog song or video tap):
  // the Video / Song toggle searches YouTube with these to find the
  // OTHER version for real. Null for a plain YouTube-result open —
  // the toggle then works from the video's own title and channel.
  versionTitle?: string | null;
  versionArtist?: string | null;
  versionDurationMs?: number;
}) {
  usePauseMusicOnMount();
  const isSong = kind === "song";
  // The version actually loaded in the player right now. It starts
  // as the video the shell opened the stage with — a video open
  // starts on the Video side and stays there until the user flips
  // the toggle; nothing ever switches versions on its own. Flipping
  // the toggle loads the OTHER version (a different YouTube video)
  // into this same player, and this becomes that version.
  const [activeVideo, setActiveVideo] = useState<YouTubeVideo>(video);
  const videoId = youtubeVideoId(activeVideo);
  const propId = youtubeVideoId(video);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<YtPlayer | null>(null);
  const videoIdRef = useRef<string | null>(videoId);
  videoIdRef.current = videoId;
  // "loading" until the API player reports in; "api" once it's live;
  // "blocked" when YouTube refused this video specifically (owner
  // disabled in-app playing, or the video is gone); "unavailable"
  // when the API player itself can't run here (script unreachable, no
  // video ID, or a player-level fault) — that shows the same honest
  // panel with the Open on YouTube link instead of a plain embed.
  const [mode, setMode] = useState<"loading" | "api" | "blocked" | "unavailable">(
    "loading",
  );
  const [blockCode, setBlockCode] = useState<number | null>(null);
  const [ytState, setYtState] = useState<number>(-1);
  const [progress, setProgress] = useState<{ cur: number; dur: number }>({
    cur: 0,
    dur: 0,
  });
  // The stage lives inside the app's own music player — a sheet
  // with the same chrome as the full audio player (slide-up, drag
  // handle, transport, volume, SLOWED + Crossfade at the bottom) —
  // never as a bare fullscreen YouTube takeover. The music player
  // context supplies those standing controls.
  const music = usePlayer();
  // Video / Song: which version this stage is playing. It starts
  // on the side the stage was opened for — a video tap opens on
  // Video and plays the music video; only the user's own flip of
  // the toggle ever changes the version, never anything automatic.
  // A flip loads the other version for real (see pickView below):
  // Song loads the distinct song version — the full explicit audio
  // song, a different YouTube video, shown with the artwork —
  // and Video loads the music video, each picking up at about the
  // second the other was on. The one exception is a video flipped
  // to from a library song's own file (returnTrack): there the
  // song version is that file, so Song hands playback back to it.
  const [view, setView] = useState<"song" | "video">(
    isSong ? "song" : "video",
  );
  // The two versions of this song, by YouTube video. The side the
  // stage opened with is known from the start; the other side is
  // found (and then remembered here) the first time the toggle
  // flips to it, so flipping back loads the exact same version
  // again without a new search.
  const versionsRef = useRef<{
    song: YouTubeVideo | null;
    video: YouTubeVideo | null;
  }>({
    song: isSong ? video : null,
    video: isSong ? null : video,
  });
  // A flip that is still resolving the other version, and a flip
  // whose other version couldn't be found (the current version
  // keeps playing and the note under the toggle says so).
  const [switchingTo, setSwitchingTo] = useState<"song" | "video" | null>(
    null,
  );
  const [switchFailed, setSwitchFailed] = useState<"song" | "video" | null>(
    null,
  );
  const switchSeqRef = useRef(0);
  // The second a version switch should pick up at, re-applied once
  // the newly loaded version starts playing (a load can drop an
  // immediate seek while the new stream buffers).
  const switchSeekRef = useRef<number | null>(null);
  // A new open from the shell (a different video/song handed to the
  // stage) resets the stage to that item, on its own side.
  useEffect(() => {
    setActiveVideo(video);
    versionsRef.current = {
      song: isSong ? video : null,
      video: isSong ? null : video,
    };
    setView(isSong ? "song" : "video");
    setSwitchingTo(null);
    setSwitchFailed(null);
    switchSeekRef.current = null;
    // The stage resets only when the shell hands it a different
    // item — internal version flips change activeVideo, not the prop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propId]);
  const songView = view === "song";
  // The artwork the Song side shows: the song's own cover when this
  // stage is a song's player (or was flipped to from that song),
  // else the video's own thumbnail.
  const songArtwork =
    (isSong || returnTrack
      ? (returnTrack?.artworkUrl ?? music.current?.artworkUrl)
      : null) ?? activeVideo.thumbnailUrl;
  // The handoff second from the audio player, read by the player's
  // ready/load handlers below.
  const startAtRef = useRef<number | null>(startAtSeconds);
  startAtRef.current = startAtSeconds;
  // The sheet's entrance slide-up runs once on mount; once it has
  // landed, dragging the handle moves the sheet with the finger,
  // and a tap or a long drag down closes it back to the page.
  const [entered, setEntered] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<number | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 450);
    return () => window.clearTimeout(t);
  }, []);
  // The player's Volume slider, driving the YouTube player's own
  // volume (0–100 in the IFrame API).
  const [ytVolume, setYtVolume] = useState(100);
  const ytVolumeRef = useRef(100);
  ytVolumeRef.current = ytVolume;
  // Ducking for the stage: while Tiana speaks, drop the video/song
  // to a low level under her voice and restore the slider's level
  // when she finishes — playback position is never touched. The
  // plain-embed fallback has no volume API, so it can't duck; the
  // API player (the normal path) always can.
  useEffect(() => {
    return registerDuckHandler((ducked) => {
      const p = playerRef.current;
      if (!p) return;
      try {
        p.setVolume(ducked ? 12 : ytVolumeRef.current);
      } catch {
        // Player not ready — nothing playing to duck.
      }
    });
  }, []);
  // The second this viewing resumed from, when the video was picked
  // back up mid-way; 0 when it started from the top.
  const [resumedFrom, setResumedFrom] = useState(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const ytStateRef = useRef(-1);
  const lastSavedSecRef = useRef(-1);
  // SLOWED on the video stage: the SAME standing switch as the songs
  // (music.slowed — the one in this sheet's bottom row, next to
  // Crossfade) also drives the YouTube player's own playback rate, so
  // the picture and its audio slow down together, in sync, and stay
  // slowed until the switch is flipped off. Songs slow to 0.72×;
  // YouTube's player only offers fixed rates (0.25 / 0.5 / 0.75 / 1 /
  // 1.25 / …), so the stage picks the available rate closest to the
  // songs' 0.72× — 0.75× — rather than a different-feeling speed.
  // Pitch on this stage is YouTube's own call, and no app gets a say:
  // YouTube's player pitch-corrects at every rate and the IFrame API
  // exposes no pitch control (the player is YouTube's, cross-origin —
  // its internal media element can't be reached to switch pitch
  // preservation off the way the app's own decks and video element
  // do). This rate is as far as YouTube's official player lets any
  // app take SLOWED; the pitch-dropping half of the switch applies
  // wherever the app owns the media element (songs, preview clips).
  const slowedRef = useRef(music.slowed);
  slowedRef.current = music.slowed;
  const applyYtSlowed = useCallback((player: YtPlayer | null) => {
    if (!player) return;
    try {
      const target = slowedRef.current ? 0.72 : 1;
      let rate = target;
      const avail = player.getAvailablePlaybackRates();
      if (avail && avail.length > 0) {
        for (const r of avail) {
          if (Math.abs(r - target) < Math.abs(rate - target)) rate = r;
        }
      }
      player.setPlaybackRate(rate);
    } catch {
      // Rate control unavailable on this player — the video keeps
      // playing at normal speed rather than failing.
    }
  }, []);

  // Create the API player once. A new video while the stage is open
  // goes through loadVideoById (below) — the player is never rebuilt,
  // so nothing reloads or restarts mid-watch.
  useEffect(() => {
    let cancelled = false;
    if (!videoIdRef.current) {
      setMode("unavailable");
      return;
    }
    void loadYouTubeApi().then((YT) => {
      if (cancelled) return;
      const host = hostRef.current;
      const id = videoIdRef.current;
      if (!YT || !host || !id) {
        setMode("unavailable");
        return;
      }
      const target = document.createElement("div");
      target.className = "h-full w-full";
      host.appendChild(target);
      const player = new YT.Player(target, {
        width: "100%",
        height: "100%",
        videoId: id,
        playerVars: {
          autoplay: 1,
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
        },
        events: {
          onReady: (e) => {
            if (cancelled) return;
            setMode("api");
            e.target.setVolume(ytVolumeRef.current);
            // SLOWED is a standing setting: if it's already on when
            // the video starts, the video starts slowed.
            applyYtSlowed(e.target);
            // Pick the video back up where it was left off, if it
            // was closed (or the app was) part-way through. A
            // handoff from the audio player (the user flipped a
            // playing song to its video) wins over the saved point:
            // the video continues at the song's own second.
            const handoff = startAtRef.current;
            const resumeAt =
              handoff !== null && handoff > 5 ? handoff : readYtResume(id);
            if (resumeAt > 0) {
              setResumedFrom(resumeAt);
              e.target.seekTo(resumeAt, true);
            }
            e.target.playVideo();
          },
          onStateChange: (e) => {
            if (cancelled) return;
            ytStateRef.current = e.data;
            setYtState(e.data);
            if (e.data === 1) {
              // Playing: (re)pin the standing SLOWED rate — a fresh
              // video can come up at full speed even while the switch
              // is on, the same snap-back the audio decks guard
              // against on load.
              applyYtSlowed(e.target);
            }
            if (e.data === 1 || e.data === 5) {
              // A version switch that just landed: pick up at the
              // second the other version was on. The seek issued at
              // load time can be dropped while the new stream
              // buffers, so land it again here, once, if the player
              // isn't already there.
              const seek = switchSeekRef.current;
              if (seek !== null) {
                switchSeekRef.current = null;
                try {
                  const cur = e.target.getCurrentTime() || 0;
                  if (Math.abs(cur - seek) > 3) e.target.seekTo(seek, true);
                } catch {
                  // Position unreadable — the load-time seek stands.
                }
              }
            }
            if (e.data === 0) {
              // Played all the way to the end — no place to resume.
              const cur = videoIdRef.current;
              if (cur) clearYtResume(cur);
            }
          },
          onError: (e) => {
            if (cancelled) return;
            // A video-specific refusal (embedding off / video gone)
            // gets the honest blocked panel — an overlay, so the
            // player stays mounted and the next video can still load
            // into it. A player-level fault before anything played
            // retires the API player and shows the same honest panel
            // (message + Open on YouTube) — never a plain embed.
            if (e.data === 101 || e.data === 150 || e.data === 100) {
              setBlockCode(e.data);
              setMode("blocked");
            } else if (modeRef.current !== "api") {
              try {
                playerRef.current?.destroy();
              } catch {
                // Already gone.
              }
              playerRef.current = null;
              setBlockCode(e.data);
              setMode("unavailable");
            }
          },
        },
      });
      playerRef.current = player;
    });
    return () => {
      cancelled = true;
      try {
        playerRef.current?.destroy();
      } catch {
        // Player already gone — nothing to clean up.
      }
      playerRef.current = null;
    };
    // One player for the life of the stage; video changes are handled
    // by the loadVideoById effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New video, same player: hand the API the new ID instead of
  // remounting anything.
  const firstIdRef = useRef<string | null>(videoId);
  useEffect(() => {
    if (firstIdRef.current === videoId) return;
    firstIdRef.current = videoId;
    setBlockCode(null);
    ytStateRef.current = -1;
    setYtState(-1);
    setProgress({ cur: 0, dur: 0 });
    setResumedFrom(0);
    lastSavedSecRef.current = -1;
    if (!videoId) {
      setMode("unavailable");
      return;
    }
    const player = playerRef.current;
    if (player) {
      setMode("api");
      player.loadVideoById(videoId);
      const handoff = startAtRef.current;
      const resumeAt =
        handoff !== null && handoff > 5 ? handoff : readYtResume(videoId);
      if (resumeAt > 0) {
        setResumedFrom(resumeAt);
        try {
          player.seekTo(resumeAt, true);
        } catch {
          // Still loading — it starts from the top this once.
        }
      }
    } else {
      // No live player to hand the video to (the API couldn't load) —
      // the honest panel takes the stage. If the creation effect is
      // still in flight, its onReady flips the stage back to "api".
      setMode("unavailable");
    }
  }, [videoId]);

  // Live progress from the player itself — the readout under the stage
  // is YouTube's own clock, so "played all the way" is visible fact.
  // While the video plays, the position is also saved (once a second)
  // so an interrupted watch resumes where it stopped.
  useEffect(() => {
    if (mode !== "api") return;
    const t = window.setInterval(() => {
      const player = playerRef.current;
      if (!player) return;
      try {
        const cur = player.getCurrentTime() || 0;
        const dur = player.getDuration() || 0;
        setProgress({ cur, dur });
        const id = videoIdRef.current;
        if (
          id &&
          ytStateRef.current === 1 &&
          cur > 5 &&
          (dur === 0 || cur < dur - 3)
        ) {
          const whole = Math.floor(cur);
          if (whole !== lastSavedSecRef.current) {
            lastSavedSecRef.current = whole;
            writeYtResume(id, whole);
          }
        }
      } catch {
        // Mid-teardown read — the next tick or unmount handles it.
      }
    }, 500);
    return () => window.clearInterval(t);
  }, [mode]);

  // Flipping the SLOWED switch while the stage is open slows (or
  // restores) the playing video right away — the switch in this
  // sheet's bottom row calls music.setSlowed, and this is what carries
  // that same setting onto the YouTube player.
  useEffect(() => {
    if (mode === "api") applyYtSlowed(playerRef.current);
  }, [music.slowed, mode, applyYtSlowed]);

  const ended = mode === "api" && ytState === 0;
  const needsTap =
    mode === "api" && (ytState === 5 || (ytState === -1 && progress.cur === 0));
  const playing = mode === "api" && ytState === 1;
  const paused = mode === "api" && ytState === 2;

  // Album play-through: a full song on this stage lives OUTSIDE the
  // audio decks, so the decks' own track-end advance never fires
  // for it — without this, a catalog album would stop dead after
  // track 1. When a song-mode stage plays to the end and the queue
  // has a next track, step to it: the player's jump hands that
  // track to the same full-song routing, its full song is found and
  // opens here, and the album runs on in queue order (the album
  // page queues disc + track order, one rendition per song) until
  // the last track, which stays on the finished panel like a single
  // song does. The step is guarded per video + queue slot so it
  // fires exactly once, and seeking or replaying before the short
  // delay runs cancels it — the user taking control always wins.
  const hasNextSong = isSong && music.index < music.queue.length - 1;
  const nextRef = useRef(music.next);
  nextRef.current = music.next;
  const advancedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ended || !hasNextSong) return;
    const guardKey = `${videoId ?? ""}:${music.index}`;
    if (advancedForRef.current === guardKey) return;
    advancedForRef.current = guardKey;
    const t = window.setTimeout(() => nextRef.current(), 1000);
    return () => window.clearTimeout(t);
  }, [ended, hasNextSong, music.index, videoId]);

  const stageBody = (
    <>
      {mode === "unavailable" || !videoId ? (
        <div className="mt-2 flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-[var(--radius)] bg-black px-4 text-center">
          <p className="max-w-md text-sm text-[var(--player-text)]">
            {youtubeBlockMessage(blockCode)}
          </p>
          <a
            href={activeVideo.watchUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-accent"
          >
            Watch the full video on YouTube
            <IconArrowUpRight className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <div className="relative mt-2 aspect-video w-full overflow-hidden rounded-[var(--radius)] bg-black">
          <div ref={hostRef} className="absolute inset-0" />
          {songView && mode !== "blocked" && (
            // Song view: the stream loaded underneath IS the song
            // version (a different video from the music video); its
            // picture is covered by the artwork so the song plays
            // audio-only, like Apple Music.
            <span className="absolute inset-0 flex items-center justify-center bg-black">
              {songArtwork ? (
                <img
                  src={songArtwork}
                  alt={`Artwork for ${activeVideo.title}`}
                  className="h-full w-full object-contain"
                />
              ) : (
                <IconMusicNote className="h-12 w-12 text-[var(--player-dim)]" />
              )}
            </span>
          )}
          {mode === "loading" && (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-[var(--player-dim)]">
              <span className="rounded-full bg-black/70 px-3 py-1.5">
                {songView ? "Loading the full song…" : "Loading the full video…"}
              </span>
            </p>
          )}
          {mode === "blocked" && (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black px-4 text-center">
              <p className="max-w-md text-sm text-[var(--player-text)]">
                {youtubeBlockMessage(blockCode)}
              </p>
              <a
                href={activeVideo.watchUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-accent"
              >
                Watch the full video on YouTube
                <IconArrowUpRight className="h-4 w-4" />
              </a>
            </span>
          )}
          {needsTap && mode === "api" && (
            <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <button
                type="button"
                aria-label={
                  songView
                    ? `Play the full song: ${activeVideo.title}`
                    : `Play the full video: ${activeVideo.title}`
                }
                onClick={() => playerRef.current?.playVideo()}
                className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#ff0000] text-white"
              >
                <IconPlay className="ml-1 h-8 w-8" />
              </button>
            </span>
          )}
          {ended && (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
              <p className="font-display text-base font-bold text-white">
                {songView
                  ? hasNextSong
                    ? "Song finished — playing the next track…"
                    : "Song finished — you heard the whole song"
                  : "Video finished — you watched it all the way through"}
              </p>
              <button
                type="button"
                aria-label={`Watch ${activeVideo.title} again from the start`}
                onClick={() => {
                  const player = playerRef.current;
                  if (!player) return;
                  setResumedFrom(0);
                  player.seekTo(0, true);
                  player.playVideo();
                }}
                className="btn btn-accent"
              >
                <IconPlay className="h-4 w-4" />
                Watch again
              </button>
            </span>
          )}
        </div>
      )}
    </>
  );

  // The sheet's transport: the big round button drives the YouTube
  // player itself (pause / resume / replay from the top when it has
  // finished). In song mode the queue's prev/next step to the
  // neighbouring song, which resolves its own full song the same
  // way this one did.
  // The second the loaded version is on right now, from the player
  // itself (the progress state is the fallback — it refreshes twice
  // a second from the same clock).
  const currentSecond = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      try {
        const t = player.getCurrentTime();
        if (Number.isFinite(t) && t > 0) return t;
      } catch {
        // Fall through to the progress state.
      }
    }
    return progress.cur;
  }, [progress.cur]);

  // Load a different version into this same player, picking up at
  // the second the current version is on. The flip is a real stream
  // change — a different YouTube video loads — never a cover laid
  // over the same stream. firstIdRef is moved first so the
  // prop-change load effect doesn't load the same video twice.
  const loadVersion = useCallback(
    (next: YouTubeVideo, m: "song" | "video") => {
      const id = youtubeVideoId(next);
      const at = currentSecond();
      setSwitchFailed(null);
      setBlockCode(null);
      ytStateRef.current = -1;
      setYtState(-1);
      setResumedFrom(0);
      lastSavedSecRef.current = -1;
      switchSeekRef.current = at > 5 ? at : null;
      if (id) firstIdRef.current = id;
      setActiveVideo(next);
      setView(m);
      const player = playerRef.current;
      if (player && id) {
        setMode("api");
        setProgress({ cur: at, dur: 0 });
        try {
          player.loadVideoById(id);
          if (at > 5) player.seekTo(at, true);
          player.playVideo();
        } catch {
          // The state-change handler lands the pending seek when
          // the new stream starts; a hard failure surfaces through
          // the player's own error path.
        }
      }
    },
    [currentSecond],
  );

  // Find the OTHER version of this song on YouTube: for Song, the
  // song version (the explicit audio upload — a Topic-channel post
  // or an "Official Audio" video, full-length, and a different
  // video from the music video); for Video, the music video.
  // Returns null when no distinct version turns up, so the flip
  // can say so honestly instead of faking the switch.
  const findVersion = useCallback(
    async (target: "song" | "video"): Promise<YouTubeVideo | null> => {
      const base = versionSearchBase(activeVideo, versionTitle, versionArtist);
      if (!base.title) return null;
      const refSecs =
        (versionDurationMs > 0 ? versionDurationMs / 1000 : 0) ||
        activeVideo.durationSecs ||
        progress.dur ||
        0;
      const exclude = new Set<string>();
      exclude.add(activeVideo.videoId);
      const knownSong = versionsRef.current.song;
      const knownVideo = versionsRef.current.video;
      if (knownSong) exclude.add(knownSong.videoId);
      if (knownVideo) exclude.add(knownVideo.videoId);
      const queries =
        target === "song"
          ? [
              `${base.artist} ${base.title} official audio`.trim(),
              `${base.artist} ${base.title} audio`.trim(),
            ]
          : [
              `${base.artist} ${base.title} official music video`.trim(),
              `${base.artist} ${base.title} music video`.trim(),
            ];
      for (const query of queries) {
        try {
          const res = await api.searchYouTube({ query });
          let best: YouTubeVideo | null = null;
          let bestScore = -Infinity;
          for (const v of res.videos) {
            const s = scoreVersionCandidate(v, target, exclude, refSecs);
            if (s > bestScore) {
              bestScore = s;
              best = v;
            }
          }
          if (best && bestScore >= 2) return best;
        } catch {
          // Try the next query shape; a total failure returns null.
        }
      }
      return null;
    },
    [activeVideo, versionTitle, versionArtist, versionDurationMs, progress.dur],
  );

  // Video / Song flips. A flip loads the other version for real:
  // the remembered one when this stage has already found it, else
  // a fresh search for it — either way the new stream picks up at
  // about the second the old one was on, inside this same player.
  // Nothing switches on its own: the version only ever changes
  // here, on the user's flip. The single exception to the search:
  // this video was flipped to from a library song's own file, and
  // Song is picked — the song version there is that file, so the
  // shell hands playback back to it at the video's current second.
  const pickView = (m: "song" | "video") => {
    if (m === view || switchingTo) return;
    if (m === "song" && returnTrack && onReturnToSong) {
      onReturnToSong(returnTrack, currentSecond());
      return;
    }
    const known = versionsRef.current[m];
    if (known) {
      loadVersion(known, m);
      return;
    }
    setSwitchFailed(null);
    setSwitchingTo(m);
    const seq = (switchSeqRef.current += 1);
    void (async () => {
      const found = await findVersion(m);
      if (switchSeqRef.current !== seq) return;
      setSwitchingTo(null);
      if (found) {
        versionsRef.current[m] = found;
        loadVersion(found, m);
      } else {
        setSwitchFailed(m);
      }
    })();
  };
  const toggleYt = () => {
    const player = playerRef.current;
    if (!player || mode !== "api") return;
    if (ended) {
      setResumedFrom(0);
      player.seekTo(0, true);
      player.playVideo();
    } else if (playing) {
      player.pauseVideo();
    } else {
      player.playVideo();
    }
  };
  const handleDown = (e: ReactPointerEvent) => {
    dragStartRef.current = e.clientY;
    setDragging(true);
    setDragOffset(0);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety — the threshold logic still works without it.
    }
  };
  const handleMove = (e: ReactPointerEvent) => {
    if (dragStartRef.current !== null) {
      setDragOffset(Math.max(0, e.clientY - dragStartRef.current));
    }
  };
  const handleUp = () => {
    if (dragStartRef.current === null) return;
    dragStartRef.current = null;
    setDragging(false);
    // A real drag down past the threshold — or a plain tap on the
    // handle — closes the player back to the page. A short drag
    // snaps back up.
    if (dragOffset > 90 || dragOffset <= 6) {
      onClose();
    } else {
      setDragOffset(0);
    }
  };
  const handleCancel = () => {
    dragStartRef.current = null;
    setDragging(false);
    setDragOffset(0);
  };

  return (
    <section
      aria-label={
        songView
          ? `Song playing in the music player, audio only with artwork: ${activeVideo.title}`
          : `Video playing in the music player: ${activeVideo.title}`
      }
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setEntered(true);
      }}
      style={
        entered
          ? {
              transform: `translateY(${dragOffset}px)`,
              transition: dragging ? undefined : "transform 0.22s ease",
            }
          : undefined
      }
      className="player-console player-sheet-anim fixed inset-0 z-50 flex flex-col px-4 pb-3 pt-safe"
    >
      <div
        role="button"
        aria-label="Close the player"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClose();
          }
        }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleCancel}
        className="flex cursor-pointer touch-none flex-col items-center pb-1 pt-1"
      >
        <span className="h-1 w-10 rounded-full bg-white/25" aria-hidden="true" />
        <span className="mt-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-widest text-[var(--player-dim)]">
          <IconChevronDown className="h-4 w-4" />
          Now playing
        </span>
      </div>
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col overflow-y-auto">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold text-[var(--player-text)]">
              {activeVideo.title}
            </p>
            <p className="truncate text-xs text-[var(--player-dim)]">
              {activeVideo.channel} · YouTube ·{" "}
              {songView ? "Song version · audio only" : "Music video · full video"}
              {activeVideo.durationLabel ? ` · ${activeVideo.durationLabel}` : ""}
            </p>
          </div>
          <a
            href={activeVideo.watchUrl}
            target="_blank"
            rel="noreferrer"
            className="btn btn-on-dark btn-xs shrink-0"
          >
            Open on YouTube
            <IconArrowUpRight className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            aria-label={songView ? "Close full song" : "Close YouTube video"}
            onClick={onClose}
            className="icon-btn shrink-0"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>
        <div className="mt-3">
          <VideoSongToggle mode={view} onPick={pickView} />
          <p className="mt-1.5 text-center text-xs text-[var(--player-dim)]">
            {switchingTo
              ? switchingTo === "song"
                ? "Finding the song version…"
                : "Finding the music video…"
              : switchFailed
                ? switchFailed === "song"
                  ? "Couldn't find a separate song version on YouTube, so the music video keeps playing."
                  : "Couldn't find the music video on YouTube, so the song version keeps playing."
                : songView
                  ? "Song version — the song itself, audio only with the artwork. Tap Video to watch the music video, picking up right where the song is."
                  : returnTrack
                    ? "Music video version — tap Song to flip back to the song, right where the video is."
                    : "Music video version — tap Song to hear the song version, picking up right where the video is."}
          </p>
        </div>
        {stageBody}
        {mode === "api" && (
          <>
            <div className="mt-3 flex items-center gap-2">
              <span className="w-9 text-right text-[11px] text-[var(--player-dim)]">
                {fmtClockSec(progress.cur)}
              </span>
              <button
                type="button"
                aria-label={
                  songView ? "Seek through the song" : "Seek through the video"
                }
                onClick={(e) => {
                  const player = playerRef.current;
                  if (!player || progress.dur <= 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const frac = Math.min(
                    1,
                    Math.max(0, (e.clientX - rect.left) / rect.width),
                  );
                  player.seekTo(frac * progress.dur, true);
                }}
                className="flex h-5 min-w-0 flex-1 items-center"
              >
                <span
                  className="h-1 w-full overflow-hidden rounded-full bg-white/15"
                  role="progressbar"
                  aria-label={
                    songView
                      ? "How far the song has played"
                      : "How far the video has played"
                  }
                  aria-valuemin={0}
                  aria-valuemax={Math.round(progress.dur)}
                  aria-valuenow={Math.round(progress.cur)}
                >
                  <span
                    className="block h-full bg-[var(--accent)]"
                    style={{
                      width: `${
                        progress.dur > 0
                          ? Math.min(100, (progress.cur / progress.dur) * 100)
                          : 0
                      }%`,
                    }}
                  />
                </span>
              </button>
              <span className="w-9 text-[11px] text-[var(--player-dim)]">
                {fmtClockSec(progress.dur)}
              </span>
            </div>
            <p className="mt-0.5 text-center text-xs text-[var(--player-dim)]">
              {playing
                ? songView
                  ? "Playing the full song"
                  : "Playing the full video"
                : ended
                  ? "Finished"
                  : paused
                    ? "Paused"
                    : ytState === 3
                      ? "Loading…"
                      : songView
                        ? "Full song"
                        : "Full video"}
              {resumedFrom > 0 && !ended
                ? ` · Picked up where you left off, at ${fmtClockSec(resumedFrom)}`
                : ""}
            </p>
            <div className="mt-1 flex items-center justify-center gap-5">
              {isSong && music.queue.length > 1 && (
                <button
                  type="button"
                  aria-label="Previous track"
                  onClick={music.prev}
                  className="icon-btn"
                >
                  <IconPrev className="h-7 w-7" />
                </button>
              )}
              <button
                type="button"
                aria-label={
                  playing
                    ? "Pause"
                    : ended
                      ? songView
                        ? "Play the song again from the start"
                        : "Play the video again from the start"
                      : "Play"
                }
                onClick={toggleYt}
                className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-opacity hover:opacity-90"
              >
                {playing ? (
                  <IconPause className="h-6 w-6" />
                ) : (
                  <IconPlay className="ml-0.5 h-6 w-6" />
                )}
              </button>
              {isSong && music.queue.length > 1 && (
                <button
                  type="button"
                  aria-label="Next track"
                  onClick={music.next}
                  className="icon-btn"
                >
                  <IconNext className="h-7 w-7" />
                </button>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--player-dim)]">
                Volume
              </span>
              <input
                type="range"
                aria-label="Volume"
                min={0}
                max={100}
                value={ytVolume}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setYtVolume(v);
                  playerRef.current?.setVolume(v);
                }}
                className="min-w-0 flex-1"
              />
              <span className="w-9 text-[11px] text-[var(--player-dim)]">
                {ytVolume}%
              </span>
            </div>
          </>
        )}
      </div>
      <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-center gap-x-6 gap-y-1 border-t border-[var(--player-border)] pt-2.5">
        <button
          type="button"
          aria-label="Toggle slow down pitch and speed"
          aria-pressed={music.slowed}
          onClick={() => music.setSlowed(!music.slowed)}
          className="btn-toggle btn-toggle-amber text-base"
        >
          <IconGauge className="h-4 w-4" />
          SLOWED
          <span className="switch" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Toggle DJ crossfade"
          aria-pressed={music.crossfadeOn}
          onClick={() => music.setCrossfadeOn(!music.crossfadeOn)}
          className="btn-toggle text-base"
        >
          <IconShuffle className="h-4 w-4" />
          Crossfade
          <span className="switch" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

// The stage shown on the player while a tapped catalog video's full
// video is being found, and when it can't be found. A video tap goes
// straight to the full video — this is never a preview step: while
// loading it just says so, and on failure it offers a retry, with the
// catalog's short preview as an explicit fallback the user can pick
// (the only way the preview still plays).
function VideoLoadDock({
  video,
  status,
  onClose,
  onRetry,
  onPreview,
}: {
  // Just the fields the stage reads — a catalog video fits, and so
  // does a player track whose music video is being found (the full
  // player's Video pick resolves through this same stage).
  video: { title: string; artist: string; previewUrl: string | null };
  status: "loading" | "failed";
  onClose: () => void;
  onRetry: () => void;
  onPreview: () => void;
}) {
  usePauseMusicOnMount();
  return (
    <section
      aria-label={
        status === "loading"
          ? `Loading the full video: ${video.title} by ${video.artist}`
          : `The full video of ${video.title} by ${video.artist} couldn't be found`
      }
      className="player-console border-t border-[var(--player-border)]"
    >
      <div className="mx-auto max-w-5xl px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold text-[var(--player-text)]">
              {video.title}
            </p>
            <p className="truncate text-xs text-[var(--player-dim)]">
              {video.artist} · Full video
            </p>
          </div>
          <button
            type="button"
            aria-label="Close video"
            onClick={onClose}
            className="icon-btn shrink-0"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>
        {status === "loading" ? (
          <p className="mt-2 text-sm text-[var(--player-dim)]">
            Loading the full video…
          </p>
        ) : (
          <div className="mt-2 sm:max-w-2xl">
            <p className="text-sm text-[var(--player-dim)]">
              The full video couldn't be found on YouTube just now, so
              there's nothing to play yet.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onRetry}
                className="btn btn-accent btn-sm"
              >
                <IconPlay className="h-3.5 w-3.5" />
                Try again
              </button>
              {video.previewUrl && (
                <button
                  type="button"
                  onClick={onPreview}
                  aria-label={`Play the short preview of ${video.title} by ${video.artist} instead`}
                  className="btn btn-on-dark btn-sm"
                >
                  Play the short preview instead
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// The stage shown on the player while a tapped catalog song's full
// song is being found on YouTube, and when it can't be found. A song
// tap goes straight to the full song — the catalog's 30-second
// preview is never played as a step on the way; it remains only as
// an explicit fallback pick on the "failed" stage, the same pattern
// as the catalog-video stage above.
function SongLoadDock({
  track,
  status,
  onClose,
  onRetry,
  onPreview,
}: {
  track: PlayTrack;
  status: "loading" | "failed";
  onClose: () => void;
  onRetry: () => void;
  onPreview: () => void;
}) {
  usePauseMusicOnMount();
  return (
    <section
      aria-label={
        status === "loading"
          ? `Loading the full song: ${track.title} by ${track.artist}`
          : `The full song of ${track.title} by ${track.artist} couldn't be found`
      }
      className="player-console border-t border-[var(--player-border)]"
    >
      <div className="mx-auto max-w-5xl px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold text-[var(--player-text)]">
              {track.title}
            </p>
            <p className="truncate text-xs text-[var(--player-dim)]">
              {track.artist} · Full song
            </p>
          </div>
          <button
            type="button"
            aria-label="Close full song"
            onClick={onClose}
            className="icon-btn shrink-0"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>
        {status === "loading" ? (
          <p className="mt-2 text-sm text-[var(--player-dim)]">
            Finding the full song…
          </p>
        ) : (
          <div className="mt-2 sm:max-w-2xl">
            <p className="text-sm text-[var(--player-dim)]">
              The full song couldn't be found on YouTube just now, so
              there's nothing to play yet.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onRetry}
                className="btn btn-accent btn-sm"
              >
                <IconPlay className="h-3.5 w-3.5" />
                Try again
              </button>
              {track.previewUrl && (
                <button
                  type="button"
                  onClick={onPreview}
                  aria-label={`Play the 30-second preview of ${track.title} by ${track.artist} instead`}
                  className="btn btn-on-dark btn-sm"
                >
                  Play the 30-second preview instead
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

// The catalog's short music-video preview stage. Tapping a catalog
// video no longer lands here: the tap resolves the full-length video
// first and plays that directly, inside the app's music player (see
// the shell's playVideo). This stage is only the fallback the user
// can pick when the full video couldn't be found — the catalog's
// own file is ~30 seconds of the song and can never play all the
// way.
function VideoDock({
  video,
  onClose,
}: {
  video: CatalogVideo;
  onClose: () => void;
}) {
  usePauseMusicOnMount();
  // SLOWED on the app's own video element: the SAME standing switch as
  // the songs (the player state behind the full player's bottom-row
  // switch — no second switch here) drives this <video> element
  // directly. Just like the audio decks, the rate goes to the songs'
  // 0.72× AND preservesPitch is switched off, so the pitch drops
  // lower/deeper together with the tempo and the picture — a real DJ
  // slow-down, not a pitch-preserving speed change. (The full-video
  // stage above plays inside YouTube's own player, whose API exposes
  // only the rate; this element is the app's, so here the pitch lever
  // is real.) Applied on mount, on every SLOWED flip, and again when
  // a clip's metadata loads, so a fresh clip can't snap back to full
  // speed while the switch is on.
  const music = usePlayer();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const slowedRef = useRef(music.slowed);
  slowedRef.current = music.slowed;
  // Ducking: while Tiana speaks, drop this clip under her voice and
  // bring it back when she finishes — the clip never pauses.
  useEffect(() => {
    return registerDuckHandler((ducked) => {
      const el = videoRef.current;
      if (el) el.volume = ducked ? 0.12 : 1;
    });
  }, []);
  const applyVideoSlowed = useCallback(() => {
    const el = videoRef.current as
      | (HTMLVideoElement & {
          mozPreservesPitch?: boolean;
          webkitPreservesPitch?: boolean;
        })
      | null;
    if (!el) return;
    const slowed = slowedRef.current;
    const rate = slowed ? 0.72 : 1;
    el.playbackRate = rate;
    // defaultPlaybackRate is what a fresh load() starts at in some
    // browsers — setting it too keeps SLOWED from snapping back to
    // full speed when the next clip loads.
    el.defaultPlaybackRate = rate;
    // preservesPitch=false is what makes it a DJ slow-down: the pitch
    // drops with the speed instead of being corrected back up.
    el.preservesPitch = !slowed;
    el.mozPreservesPitch = !slowed;
    el.webkitPreservesPitch = !slowed;
  }, []);
  useEffect(() => {
    applyVideoSlowed();
  }, [music.slowed, applyVideoSlowed]);
  return (
    <section
      aria-label={`Music video preview playing on the player: ${video.title} by ${video.artist}`}
      className="player-console border-t border-[var(--player-border)]"
    >
      <div className="mx-auto max-w-5xl px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-display text-sm font-bold text-[var(--player-text)]">
              {video.title}
            </p>
            <p className="truncate text-xs text-[var(--player-dim)]">
              {video.artist} · Music video preview
              {video.releaseLabel ? ` · ${video.releaseLabel}` : ""}
              {music.slowed ? " · SLOWED (pitch & speed down)" : ""}
            </p>
          </div>
          {video.previewUrl && (
            <CastButton
              onDark
              dropUp
              media={{
                url: video.previewUrl,
                title: video.title,
                subtitle: video.artist,
                artworkUrl: video.artworkUrl,
                isVideo: true,
              }}
            />
          )}
          {/* No device download for videos: every video here is catalog
              content (Apple Music / YouTube), and catalog video never
              downloads to the device — it plays inside the app only.
              The user's own uploaded files are the only ones that can
              download to the device (track rows, "Device"). */}
          <button
            type="button"
            aria-label="Close music video"
            onClick={onClose}
            className="icon-btn shrink-0"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>
        {video.previewUrl ? (
          <video
            ref={videoRef}
            src={video.previewUrl}
            controls
            autoPlay
            playsInline
            onLoadedMetadata={applyVideoSlowed}
            className="mt-2 aspect-video w-full rounded-[var(--radius)] bg-black sm:max-w-2xl"
            aria-label={`Music video preview: ${video.title} by ${video.artist}`}
          />
        ) : (
          <p className="mt-2 text-sm text-[var(--player-dim)]">
            This video has no playable preview.
            {video.pageUrl && (
              <>
                {" "}
                <a
                  href={video.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-[var(--accent)] underline"
                >
                  Watch it on Apple Music
                </a>
              </>
            )}
          </p>
        )}
        <p className="mt-2 text-xs text-[var(--player-dim)] sm:max-w-2xl">
          This clip is the catalog's short preview — about 30 seconds.
          It only plays when the full video couldn't be found; whenever
          the full video is found, it plays directly instead — never
          this clip first.
        </p>
      </div>
    </section>
  );
}

// ---------- hum to search ----------

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Pitch detection for humming: autocorrelation with a clarity score
// (peak correlation relative to zero lag). A sung/hummed note correlates
// strongly with itself one period later; breath noise, room tone and
// chord bleed from speakers do not, so callers can reject unclear
// frames instead of recording garbage notes.
function autoCorrelate(
  buf: Float32Array,
  sampleRate: number,
): { freq: number; clarity: number } {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += (buf[i] ?? 0) * (buf[i] ?? 0);
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.015) return { freq: -1, clarity: 0 };
  let r1 = 0;
  let r2 = buf.length - 1;
  const thres = 0.2;
  for (let i = 0; i < buf.length / 2; i++) {
    if (Math.abs(buf[i] ?? 0) < thres) {
      r1 = i;
      break;
    }
  }
  for (let i = 1; i < buf.length / 2; i++) {
    if (Math.abs(buf[buf.length - i] ?? 0) < thres) {
      r2 = buf.length - i;
      break;
    }
  }
  const b = buf.slice(r1, r2);
  const c = new Array(b.length).fill(0) as number[];
  for (let i = 0; i < b.length; i++) {
    for (let j = 0; j < b.length - i; j++) {
      c[i] = (c[i] ?? 0) + (b[j] ?? 0) * (b[j + i] ?? 0);
    }
  }
  let d = 0;
  while (d < c.length - 1 && (c[d] ?? 0) > (c[d + 1] ?? 0)) d++;
  let maxVal = -1;
  let maxPos = 0;
  for (let i = d; i < c.length; i++) {
    if ((c[i] ?? 0) > maxVal) {
      maxVal = c[i] ?? 0;
      maxPos = i;
    }
  }
  if (maxPos === 0) return { freq: -1, clarity: 0 };
  const zeroLag = c[0] ?? 0;
  const clarity = zeroLag > 0 ? Math.min(1, maxVal / zeroLag) : 0;
  return { freq: sampleRate / maxPos, clarity };
}

function HumModal({ onClose }: { onClose: () => void }) {
  const [recording, setRecording] = useState(false);
  const [notes, setNotes] = useState<number[]>([]);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<number | null>(null);
  const lastNoteRef = useRef(-1);
  const candidateRef = useRef(-1);
  const candidateFramesRef = useRef(0);
  const player = usePlayer();

  const humMut = useMutation({
    mutationFn: () => api.humSearch({ notes, description }),
  });

  const stop = () => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
    setRecording(false);
  };

  useEffect(() => stop, []);

  const start = async () => {
    setError(null);
    setNotes([]);
    lastNoteRef.current = -1;
    candidateRef.current = -1;
    candidateFramesRef.current = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf);
        const { freq, clarity } = autoCorrelate(buf, ctx.sampleRate);
        // Unclear frame (silence, breath, room noise, a chord bleeding
        // through from speakers): reset the candidate instead of
        // recording whatever tone happened to dominate.
        if (freq <= 60 || freq >= 1200 || clarity < 0.55) {
          candidateRef.current = -1;
          candidateFramesRef.current = 0;
          return;
        }
        let midi = Math.round(69 + 12 * Math.log2(freq / 440));
        const last = lastNoteRef.current;
        // Octave slips: the detector sometimes locks onto the harmonic
        // an octave away for a few frames. A real hummed melody rarely
        // leaps exactly an octave mid-phrase, so fold that flicker back
        // onto the note we're already hearing.
        if (last > 0 && Math.abs(midi - last) === 12) midi = last;
        if (midi === candidateRef.current) {
          candidateFramesRef.current += 1;
        } else {
          candidateRef.current = midi;
          candidateFramesRef.current = 1;
        }
        // Commit only a note that held steady across two straight
        // reads. Pitch wobbles at every note change; committing each
        // wobble filled the melody with junk passing notes, and the
        // matcher then couldn't recognize the tune at all.
        if (candidateFramesRef.current >= 2 && midi !== last) {
          lastNoteRef.current = midi;
          setNotes((prev) => [...prev.slice(-47), midi]);
        }
      }, 130);
    } catch {
      setError(
        "The microphone isn't available here, so I can't hear the hum. You can still describe the song below and search that way.",
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[var(--bg)] p-4 pt-safe">
      <div className="mx-auto max-w-xl">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-2xl font-extrabold text-[var(--text)]">
            Hum a song
          </h2>
          <button
            type="button"
            aria-label="Close hum search"
            onClick={() => {
              stop();
              onClose();
            }}
            className="btn btn-secondary btn-sm"
          >
            <IconX className="h-4 w-4" />
            Close
          </button>
        </div>
        <p className="mt-2 text-sm text-[var(--dim)]">
          Hum the part you remember — the chorus works best — for about 5 to 10
          seconds. The app listens to the melody, searches the internet for
          the song, and it pops up right here ready to play.
        </p>
        <div className="mt-5 flex flex-col items-center rounded-[var(--radius)] bg-[var(--surface)] p-6">
          <button
            type="button"
            aria-label={recording ? "Stop humming" : "Start humming"}
            onClick={() => (recording ? stop() : void start())}
            className={`flex h-24 w-24 items-center justify-center rounded-full text-white ${
              recording ? "animate-pulse bg-[var(--amber)]" : "bg-[var(--accent)]"
            }`}
          >
            <IconMic className="h-10 w-10" />
          </button>
          <p className="mt-3 text-sm font-semibold text-[var(--text)]">
            {recording
              ? "Listening… hum now, tap again to stop"
              : notes.length > 0
                ? "Got it — tap Find my song below"
                : "Tap the mic and hum"}
          </p>
          {notes.length > 0 && (
            <p className="mt-2 text-center text-xs text-[var(--dim)]" aria-label="Notes heard">
              Heard:{" "}
              {notes
                .map((n) => `${NOTE_NAMES[n % 12] ?? "?"}${Math.floor(n / 12) - 1}`)
                .join(" · ")}
            </p>
          )}
          {error && <p className="mt-3 text-center text-sm text-[var(--accent)]">{error}</p>}
        </div>
        <label htmlFor="hum-desc" className="mt-5 block text-sm font-bold text-[var(--text)]">
          Anything else about it? (optional)
        </label>
        <input
          id="hum-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. female singer, 90s R&B, chorus goes 'yeah yeah'"
          className="mt-1.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)]"
        />
        <button
          type="button"
          disabled={humMut.isPending || (notes.length === 0 && !description.trim())}
          onClick={() => humMut.mutate()}
          className="btn btn-primary btn-block mt-4"
        >
          {humMut.isPending ? "Searching the internet…" : "Find my song"}
        </button>
        {humMut.data && (
          <div className="mt-5">
            <p className="text-sm text-[var(--dim)]">{humMut.data.note}</p>
            <div className="mt-2 divide-y divide-[var(--border)]">
              {humMut.data.matches.map((t) => {
                const pt = catalogToPlay(t);
                return (
                  <TrackRow
                    key={pt.key}
                    track={pt}
                    onPlay={() =>
                      player.playQueue(humMut.data.matches.map(catalogToPlay), humMut.data.matches.indexOf(t))
                    }
                  />
                );
              })}
            </div>
          </div>
        )}
        {humMut.error && (
          <p className="mt-3 text-sm text-[var(--accent)]">
            Search hit a snag. Try again in a moment.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------- player bar ----------

// The mini player: one slim bar at the bottom, Apple Music style —
// a grab handle with a chevron on top, then small artwork,
// title/artist, and prev / play-pause / next. Dragging the handle or
// the song UP — or tapping either —
// slides the full-screen player up; the seek bar, volume, and the
// SLOWED / Crossfade / Spatial / Cast controls live there. A playback error
// still surfaces here with its Retry button, since that's the one
// thing that can't wait for a tap.
function PlayerBar({ onExpand }: { onExpand: () => void }) {
  const player = usePlayer();
  const cur = player.current;
  // Slide-up gesture: dragging the handle strip (or the song itself)
  // up past a short threshold opens the full player, same as a tap.
  // A drag that already opened it must not also fire the tap on
  // release, so the click that follows a drag is swallowed once.
  const dragRef = useRef<{ y: number; opened: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  if (!cur) return null;
  // A catalog song (it carries a preview URL but plays its full song
  // on the YouTube stage) is labeled as the full song, never as a
  // preview. Uploaded files carry no preview URL and stay unlabeled,
  // as before.
  const isFullSong = Boolean(cur.fullSong && cur.previewUrl);
  const isPreviewOnly =
    !isFullSong &&
    !cur.savedTrackId &&
    !(cur.playlistItemId && !cur.previewUrl);
  const barDown = (e: ReactPointerEvent) => {
    dragRef.current = { y: e.clientY, opened: false };
    try {
      // Capture keeps move/up flowing to this element even when the
      // finger slides off the bar mid-drag.
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety — the threshold logic still works without it.
    }
  };
  const barMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (d && !d.opened && d.y - e.clientY > 44) {
      d.opened = true;
      suppressClickRef.current = true;
      onExpand();
    }
  };
  const barUp = () => {
    dragRef.current = null;
    if (suppressClickRef.current) {
      // If the release never produces a click on the bar (the full
      // player opened over it mid-drag), don't let the swallow flag
      // eat the NEXT genuine tap.
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 350);
    }
  };
  const barClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onExpand();
  };
  return (
    <div className="player-console border-t border-[var(--player-border)] px-3 py-2">
      <div
        role="button"
        aria-label="Open the full player"
        tabIndex={0}
        onClick={barClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onExpand();
          }
        }}
        onPointerDown={barDown}
        onPointerMove={barMove}
        onPointerUp={barUp}
        onPointerCancel={barUp}
        className="flex cursor-pointer touch-none flex-col items-center pb-1"
      >
        <span className="h-1 w-10 rounded-full bg-white/25" aria-hidden="true" />
        <IconChevronUp className="mt-0.5 h-3.5 w-3.5 text-[var(--player-dim)]" />
      </div>
      <div className="flex items-center gap-3">
        <div
          role="button"
          aria-label={`Open full player — ${cur.title} by ${cur.artist}`}
          tabIndex={0}
          onClick={barClick}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onExpand();
            }
          }}
          onPointerDown={barDown}
          onPointerMove={barMove}
          onPointerUp={barUp}
          onPointerCancel={barUp}
          className="flex min-w-0 flex-1 cursor-pointer touch-none items-center gap-3"
        >
          <Cover url={cur.artworkUrl} title={cur.title} size="h-10 w-10" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate font-display text-sm font-bold text-[var(--player-text)]">
              <span className="truncate">{cur.title}</span>
              <VersionBadge explicitness={cur.explicitness} onDark />
            </p>
            <p className="truncate text-xs text-[var(--player-dim)]">
              {cur.artist}
              {cur.explicitness === "explicit"
                ? " · Explicit"
                : cur.explicitness === "clean"
                  ? " · Clean"
                  : ""}
              {isFullSong
                ? " · Full song"
                : isPreviewOnly
                  ? " · official 30-sec preview"
                  : ""}
              {player.slowed ? " · SLOWED + REVERB style (pitch & speed down)" : ""}
              {player.spatial ? " · Spatial Audio on" : ""}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Previous track"
          onClick={player.prev}
          className="icon-btn"
        >
          <IconPrev className="h-6 w-6" />
        </button>
        <button
          type="button"
          aria-label={
            player.loading ? "Loading track" : player.playing ? "Pause" : "Play"
          }
          onClick={player.toggle}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-opacity hover:opacity-90"
        >
          {player.loading ? (
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          ) : player.playing ? (
            <IconPause className="h-5 w-5" />
          ) : (
            <IconPlay className="ml-0.5 h-5 w-5" />
          )}
        </button>
        <button
          type="button"
          aria-label="Next track"
          onClick={player.next}
          className="icon-btn"
        >
          <IconNext className="h-6 w-6" />
        </button>
      </div>
      {player.playbackError && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-[var(--player-surface2)] px-2.5 py-1.5">
          <p className="min-w-0 flex-1 text-xs font-semibold text-[var(--player-text)]">
            {player.playbackError}
          </p>
          <button
            type="button"
            aria-label="Retry playing this track"
            onClick={player.retry}
            className="btn btn-accent btn-xs shrink-0"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- lyrics ----------
// Real lyrics fetched per song by the getLyrics action (LRCLIB timed
// lyrics where the source has them, plain text otherwise, Lyrics.ovh
// fallback). Timed lines highlight and follow along when the FULL song
// is playing — an uploaded file, whose timeline is the song's own. A
// 30-second catalog preview can start mid-song, so for previews the
// timed lines are shown without the follow-along highlight and the
// panel says why; the highlight is never faked against a timeline it
// doesn't match. No source, no lyrics — nothing is made up.
function LyricsView({ track }: { track: PlayTrack }) {
  const player = usePlayer();
  const followsAlong = Boolean(track.savedTrackId || track.playlistItemId);
  const lyrics = useQuery({
    queryKey: ["lyrics", track.title, track.artist],
    queryFn: () =>
      api.getLyrics({
        title: track.title,
        artist: track.artist,
        albumTitle: track.albumTitle ?? null,
        durationMs: track.durationMs,
      }),
    staleTime: 1000 * 60 * 30,
  });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const d = lyrics.data;
  const synced = d?.status === "synced";
  const nowMs = player.currentTime * 1000;
  let activeIdx = -1;
  if (synced && d && followsAlong) {
    for (let i = 0; i < d.lines.length; i++) {
      const t = d.lines[i]?.timeMs;
      if (t === null || t === undefined) continue;
      if (t <= nowMs) activeIdx = i;
      else break;
    }
  }
  useEffect(() => {
    if (!followsAlong || activeIdx < 0) return;
    const box = scrollRef.current;
    const el = lineRefs.current[activeIdx];
    if (box && el) {
      box.scrollTo({
        top: Math.max(0, el.offsetTop - box.clientHeight / 2),
        behavior: "smooth",
      });
    }
  }, [activeIdx, followsAlong]);

  if (lyrics.isPending) {
    return (
      <p className="px-1 py-6 text-sm text-[var(--player-dim)]">
        Looking up the lyrics…
      </p>
    );
  }
  if (lyrics.error || !d) {
    return (
      <div className="px-1 py-6">
        <p className="text-sm text-[var(--player-dim)]">
          The lyrics didn't load just now.
        </p>
        <button
          type="button"
          onClick={() => void lyrics.refetch()}
          className="btn btn-on-dark btn-sm mt-3"
        >
          Try again
        </button>
      </div>
    );
  }
  if (d.status === "none") {
    return (
      <p className="px-1 py-6 text-sm text-[var(--player-dim)]">
        {d.instrumental
          ? "This track is instrumental — there are no lyrics to show."
          : "No lyrics found for this song. The lyrics sources (LRCLIB and Lyrics.ovh) don't have it — and lyrics are never made up here."}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-1 pb-2 text-[11px] font-semibold text-[var(--player-dim)]">
        {synced
          ? followsAlong
            ? `Synced lyrics · ${d.source ?? ""} — following along with the song`
            : `Timed lyrics · ${d.source ?? ""} — this is a 30-second preview that can start mid-song, so the lines can't follow it exactly`
          : `Lyrics · ${d.source ?? ""} — this song's lyrics aren't timed, so they don't highlight as it plays`}
      </p>
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto pb-8 pr-1"
        aria-label={`Lyrics for ${track.title} by ${track.artist}`}
      >
        {d.lines.map((line, i) => {
          const active = synced && followsAlong && i === activeIdx;
          if (!line.text.trim()) {
            return <div key={i} className="h-4" aria-hidden="true" />;
          }
          return (
            <p
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              className={`py-1 text-[15px] leading-snug transition-colors ${
                active
                  ? "font-bold text-[var(--accent)]"
                  : synced && followsAlong && i < activeIdx
                    ? "text-[var(--player-dim)]"
                    : "text-[var(--player-text)]"
              }`}
            >
              {line.text}
            </p>
          );
        })}
      </div>
    </div>
  );
}

// ---------- full player (slide-up) ----------
// The expanded player: a sheet that SLIDES UP from the bottom over
// the app whenever a song is deliberately started (the shell pops it
// open on startCount), and when the mini bar is tapped or dragged up
// — big artwork front and center like Apple Music's Now Playing,
// transport, seek, volume, the Spatial / Cast controls, and the
// song's lyrics following along. The SLOWED and Crossfade switches
// sit together in a row pinned to the BOTTOM of the sheet, always on
// screen and in thumb reach. Drag the top handle down (the sheet
// follows the drag) or tap the handle to slide it back down to the
// mini bar. Playback is never touched by opening or closing it.
function FullPlayer({
  onClose,
  showAds,
  onUpgrade,
  onShowVideo,
}: {
  onClose: () => void;
  showAds: boolean;
  onUpgrade: () => void;
  // Video pick on the Video / Song toggle: the shell finds the
  // song's full music video and opens it in this same player,
  // picking up at the song's current second.
  onShowVideo: (track: PlayTrack, positionSeconds: number) => void;
}) {
  const player = usePlayer();
  const cur = player.current;
  // Sheet motion: the entrance slide-up runs once on mount; once it
  // has landed, dragging the handle moves the sheet with the finger,
  // and closing plays the slide-down before the sheet unmounts.
  const [entered, setEntered] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, 270);
  }, [onClose]);
  // Insurance for the entrance landing: if the slide-up's
  // animationend never arrives (reduced motion turns the animation
  // off), the sheet still counts as landed so handle drags can move it.
  useEffect(() => {
    const t = window.setTimeout(() => setEntered(true), 450);
    return () => window.clearTimeout(t);
  }, []);
  // A fresh deliberate start while the sheet is up (or mid-close)
  // cancels any close in flight and replays the slide-up.
  const startCountRef = useRef(player.startCount);
  useEffect(() => {
    if (player.startCount !== startCountRef.current) {
      startCountRef.current = player.startCount;
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      closingRef.current = false;
      setClosing(false);
      setEntered(false);
      setDragOffset(0);
    }
  }, [player.startCount]);
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    [],
  );
  if (!cur) return null;
  const handleDown = (e: ReactPointerEvent) => {
    dragStartRef.current = e.clientY;
    setDragging(true);
    setDragOffset(0);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety — the threshold logic still works without it.
    }
  };
  const handleMove = (e: ReactPointerEvent) => {
    if (dragStartRef.current !== null) {
      setDragOffset(Math.max(0, e.clientY - dragStartRef.current));
    }
  };
  const handleUp = () => {
    if (dragStartRef.current === null) return;
    dragStartRef.current = null;
    setDragging(false);
    // A real drag down past the threshold — or a plain tap on the
    // handle — slides the sheet back down to the mini bar. A short
    // drag snaps back up.
    if (dragOffset > 90 || dragOffset <= 6) {
      requestClose();
    } else {
      setDragOffset(0);
    }
  };
  const handleCancel = () => {
    dragStartRef.current = null;
    setDragging(false);
    setDragOffset(0);
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Full player: ${cur.title} by ${cur.artist}`}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && !closing) setEntered(true);
      }}
      style={
        entered && !closing
          ? {
              transform: `translateY(${dragOffset}px)`,
              transition: dragging ? undefined : "transform 0.22s ease",
            }
          : undefined
      }
      className={`player-console fixed inset-0 z-50 flex flex-col px-4 pb-3 pt-safe ${
        closing ? "player-sheet-closing" : entered ? "" : "player-sheet-anim"
      }`}
    >
      <div
        role="button"
        aria-label="Minimize player"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            requestClose();
          }
        }}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerCancel={handleCancel}
        className="flex cursor-pointer touch-none flex-col items-center pb-1 pt-1"
      >
        <span className="h-1 w-10 rounded-full bg-white/25" aria-hidden="true" />
        <span className="mt-1 flex items-center gap-1 text-[11px] font-bold uppercase tracking-widest text-[var(--player-dim)]">
          <IconChevronDown className="h-4 w-4" />
          Now playing
        </span>
      </div>
      <div className="mx-auto flex w-full max-w-xl flex-1 min-h-0 flex-col">
        <Cover
          url={cur.artworkUrl}
          title={cur.title}
          size="mx-auto mt-2 aspect-square w-full max-w-[min(430px,40vh)]"
        />
        <div className="mt-4 text-center">
          <p className="flex items-center justify-center gap-1.5 font-display text-2xl font-extrabold text-[var(--player-text)]">
            <span className="min-w-0 truncate">{cur.title}</span>
            <VersionBadge explicitness={cur.explicitness} onDark />
          </p>
          <p className="mt-0.5 truncate text-base text-[var(--player-dim)]">
            {cur.artist}
            {cur.albumTitle ? ` · ${cur.albumTitle}` : ""}
          </p>
          <p className="mt-1 text-xs text-[var(--player-dim)]">
            {player.loading
              ? "Loading…"
              : player.playing
                ? "Playing"
                : "Paused"}
            {" · "}
            {player.index + 1} / {player.queue.length} in queue
          </p>
        </div>
        {!cur.key.startsWith("podcast-") &&
          !cur.key.startsWith("audiobook-") && (
            <div className="mt-4">
              <VideoSongToggle
                mode="song"
                onPick={(m) => {
                  if (m === "video") onShowVideo(cur, player.currentTime);
                }}
              />
              <p className="mt-1.5 text-center text-xs text-[var(--player-dim)]">
                Song version — tap Video to watch the full music video
                right here, picking up where the song is.
              </p>
            </div>
          )}
        <div className="mt-3 flex items-center gap-2">
          <span className="w-9 text-right text-[11px] text-[var(--player-dim)]">
            {fmtDur(player.currentTime * 1000)}
          </span>
          <input
            type="range"
            aria-label="Seek through the track"
            min={0}
            max={Math.max(1, Math.floor(player.duration))}
            value={Math.floor(player.currentTime)}
            onChange={(e) => player.seek(Number(e.target.value))}
            className="min-w-0 flex-1"
          />
          <span className="w-9 text-[11px] text-[var(--player-dim)]">
            {fmtDur(player.duration * 1000)}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-center gap-5">
          <button
            type="button"
            aria-label="Previous track"
            onClick={player.prev}
            className="icon-btn"
          >
            <IconPrev className="h-7 w-7" />
          </button>
          <button
            type="button"
            aria-label={
              player.loading
                ? "Loading track"
                : player.playing
                  ? "Pause"
                  : "Play"
            }
            onClick={player.toggle}
            className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-opacity hover:opacity-90"
          >
            {player.loading ? (
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            ) : player.playing ? (
              <IconPause className="h-6 w-6" />
            ) : (
              <IconPlay className="ml-0.5 h-6 w-6" />
            )}
          </button>
          <button
            type="button"
            aria-label="Next track"
            onClick={player.next}
            className="icon-btn"
          >
            <IconNext className="h-7 w-7" />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-widest text-[var(--player-dim)]">
            Volume
          </span>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={100}
            value={Math.round(player.volume * 100)}
            onChange={(e) => player.setVolume(Number(e.target.value) / 100)}
            className="min-w-0 flex-1"
          />
          <span className="w-9 text-[11px] text-[var(--player-dim)]">
            {Math.round(player.volume * 100)}%
          </span>
        </div>
        {player.playbackError && (
          <div className="mt-2 flex items-center gap-2 rounded-md bg-[var(--player-surface2)] px-2.5 py-1.5">
            <p className="min-w-0 flex-1 text-xs font-semibold text-[var(--player-text)]">
              {player.playbackError}
            </p>
            <button
              type="button"
              aria-label="Retry playing this track"
              onClick={player.retry}
              className="btn btn-accent btn-xs shrink-0"
            >
              Retry
            </button>
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label="Toggle Spatial Audio"
            aria-pressed={player.spatial}
            onClick={() => player.setSpatial(!player.spatial)}
            className="btn-toggle"
          >
            <IconSpatial className="h-3.5 w-3.5" />
            Spatial Audio
            <span className="switch" aria-hidden="true" />
          </button>
          <CastButton
            onDark
            media={
              player.getCurrentSrc()
                ? {
                    url: player.getCurrentSrc() as string,
                    title: cur.title,
                    subtitle: cur.artist,
                    artworkUrl: cur.artworkUrl,
                  }
                : null
            }
          />
        </div>
        {(cur.key.startsWith("podcast-") || cur.key.startsWith("audiobook-")) && (
          <div className="mt-3 rounded-md bg-[var(--player-surface2)] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-label="Back 15 seconds"
                onClick={() => player.seek(Math.max(0, player.currentTime - 15))}
                className="btn btn-on-dark btn-sm"
              >
                −15s
              </button>
              <button
                type="button"
                aria-label="Forward 15 seconds"
                onClick={() =>
                  player.seek(Math.min(player.duration || 0, player.currentTime + 15))
                }
                className="btn btn-on-dark btn-sm"
              >
                +15s
              </button>
              <span className="ml-1 text-[11px] font-bold uppercase tracking-widest text-[var(--player-dim)]">
                Speed
              </span>
              {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                <button
                  key={r}
                  type="button"
                  aria-label={`Play at ${r} times speed`}
                  aria-pressed={player.speechRate === r}
                  onClick={() => player.setSpeechRate(r)}
                  className={`btn btn-sm ${player.speechRate === r ? "btn-accent" : "btn-on-dark"}`}
                >
                  {r}×
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--player-dim)]">
              Podcasts and audiobooks pick up right where you left off.
            </p>
          </div>
        )}
        {showAds && (
          <div className="mt-3 [&>aside]:mt-0">
            <HouseAdCard variant="premium" onUpgrade={onUpgrade} />
          </div>
        )}
        <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-[var(--player-border)] pt-3">
          <h3 className="flex items-center gap-2 font-display text-base font-bold text-[var(--player-text)]">
            <IconLyrics className="h-5 w-5" />
            Lyrics
          </h3>
          <LyricsView key={cur.key} track={cur} />
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-xl flex-wrap items-center justify-center gap-x-6 gap-y-1 border-t border-[var(--player-border)] pt-2.5">
        <button
          type="button"
          aria-label="Toggle slow down pitch and speed"
          aria-pressed={player.slowed}
          onClick={() => player.setSlowed(!player.slowed)}
          className="btn-toggle btn-toggle-amber text-base"
        >
          <IconGauge className="h-4 w-4" />
          SLOWED
          <span className="switch" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Toggle DJ crossfade"
          aria-pressed={player.crossfadeOn}
          onClick={() => player.setCrossfadeOn(!player.crossfadeOn)}
          className="btn-toggle text-base"
        >
          <IconShuffle className="h-4 w-4" />
          Crossfade
          <span className="switch" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

// ---------- pages ----------

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="mt-7 font-display text-xl font-extrabold text-[var(--text)]">
      {children}
    </h2>
  );
}

// Multi-disc albums: group the tracklist by disc so Disc 1 sits at the
// top and Disc 2 lands right under it once Disc 1's list finishes —
// each disc's track numbers restart at 1, like the real album. A
// single-disc album returns one group and renders exactly as before,
// with no heading. Entries keep their index in the full list so play
// queues and row keys stay in album order.
function groupByDisc<T extends { discNumber: number }>(
  items: readonly T[],
): { disc: number; entries: { item: T; index: number }[] }[] {
  const groups = new Map<number, { item: T; index: number }[]>();
  items.forEach((item, index) => {
    const disc = item.discNumber > 0 ? item.discNumber : 1;
    const bucket = groups.get(disc);
    if (bucket) bucket.push({ item, index });
    else groups.set(disc, [{ item, index }]);
  });
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([disc, entries]) => ({ disc, entries }));
}

function DiscHeading({ disc, count }: { disc: number; count: number }) {
  return (
    <h3 className="mt-5 flex items-baseline gap-2 font-display text-base font-extrabold text-[var(--text)]">
      Disc {disc}
      <span className="text-xs font-semibold text-[var(--dim)]">
        {count} {count === 1 ? "song" : "songs"}
      </span>
    </h3>
  );
}

// ---------- ask Muse (connected playback) ----------
// The app is connected to Muse: ask here in plain words — or ask Muse
// in chat or on a call with the same words — and the app pulls the song
// right up and plays it in its own player. Both go through the same
// requestPlayback action; the AssistantPlaybackBridge starts it here.
function AskMusePanel() {
  const [ask, setAsk] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const askMut = useMutation({
    mutationFn: (q: string) => api.requestPlayback({ query: q }),
    onSuccess: (r) => {
      setMsg(
        r.found
          ? `Muse is pulling up “${r.title}” by ${r.artist} — it starts in the player below in a few seconds.`
          : r.note,
      );
      if (r.found) setAsk("");
    },
    onError: () => setMsg("That ask didn't reach Muse — try again in a moment."),
  });
  const examples = [
    "Play a song by DMX",
    "Play Party Up by DMX — explicit",
    "Play Ruff Ryders' Anthem by DMX",
  ];
  return (
    <section
      aria-label="Ask Muse to play a song"
      className="mt-4 rounded-[var(--radius)] bg-[var(--surface)] p-4"
    >
      <h2 className="flex items-center gap-2 font-display text-base font-bold text-[var(--text)]">
        <IconSparkles className="h-5 w-5 text-[var(--accent)]" />
        Ask Muse to play something
      </h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        This app is connected to Muse. Say it the way you'd say it out
        loud — “play a song by DMX” — here, or ask Muse in chat or on a
        call, and the song pulls right up and plays in the player. Add
        “explicit” or “clean” to pick the version.
      </p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (ask.trim()) askMut.mutate(ask.trim());
        }}
      >
        <input
          aria-label="Ask Muse to play a song, for example play a song by DMX"
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder="Play a song by DMX…"
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
        />
        <button
          type="submit"
          disabled={!ask.trim() || askMut.isPending}
          className="btn btn-primary shrink-0"
        >
          {askMut.isPending ? "Asking…" : "Ask Muse"}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {examples.map((ex) => (
          <button
            key={ex}
            type="button"
            aria-label={`Ask Muse: ${ex}`}
            onClick={() => askMut.mutate(ex)}
            disabled={askMut.isPending}
            className="btn btn-secondary btn-xs"
          >
            {ex}
          </button>
        ))}
      </div>
      {msg && <p className="mt-3 text-sm font-semibold text-[var(--text)]">{msg}</p>}
    </section>
  );
}

// The app's cover artwork: the user's gold SM wave logo (the S drawn as
// a flowing sound wave, "Life Streaming" underneath, black and gold).
// Shown at the very top of the home page so it's the first thing seen
// when the app opens — it renders even while the charts load or if the
// catalog is unreachable, because it is bundled with the app itself.
function AppCoverArtwork() {
  return (
    <figure className="mt-4 overflow-hidden rounded-[var(--radius)] bg-black">
      <img
        src={smLifeCover}
        alt="SM Life Streaming cover artwork — gold SM logo with the S drawn as a flowing sound wave, Life Streaming underneath, on black"
        className="aspect-[2/1] w-full object-cover"
      />
    </figure>
  );
}

// ---------- plan & ads ----------
// Three tiers, set in Library → Settings → Your plan and stored by
// the getPlan/setPlan actions:
//  - Developer: the owner's own account (this install starts here).
//    The whole app, no ads — the developer never plays with ads.
//  - Free: the free App Store download. The whole app, with ads.
//  - Premium: the paid plan. The whole app, no ads.
// Ads render ONLY on the free tier. They are house ads for the
// owner's own brands (Big Dogg Records, Big Dog Boulevard) plus the
// Premium upgrade — every one is labeled "Ad", and the Premium card's
// button is what a free user taps to pay and turn the ads off.

function AdShell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <aside
      aria-label={`Advertisement: ${label}`}
      className="relative mt-4 overflow-hidden rounded-[var(--radius)] bg-black p-4 text-white"
    >
      <span className="absolute right-3 top-3 rounded border border-white/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white/80">
        Ad
      </span>
      {children}
    </aside>
  );
}

function HouseAdCard({
  variant,
  onUpgrade,
}: {
  variant: "premium" | "records" | "boulevard";
  onUpgrade: () => void;
}) {
  if (variant === "premium") {
    return (
      <AdShell label="SM Life Premium — remove ads">
        <p className="text-[11px] font-bold uppercase tracking-widest text-[#ffb340]">
          SM Life Premium
        </p>
        <p className="mt-1 font-display text-lg font-extrabold leading-snug">
          Get the whole app with no ads
        </p>
        <p className="mt-1 max-w-md text-sm text-white/75">
          You're on the free plan, so ads play along with your music.
          Pay for Premium once and every ad is gone — the full app,
          nothing held back.
        </p>
        <button
          type="button"
          onClick={onUpgrade}
          aria-label="Go Premium — pay to remove all ads"
          className="btn mt-3 bg-[#ffb340] font-bold text-black hover:opacity-90"
        >
          Go Premium — remove ads
        </button>
      </AdShell>
    );
  }
  if (variant === "records") {
    return (
      <AdShell label="Big Dogg Records">
        <p className="text-[11px] font-bold uppercase tracking-widest text-[#ffb340]">
          Big Dogg Records
        </p>
        <p className="mt-1 font-display text-lg font-extrabold leading-snug">
          New beats. New releases. Straight from the label.
        </p>
        <p className="mt-1 max-w-md text-sm text-white/75">
          The home of Big Dogg Records — hear what's cooking in the
          studio, right here in SM Life.
        </p>
      </AdShell>
    );
  }
  return (
    <AdShell label="Big Dog Boulevard clothing">
      <p className="text-[11px] font-bold uppercase tracking-widest text-[#ffb340]">
        Big Dog Boulevard
      </p>
      <p className="mt-1 font-display text-lg font-extrabold leading-snug">
        The clothing line — wear the Boulevard
      </p>
      <p className="mt-1 max-w-md text-sm text-white/75">
        Hoodies, tees and more from Big Dog Boulevard, the developer's
        own clothing line.
      </p>
    </AdShell>
  );
}

// Slim ad strip that sits directly above the player on the free
// tier — the player-dock ad slot. Premium and Developer never see it.
function PlayerAdStrip({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div
      aria-label="Advertisement: SM Life Premium — remove ads"
      className="player-console flex items-center gap-2 border-t border-[var(--player-border)] px-3 py-2"
    >
      <span className="shrink-0 rounded border border-white/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white/80">
        Ad
      </span>
      <p className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--player-text)]">
        Free plan plays with ads — Premium takes them all off.
      </p>
      <button
        type="button"
        onClick={onUpgrade}
        aria-label="Go Premium from the player ad — pay to remove all ads"
        className="btn btn-xs shrink-0 bg-[#ffb340] font-bold text-black hover:opacity-90"
      >
        Go Premium
      </button>
    </div>
  );
}

function HomePage({
  openAlbum,
  openArtist,
  openVideo,
  showAds,
  onUpgrade,
}: {
  openAlbum: (id: string) => void;
  openArtist: (name: string, id: string | null) => void;
  openVideo: (v: CatalogVideo) => void;
  showAds: boolean;
  onUpgrade: () => void;
}) {
  const feed = useQuery({ queryKey: ["home"], queryFn: () => api.homeFeed({}) });
  const player = usePlayer();
  if (feed.isPending) {
    return (
      <div>
        <AppCoverArtwork />
        <p className="py-16 text-center text-sm text-[var(--dim)]">Loading the charts…</p>
      </div>
    );
  }
  if (feed.error || !feed.data) {
    return (
      <div>
        <AppCoverArtwork />
        <div className="py-16 text-center">
          <p className="text-sm text-[var(--dim)]">
            The catalog didn't answer just now.
          </p>
          <button
            type="button"
            onClick={() => void feed.refetch()}
            className="btn btn-primary mt-3"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
  const { albums, tracks, videos, artists } = feed.data;
  const hero = tracks[0];
  return (
    <div>
      <AppCoverArtwork />
      <AskMusePanel />
      {showAds && <HouseAdCard variant="premium" onUpgrade={onUpgrade} />}
      {hero && (
        <button
          type="button"
          aria-label={`Play top songs starting with ${hero.title}`}
          onClick={() => player.playQueue(tracks.map(catalogToPlay), 0)}
          className="relative mt-4 block w-full overflow-hidden rounded-[var(--radius)] text-left"
        >
          {hero.artworkUrl && (
            <img
              src={hero.artworkUrl}
              alt={`Cover art for ${hero.albumTitle}`}
              className="aspect-[16/8] w-full object-cover"
            />
          )}
          <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />
          <span className="absolute bottom-0 left-0 right-0 p-4">
            <span className="text-xs font-bold uppercase tracking-widest text-white/70">
              #1 right now
            </span>
            <span className="mt-1 block font-display text-2xl font-extrabold text-white sm:text-4xl">
              {hero.title}
            </span>
            <span className="block text-sm text-white/80">
              {hero.artist} — tap to play the top songs
            </span>
          </span>
        </button>
      )}

      <SectionTitle>Trending albums</SectionTitle>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {albums.map((a) => (
          <AlbumCard key={a.catalogId} album={a} onOpen={() => openAlbum(a.catalogId)} />
        ))}
      </div>

      {showAds && <HouseAdCard variant="records" onUpgrade={onUpgrade} />}

      <SectionTitle>Top songs</SectionTitle>
      <div className="mt-1 divide-y divide-[var(--border)]">
        {tracks.map((t, i) => {
          const pt = catalogToPlay(t);
          return (
            <TrackRow
              key={pt.key + i}
              track={pt}
              onPlay={() => player.playQueue(tracks.map(catalogToPlay), i)}
            />
          );
        })}
      </div>
      {showAds && <HouseAdCard variant="boulevard" onUpgrade={onUpgrade} />}

      <SectionTitle>Music videos</SectionTitle>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {videos.map((v, i) => (
          <VideoCard key={`${v.title}-${i}`} video={v} onOpen={() => openVideo(v)} />
        ))}
      </div>

      <SectionTitle>Top artists</SectionTitle>
      <div className="mt-3 flex flex-wrap gap-2 pb-2">
        {artists.map((a) => (
          <button
            key={a.name}
            type="button"
            onClick={() => openArtist(a.name, null)}
            aria-label={`Open artist profile for ${a.name}`}
            className="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] py-1.5 pl-1.5 pr-4"
          >
            {a.artworkUrl ? (
              <img
                src={a.artworkUrl}
                alt={`Photo of ${a.name}`}
                className="h-8 w-8 rounded-full object-cover"
                loading="lazy"
              />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface2)] text-[var(--dim)]">
                <IconMusicNote className="h-4 w-4" />
              </span>
            )}
            <span className="text-sm font-semibold text-[var(--text)]">{a.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchPage({
  query,
  openAlbum,
  openArtist,
  openVideo,
  openYouTube,
  openHum,
  onVoiceSearch,
  openSaved,
  showAds,
  onUpgrade,
}: {
  query: string;
  openAlbum: (id: string) => void;
  openArtist: (name: string, id: string | null) => void;
  openVideo: (v: CatalogVideo) => void;
  openYouTube: (v: YouTubeVideo) => void;
  openHum: () => void;
  onVoiceSearch: (text: string) => void;
  openSaved: (albumId: number) => void;
  showAds: boolean;
  onUpgrade: () => void;
}) {
  const [tab, setTab] = useState<"all" | "songs" | "albums" | "artists" | "videos" | "youtube">("all");
  const player = usePlayer();
  const results = useQuery({
    queryKey: ["search", query],
    queryFn: () => api.searchMusic({ query }),
    enabled: query.trim().length > 0,
  });
  const yt = useQuery({
    queryKey: ["youtube-search", query],
    queryFn: () => api.searchYouTube({ query }),
    enabled: query.trim().length > 0,
  });
  if (!query.trim()) {
    return (
      <div className="py-14 text-center">
        <p className="font-display text-xl font-bold text-[var(--text)]">
          Search by artist, song, or album
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">
          Type an artist's name, a song title, or an album title in the
          search bar up top — one search covers all three, in the music
          catalog, on YouTube, and in your own library. Or tap Voice,
          say it out loud, and the search runs on its own — or hum the
          tune and let the app find it.
        </p>
        <div className="mt-5 flex flex-wrap items-start justify-center gap-2">
          <VoiceSearchButton onResult={onVoiceSearch} />
          <button
            type="button"
            onClick={openHum}
            className="btn btn-primary"
          >
            <IconMic className="h-4 w-4" />
            Hum a song instead
          </button>
        </div>
      </div>
    );
  }
  if (results.isPending) {
    return <p className="py-16 text-center text-sm text-[var(--dim)]">Searching “{query}”…</p>;
  }
  if (results.error || !results.data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-[var(--dim)]">That search didn't go through.</p>
        <button
          type="button"
          onClick={() => void results.refetch()}
          className="btn btn-primary mt-3"
        >
          Try again
        </button>
      </div>
    );
  }
  const d = results.data;
  const tabs = [
    ["all", "All"],
    ["songs", "Songs"],
    ["albums", "Albums"],
    ["artists", "Artists"],
    ["videos", "Videos"],
    ["youtube", "YouTube"],
  ] as const;
  const showSongs = tab === "all" || tab === "songs";
  const showAlbums = tab === "all" || tab === "albums";
  const showArtists = tab === "all" || tab === "artists";
  const showVideos = tab === "all" || tab === "videos";
  const showYouTube = tab === "all" || tab === "youtube";
  const ytVideos = yt.data?.videos ?? [];
  const ytList = tab === "youtube" ? ytVideos : ytVideos.slice(0, 6);
  const lib = d.libraryMatches;
  const hasLibrary =
    lib.albums.length > 0 || lib.tracks.length > 0 || lib.artists.length > 0;
  const empty =
    d.songs.length === 0 &&
    d.albums.length === 0 &&
    d.artists.length === 0 &&
    d.videos.length === 0 &&
    !hasLibrary &&
    !yt.isPending &&
    ytVideos.length === 0;
  return (
    <div>
      {showAds && <HouseAdCard variant="records" onUpgrade={onUpgrade} />}
      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Search result types">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`btn-tab ${tab === key ? "btn-tab-active" : ""}`}
          >
            {label}
          </button>
        ))}
      </div>
      {empty && (
        <p className="py-14 text-center text-sm text-[var(--dim)]">
          Nothing matches “{query}” yet — not by artist name, song title, or
          album title, in the catalog, on YouTube, or in your library. Check
          the spelling and try another of the three.
        </p>
      )}
      {tab === "all" &&
        (() => {
          // Top result: when the query IS an artist's name, that
          // artist's profile leads the results; when it IS an album's
          // name, that album leads. Library matches count too — a
          // typed name surfaces the user's own copy first.
          const normQ = query
            .toLowerCase()
            .replace(/[‘’]/g, "'")
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
          const keyOf = (s: string) =>
            s
              .toLowerCase()
              .replace(/[‘’]/g, "'")
              .replace(/\b(feat|ft)\.? .*/g, "")
              .replace(/[^a-z0-9]+/g, " ")
              .trim();
          const topArtist =
            d.artists.find((a) => keyOf(a.name) === keyOf(query)) ?? null;
          const libTopArtist = !topArtist
            ? (lib.artists.find((n) => keyOf(n) === keyOf(query)) ?? null)
            : null;
          const topAlbum =
            d.albums.find((a) => normQ !== "" && keyOf(a.title) === normQ) ??
            null;
          const libTopAlbum =
            !topAlbum
              ? (lib.albums.find((a) => normQ !== "" && keyOf(a.title) === normQ) ??
                null)
              : null;
          if (!topArtist && !libTopArtist && !topAlbum && !libTopAlbum) {
            return null;
          }
          return (
            <>
              <SectionTitle>Top result</SectionTitle>
              <div className="mt-3 space-y-2">
                {topArtist && (
                  <button
                    type="button"
                    onClick={() => openArtist(topArtist.name, topArtist.artistId)}
                    aria-label={`Open artist profile for ${topArtist.name}`}
                    className="flex w-full items-center gap-3 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-3 text-left ring-1 ring-[var(--border)]"
                  >
                    {topArtist.artworkUrl ? (
                      <img
                        src={topArtist.artworkUrl}
                        alt={`Photo of ${topArtist.name}`}
                        className="h-14 w-14 shrink-0 rounded-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] font-display text-xl font-bold text-[var(--dim)]">
                        {topArtist.name.slice(0, 1)}
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate font-display text-base font-bold text-[var(--text)]">
                        {topArtist.name}
                      </span>
                      <span className="block text-xs text-[var(--dim)]">
                        Artist profile{topArtist.genre ? ` · ${topArtist.genre}` : ""}
                      </span>
                    </span>
                  </button>
                )}
                {libTopArtist && (
                  <button
                    type="button"
                    onClick={() => openArtist(libTopArtist, null)}
                    aria-label={`Open artist profile for ${libTopArtist}`}
                    className="flex w-full items-center gap-3 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-3 text-left ring-1 ring-[var(--border)]"
                  >
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] font-display text-xl font-bold text-[var(--dim)]">
                      {libTopArtist.slice(0, 1)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate font-display text-base font-bold text-[var(--text)]">
                        {libTopArtist}
                      </span>
                      <span className="block text-xs text-[var(--dim)]">
                        Artist profile · in your library
                      </span>
                    </span>
                  </button>
                )}
                {topAlbum && (
                  <button
                    type="button"
                    onClick={() => openAlbum(topAlbum.catalogId)}
                    aria-label={`Open album ${topAlbum.title} by ${topAlbum.artist}`}
                    className="flex w-full items-center gap-3 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-3 text-left ring-1 ring-[var(--border)]"
                  >
                    <Cover
                      url={topAlbum.artworkUrl}
                      title={topAlbum.title}
                      size="h-14 w-14 shrink-0 rounded-[var(--radius)]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-display text-base font-bold text-[var(--text)]">
                        {topAlbum.title}
                      </span>
                      <span className="block truncate text-xs text-[var(--dim)]">
                        Album · {topAlbum.artist}
                        {topAlbum.releaseLabel ? ` · ${topAlbum.releaseLabel}` : ""}
                      </span>
                    </span>
                  </button>
                )}
                {libTopAlbum && (
                  <button
                    type="button"
                    onClick={() => openSaved(libTopAlbum.id)}
                    aria-label={`Open album ${libTopAlbum.title} by ${libTopAlbum.artist} from your library`}
                    className="flex w-full items-center gap-3 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-3 text-left ring-1 ring-[var(--border)]"
                  >
                    <Cover
                      url={libTopAlbum.artworkUrl}
                      title={libTopAlbum.title}
                      size="h-14 w-14 shrink-0 rounded-[var(--radius)]"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-display text-base font-bold text-[var(--text)]">
                        {libTopAlbum.title}
                      </span>
                      <span className="block truncate text-xs text-[var(--dim)]">
                        Album · {libTopAlbum.artist} · in your library
                      </span>
                    </span>
                  </button>
                )}
              </div>
            </>
          );
        })()}
      {tab === "all" && hasLibrary && (
        <>
          <SectionTitle>In your library</SectionTitle>
          {lib.artists.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {lib.artists.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => openArtist(name, null)}
                  aria-label={`Open your library artist profile for ${name}`}
                  className="btn btn-secondary btn-sm"
                >
                  {name} — artist profile
                </button>
              ))}
            </div>
          )}
          {lib.albums.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {lib.albums.map((a) => (
                <AlbumCard
                  key={`lib-${a.id}`}
                  album={{
                    catalogId: `lib-${a.id}`,
                    title: a.title,
                    artist: a.artist,
                    artistId: null,
                    artworkUrl: a.artworkUrl,
                    genre: null,
                    releaseLabel: null,
                    releaseDateIso: null,
                    trackCount: a.trackCount,
                    explicitness: "none",
                  }}
                  onOpen={() => openSaved(a.id)}
                />
              ))}
            </div>
          )}
          {lib.tracks.length > 0 && (
            <div className="mt-1 divide-y divide-[var(--border)]">
              {lib.tracks.map((t) => {
                const pt: PlayTrack = {
                  key: `saved-${t.id}`,
                  title: t.title,
                  artist: t.artist,
                  artworkUrl: t.artworkUrl,
                  previewUrl: t.previewUrl,
                  durationMs: t.durationMs,
                  savedTrackId: t.hasFullFile ? t.id : null,
                };
                return (
                  <TrackRow
                    key={pt.key}
                    track={pt}
                    onPlay={() => player.playQueue([pt], 0)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
      {showArtists && d.artists.length > 0 && (
        <>
          <SectionTitle>Artists</SectionTitle>
          <div className="mt-3 space-y-2">
            {d.artists.map((a) => (
              <button
                key={a.name}
                type="button"
                onClick={() => openArtist(a.name, a.artistId)}
                aria-label={`Open artist profile for ${a.name}`}
                className="flex w-full items-center gap-3 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-2.5 text-left"
              >
                {a.artworkUrl ? (
                  <img
                    src={a.artworkUrl}
                    alt={`Photo of ${a.name}`}
                    className="h-10 w-10 shrink-0 rounded-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] font-display font-bold text-[var(--dim)]">
                    {a.name.slice(0, 1)}
                  </span>
                )}
                <span>
                  <span className="block font-display text-sm font-bold text-[var(--text)]">{a.name}</span>
                  <span className="block text-xs text-[var(--dim)]">
                    Artist{a.genre ? ` · ${a.genre}` : ""}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
      {showAlbums && d.albums.length > 0 && (
        <>
          <SectionTitle>Albums</SectionTitle>
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {d.albums.map((a) => (
              <AlbumCard key={a.catalogId} album={a} onOpen={() => openAlbum(a.catalogId)} />
            ))}
          </div>
        </>
      )}
      {showSongs && d.songs.length > 0 && (
        <>
          <SectionTitle>Songs</SectionTitle>
          <div className="mt-1 divide-y divide-[var(--border)]">
            {d.songs.map((t, i) => {
              const pt = catalogToPlay(t);
              return (
                <TrackRow
                  key={pt.key + i}
                  track={pt}
                  onPlay={() => player.playQueue(d.songs.map(catalogToPlay), i)}
                />
              );
            })}
          </div>
        </>
      )}
      {showVideos && d.videos.length > 0 && (
        <>
          <SectionTitle>Music videos</SectionTitle>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {d.videos.map((v, i) => (
              <VideoCard key={`${v.title}-${i}`} video={v} onOpen={() => openVideo(v)} />
            ))}
          </div>
        </>
      )}
      {showYouTube && (
        <>
          <SectionTitle>YouTube</SectionTitle>
          {yt.isPending && (
            <p className="mt-2 text-sm text-[var(--dim)]">Searching YouTube…</p>
          )}
          {yt.data && ytVideos.length === 0 && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              No YouTube results for “{query}” right now.
            </p>
          )}
          {ytList.length > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {ytList.map((v) => (
                <YouTubeCard
                  key={v.videoId}
                  video={v}
                  onOpen={() => openYouTube(v)}
                />
              ))}
            </div>
          )}
          {tab === "all" && ytVideos.length > 6 && (
            <button
              type="button"
              onClick={() => setTab("youtube")}
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)]"
            >
              See all {ytVideos.length} YouTube results
              <IconArrowRight className="h-4 w-4" />
            </button>
          )}
        </>
      )}
    </div>
  );
}

function CoverFinder({
  title,
  artist,
  onPick,
}: {
  title: string;
  artist: string;
  onPick: (url: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const covers = useQuery({
    queryKey: ["covers", title, artist],
    queryFn: () => api.findCovers({ title, artist }),
    enabled: open,
  });
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="btn btn-secondary btn-sm"
      >
        <IconImage className="h-4 w-4" />
        AI: find the album cover
      </button>
      {open && (
        <div className="mt-3">
          {covers.isPending && <p className="text-sm text-[var(--dim)]">Searching for covers…</p>}
          {covers.data && covers.data.covers.length === 0 && (
            <p className="text-sm text-[var(--dim)]">No cover found for that title yet.</p>
          )}
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            {(covers.data?.covers ?? []).map((c) => (
              <button
                key={c.url}
                type="button"
                onClick={() => onPick(c.url)}
                aria-label={`Use this cover from ${c.source} for ${c.albumTitle}`}
                className="text-left"
              >
                <img
                  src={c.url}
                  alt={`Cover candidate for ${c.albumTitle}`}
                  className="aspect-square w-full rounded-[var(--radius)] object-cover"
                  loading="lazy"
                />
                <span className="mt-1 block truncate text-[11px] text-[var(--dim)]">
                  {c.albumTitle} · {c.source}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type AlbumInfoFields = {
  title: string;
  artist: string;
  genre: string;
  releaseDate: string;
  label: string;
  producer: string;
  contributors: string; // comma-separated, split on save
  albumInfo: string;
};

// The album cover with the way to change it sitting right on it: a
// big "Change cover" button under the artwork opens the choices —
// upload your own picture from your device, or paste a picture link.
// (Searching the catalog for a cover stays in the CoverFinder further
// down the page.) The parent page supplies the save calls; on a
// catalog album page they save the album to the library first, so the
// user's cover has somewhere to live.
function CoverChanger({
  albumTitle,
  url,
  savesToLibraryFirst,
  uploadCoverFile,
  applyCoverUrl,
}: {
  albumTitle: string;
  url: string | null;
  savesToLibraryFirst?: boolean;
  uploadCoverFile: (file: File) => Promise<void>;
  applyCoverUrl: (url: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [coverUrl, setCoverUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function doCoverFile(file: File) {
    setBusy(true);
    try {
      await uploadCoverFile(file);
      setMsg("Your cover picture is on the album ✓");
      setOpen(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That picture didn't upload.");
    } finally {
      setBusy(false);
    }
  }

  async function doCoverUrl() {
    const u = coverUrl.trim();
    if (!/^https?:\/\//i.test(u)) {
      setMsg("Paste a cover picture link that starts with http:// or https://.");
      return;
    }
    setBusy(true);
    try {
      await applyCoverUrl(u);
      setCoverUrl("");
      setMsg("Cover saved ✓ — it's on the album now.");
      setOpen(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That cover didn't save — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-52 shrink-0 sm:mx-0">
      <Cover url={url} title={albumTitle} size="h-52 w-52" />
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Change the cover of ${albumTitle}`}
        onClick={() => {
          setMsg(null);
          setOpen((v) => !v);
        }}
        className="btn btn-secondary btn-block mt-2"
      >
        <IconImage className="h-4 w-4" />
        {open ? "Close" : "Change cover"}
      </button>
      {msg && (
        <p className="mt-2 text-sm font-semibold text-[var(--text)]">{msg}</p>
      )}
      {open && (
        <div className="mt-2 space-y-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-left">
          <label htmlFor="cover-change-file" className="btn btn-primary btn-block">
            {busy ? "Working…" : "Upload your own picture"}
          </label>
          <input
            id="cover-change-file"
            aria-label={`Upload your own cover picture for ${albumTitle}`}
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void doCoverFile(f);
              e.target.value = "";
            }}
            className="sr-only"
          />
          <input
            aria-label="Or paste a cover picture URL"
            value={coverUrl}
            onChange={(e) => setCoverUrl(e.target.value)}
            placeholder="…or paste a cover picture URL"
            className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
          />
          <button
            type="button"
            disabled={busy || !coverUrl.trim()}
            onClick={() => void doCoverUrl()}
            className="btn btn-secondary btn-block"
          >
            Use this cover
          </button>
          {savesToLibraryFirst && (
            <p className="text-xs text-[var(--dim)]">
              Changing the cover saves this album to your library with
              your cover on it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// One song's own editor on a library album: fix the song's title or
// the artist credited on it, change its track number or disc, move it
// up or down the tracklist, or take it off the album. The parent page
// supplies the move handler (it can see the neighbouring songs); the
// name/number saves and the removal call the track actions directly
// and refresh the library.
function SavedTrackEditor({
  track,
  albumTitle,
  canMoveUp,
  canMoveDown,
  onMove,
}: {
  track: SavedTrack;
  albumTitle: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist);
  const [trackNumber, setTrackNumber] = useState(String(track.trackNumber));
  const [discNumber, setDiscNumber] = useState(String(track.discNumber));
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  const inputCls =
    "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]";
  const labelCls = "block text-sm font-bold text-[var(--text)]";

  async function doSave() {
    if (!title.trim() || !artist.trim()) {
      setMsg("The song title and the artist can't be blank.");
      return;
    }
    const tn = Number.parseInt(trackNumber, 10);
    const dn = Number.parseInt(discNumber, 10);
    if (!Number.isFinite(tn) || tn < 0 || tn > 999) {
      setMsg("The track number needs to be a number from 0 to 999.");
      return;
    }
    if (!Number.isFinite(dn) || dn < 1 || dn > 99) {
      setMsg("The disc number needs to be a number from 1 to 99.");
      return;
    }
    setBusy(true);
    try {
      await api.updateSavedTrack({
        trackId: track.id,
        title: title.trim(),
        artist: artist.trim(),
        trackNumber: tn,
        discNumber: dn,
      });
      refresh();
      setMsg("Song saved ✓ — it shows your words now.");
      setOpen(false);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That save didn't work — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function doMove(dir: -1 | 1) {
    setBusy(true);
    try {
      await onMove(dir);
      setMsg(dir < 0 ? "Moved up ✓" : "Moved down ✓");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That move didn't work — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function doRemove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    setBusy(true);
    try {
      await api.removeSavedTrack({ trackId: track.id });
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That song didn't come off — try again.");
      setBusy(false);
      setConfirmRemove(false);
    }
  }

  return (
    <div className="mb-1 ml-2">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`Edit the song ${track.title} on ${albumTitle}`}
        onClick={() => {
          setTitle(track.title);
          setArtist(track.artist);
          setTrackNumber(String(track.trackNumber));
          setDiscNumber(String(track.discNumber));
          setConfirmRemove(false);
          setMsg(null);
          setOpen((v) => !v);
        }}
        className="btn btn-secondary btn-xs"
      >
        <IconPencil className="h-3.5 w-3.5" />
        {open ? "Close" : "Edit song"}
      </button>
      {!open && msg && (
        <span className="ml-2 text-sm font-semibold text-[var(--text)]">{msg}</span>
      )}
      {open && (
        <div className="mt-2 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
          <div>
            <label className={labelCls} htmlFor={`track-title-${track.id}`}>
              Song title
            </label>
            <input
              id={`track-title-${track.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={`${inputCls} mt-1.5`}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor={`track-artist-${track.id}`}>
              Artist on this song
            </label>
            <input
              id={`track-artist-${track.id}`}
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              className={`${inputCls} mt-1.5`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor={`track-number-${track.id}`}>
                Track number
              </label>
              <input
                id={`track-number-${track.id}`}
                value={trackNumber}
                onChange={(e) => setTrackNumber(e.target.value)}
                inputMode="numeric"
                className={`${inputCls} mt-1.5`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor={`track-disc-${track.id}`}>
                Disc number
              </label>
              <input
                id={`track-disc-${track.id}`}
                value={discNumber}
                onChange={(e) => setDiscNumber(e.target.value)}
                inputMode="numeric"
                className={`${inputCls} mt-1.5`}
              />
            </div>
          </div>
          <p className="text-xs text-[var(--dim)]">
            Songs list in order by disc, then by track number — or just
            use the move buttons.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void doSave()}
              className="btn btn-primary btn-sm"
            >
              {busy ? "Saving…" : "Save song"}
            </button>
            <button
              type="button"
              disabled={busy || !canMoveUp}
              onClick={() => void doMove(-1)}
              aria-label={`Move ${track.title} up one place on ${albumTitle}`}
              className="btn btn-secondary btn-sm"
            >
              Move up
            </button>
            <button
              type="button"
              disabled={busy || !canMoveDown}
              onClick={() => void doMove(1)}
              aria-label={`Move ${track.title} down one place on ${albumTitle}`}
              className="btn btn-secondary btn-sm"
            >
              Move down
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void doRemove()}
              aria-label={
                confirmRemove
                  ? `Tap again to take ${track.title} off ${albumTitle} for good`
                  : `Take ${track.title} off ${albumTitle}`
              }
              className="btn btn-danger-ghost btn-sm"
            >
              {confirmRemove ? "Tap again to remove it" : "Remove song"}
            </button>
          </div>
          {confirmRemove && (
            <p className="text-xs text-[var(--dim)]">
              Removing takes the song — and its uploaded file, if it has
              one — off this album and out of any playlist that points
              at it.
            </p>
          )}
          {msg && <p className="text-sm font-semibold text-[var(--text)]">{msg}</p>}
        </div>
      )}
    </div>
  );
}

// The user's own album-info editor: fix any words that are wrong on an
// album and type in anything the catalog or the AI couldn't find —
// producer, label, who's on it, and the about text. (The cover itself
// is changed with the Change cover button on the artwork — see
// CoverChanger above.) The parent page supplies the save call (a
// catalog album is saved to the library first, so the edits have
// somewhere to live).
function AlbumInfoEditor({
  albumTitle,
  initial,
  saveInfo,
}: {
  albumTitle: string;
  initial: AlbumInfoFields;
  saveInfo: (fields: AlbumInfoFields) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<AlbumInfoFields>(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setField =
    (key: keyof AlbumInfoFields) =>
    (e: { target: { value: string } }) =>
      setFields((f) => ({ ...f, [key]: e.target.value }));

  const inputCls =
    "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]";
  const labelCls = "block text-sm font-bold text-[var(--text)]";

  async function doSave() {
    if (!fields.title.trim() || !fields.artist.trim()) {
      setMsg("The album title and the artist can't be blank.");
      return;
    }
    setSaving(true);
    try {
      await saveInfo(fields);
      setMsg("Album info saved ✓ — this album now shows your words.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "That save didn't work — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-[var(--radius)] bg-[var(--surface)] p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-display text-base font-bold text-[var(--text)]">
          Album info
        </h3>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Edit the album info for ${albumTitle}`}
          onClick={() => {
            setFields(initial);
            setMsg(null);
            setOpen((v) => !v);
          }}
          className="btn btn-secondary btn-sm"
        >
          {open ? "Close" : "Edit album info"}
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Fix any words that are wrong on this album, and fill in anything
        the catalog or the AI couldn't find — the producer, the label,
        who's on it, what the album is about. What you type here is
        saved, and this album shows your words. To change the cover
        itself, use the Change cover button right under the artwork at
        the top of this page.
      </p>
      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="album-title-edit">
                Album title
              </label>
              <input
                id="album-title-edit"
                value={fields.title}
                onChange={setField("title")}
                className={`${inputCls} mt-1.5`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="album-artist-edit">
                Artist
              </label>
              <input
                id="album-artist-edit"
                value={fields.artist}
                onChange={setField("artist")}
                className={`${inputCls} mt-1.5`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="album-genre-edit">
                Genre
              </label>
              <input
                id="album-genre-edit"
                value={fields.genre}
                onChange={setField("genre")}
                placeholder="e.g. Hip-Hop/Rap"
                className={`${inputCls} mt-1.5`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="album-released-edit">
                Release date
              </label>
              <input
                id="album-released-edit"
                value={fields.releaseDate}
                onChange={setField("releaseDate")}
                placeholder="e.g. March 2024"
                className={`${inputCls} mt-1.5`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="album-label-edit">
                Record label
              </label>
              <input
                id="album-label-edit"
                value={fields.label}
                onChange={setField("label")}
                placeholder="The label that put the album out"
                className={`${inputCls} mt-1.5`}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor="album-producer-edit">
                Producer
              </label>
              <input
                id="album-producer-edit"
                value={fields.producer}
                onChange={setField("producer")}
                placeholder="Who produced the album"
                className={`${inputCls} mt-1.5`}
              />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="album-contributors-edit">
              Who's on this album
            </label>
            <input
              id="album-contributors-edit"
              value={fields.contributors}
              onChange={setField("contributors")}
              placeholder="Names, separated by commas"
              className={`${inputCls} mt-1.5`}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="album-about-edit">
              About this album
            </label>
            <textarea
              id="album-about-edit"
              value={fields.albumInfo}
              onChange={setField("albumInfo")}
              rows={4}
              placeholder="What is this album? When did it come out, what are the big songs, what's the story behind it?"
              className={`${inputCls} mt-1.5`}
            />
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => void doSave()}
            className="btn btn-primary"
          >
            {saving ? "Saving…" : "Save album info"}
          </button>
          {msg && <p className="text-sm font-semibold text-[var(--text)]">{msg}</p>}
        </div>
      )}
      {!open && msg && (
        <p className="mt-2 text-sm font-semibold text-[var(--text)]">{msg}</p>
      )}
    </div>
  );
}

function AlbumPage({
  catalogId,
  openArtist,
  goLibrary,
  openAlbum,
  openVideo,
}: {
  catalogId: string;
  openArtist: (name: string, id: string | null) => void;
  goLibrary: () => void;
  openAlbum: (id: string) => void;
  openVideo: (video: CatalogVideo) => void;
}) {
  const player = usePlayer();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["album", catalogId],
    queryFn: () => api.getAlbum({ catalogId }),
  });
  const [savedId, setSavedId] = useState<number | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [coverMsg, setCoverMsg] = useState<string | null>(null);
  useEffect(() => {
    if (detail.data) {
      setSavedId(detail.data.savedId);
      setDownloaded(detail.data.downloaded);
    }
  }, [detail.data]);

  const saveMut = useMutation({
    mutationFn: () => api.saveCatalogAlbum({ catalogId }),
    onSuccess: (r) => {
      setSavedId(r.savedId);
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const downloadMut = useMutation({
    mutationFn: async () => {
      let id = savedId;
      if (!id) {
        const r = await api.saveCatalogAlbum({ catalogId });
        id = r.savedId;
        setSavedId(id);
      }
      await api.setAlbumDownloaded({ albumId: id, downloaded: true });
      return id;
    },
    onSuccess: () => {
      setDownloaded(true);
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const applyCoverMut = useMutation({
    mutationFn: async (url: string) => {
      let id = savedId;
      if (!id) {
        const r = await api.saveCatalogAlbum({ catalogId });
        id = r.savedId;
        setSavedId(id);
      }
      await api.applyCover({ albumId: id, artworkUrl: url });
    },
    onSuccess: () => {
      setCoverMsg("Cover added to your library copy ✓ — it's on this page now too.");
      void queryClient.invalidateQueries({ queryKey: ["album", catalogId] });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });

  // The album-info editor: the user's edits live on their library copy,
  // so editing an album that isn't saved yet saves it first (same as
  // picking a cover does). After a save, this page re-reads and shows
  // the user's words in place of the catalog's.
  const ensureSavedId = async (): Promise<number> => {
    if (savedId != null) return savedId;
    const r = await api.saveCatalogAlbum({ catalogId });
    setSavedId(r.savedId);
    return r.savedId;
  };
  const refreshAlbumViews = () => {
    void queryClient.invalidateQueries({ queryKey: ["album", catalogId] });
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  };
  const editSaveInfo = async (f: AlbumInfoFields) => {
    const id = await ensureSavedId();
    await api.updateAlbumInfo({
      albumId: id,
      title: f.title,
      artist: f.artist,
      genre: f.genre,
      releaseLabel: f.releaseDate,
      releaseDateLabel: f.releaseDate,
      label: f.label,
      producer: f.producer,
      contributors: f.contributors
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      albumInfo: f.albumInfo,
    });
    refreshAlbumViews();
  };
  const editApplyCover = async (url: string) => {
    const id = await ensureSavedId();
    await api.updateAlbumInfo({ albumId: id, artworkUrl: url });
    refreshAlbumViews();
  };
  const editUploadCover = async (file: File) => {
    if (file.size > 12 * 1024 * 1024) {
      throw new Error("That cover picture is over the 12 MB limit.");
    }
    const dataBase64 = await fileToBase64(file);
    const id = await ensureSavedId();
    await api.uploadAlbumCover({
      albumId: id,
      dataBase64,
      mimeType: file.type || "image/jpeg",
    });
    refreshAlbumViews();
  };

  if (detail.isPending) {
    return <p className="py-16 text-center text-sm text-[var(--dim)]">Loading the album…</p>;
  }
  if (detail.error || !detail.data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-[var(--dim)]">That album didn't load.</p>
        <button
          type="button"
          onClick={() => void detail.refetch()}
          className="btn btn-primary mt-3"
        >
          Try again
        </button>
      </div>
    );
  }
  const d: AlbumDetail = detail.data;
  if (!d.album.title && d.tracks.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-[var(--dim)]">
          That album's tracklist didn't come through from the catalog.
        </p>
        <button
          type="button"
          onClick={() => void detail.refetch()}
          className="btn btn-primary mt-3"
        >
          Try again
        </button>
      </div>
    );
  }
  const playTracks = d.tracks.map(catalogToPlay);
  // The album as a play-through queue: ONE rendition per song, in
  // disc + track order. d.tracks is the expanded list — it carries
  // the clean AND explicit rendition of many songs as separate
  // rows — so queueing it raw would play most songs twice and break
  // the album's running order. Each song keeps the first rendition
  // listed for it (the edition this page is showing: its own
  // explicit or clean take), and every tracklist row maps to its
  // song's slot in this queue, so Play — and a tap on any row —
  // runs track 1, then 2, then 3, disc after disc, with no repeats.
  const albumQueue: PlayTrack[] = [];
  const albumQueueIndex: number[] = [];
  {
    const seen = new Map<string, number>();
    d.tracks.forEach((t, i) => {
      const k = `${t.discNumber}|${t.trackNumber}|${t.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()}`;
      const existing = seen.get(k);
      if (existing === undefined) {
        seen.set(k, albumQueue.length);
        albumQueueIndex[i] = albumQueue.length;
        const pt = playTracks[i];
        if (pt) albumQueue.push(pt);
      } else {
        albumQueueIndex[i] = existing;
      }
    });
  }
  // The version this page is showing, when the album has more than
  // one edition — the download button names it, so it's plain that
  // downloading takes this version only.
  const currentEdition =
    d.editions.length > 1
      ? (d.editions.find((e) => e.catalogId === catalogId) ?? null)
      : null;
  const trackGroups = groupByDisc(d.tracks);
  const multiDisc = trackGroups.length > 1;
  // Total album length for the line under the tracklist. The expanded
  // list carries the clean AND explicit rendition of many songs, so
  // count each song once (same disc + track number + title).
  const albumTotalMs = (() => {
    const seen = new Set<string>();
    let total = 0;
    for (const t of d.tracks) {
      const k = `${t.discNumber}|${t.trackNumber}|${t.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim()}`;
      if (!seen.has(k)) {
        seen.add(k);
        total += t.durationMs;
      }
    }
    return total;
  })();
  const tracklistText = trackGroups
    .map((g) =>
      [
        ...(multiDisc ? [`Disc ${g.disc}`] : []),
        ...g.entries.map(
          ({ item: t }, j) =>
            `${t.trackNumber > 0 ? t.trackNumber : j + 1}. ${t.title} — ${t.artist} (${fmtDur(t.durationMs)})`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
  return (
    <div className="pt-4">
      <div className="flex flex-col gap-5 sm:flex-row">
        <CoverChanger
          albumTitle={d.album.title}
          url={d.album.artworkUrl}
          savesToLibraryFirst={savedId == null}
          uploadCoverFile={editUploadCover}
          applyCoverUrl={editApplyCover}
        />
        <div className="min-w-0 flex-1 text-center sm:text-left">
          <h1 className="font-display text-3xl font-extrabold leading-tight text-[var(--text)]">
            {d.album.title}
          </h1>
          <button
            type="button"
            onClick={() => openArtist(d.album.artist, d.album.artistId)}
            aria-label={`Open artist profile for ${d.album.artist}`}
            className="mt-1 font-display text-lg font-bold text-[var(--accent)]"
          >
            {d.album.artist}
          </button>
          <p className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-sm text-[var(--dim)] sm:justify-start">
            <span>
              {d.album.genre ? `${d.album.genre} · ` : ""}
              {d.releaseDateLabel
                ? `Released ${d.releaseDateLabel}`
                : d.album.releaseLabel
                  ? `Released ${d.album.releaseLabel}`
                  : "Release date not listed"}
              {` · ${d.tracks.length} songs`}
              {multiDisc ? ` · ${trackGroups.length} discs` : ""}
            </span>
            <VersionBadge explicitness={d.album.explicitness} />
            {d.album.explicitness === "explicit" && <span>Explicit edition</span>}
            {d.album.explicitness === "clean" && <span>Clean edition</span>}
          </p>
          {d.editions.length > 1 && (
            <div className="mt-3">
              <p className="text-xs font-bold tracking-wide text-[var(--dim)] uppercase">
                Version
              </p>
              <div
                className="mt-1.5 flex flex-wrap justify-center gap-1.5 sm:justify-start"
                role="group"
                aria-label={`Versions of ${d.album.title} — pick the version you want`}
              >
                {d.editions.map((e) => {
                  const isCurrent = e.catalogId === catalogId;
                  return (
                    <button
                      key={e.catalogId}
                      type="button"
                      disabled={isCurrent}
                      onClick={() => openAlbum(e.catalogId)}
                      aria-pressed={isCurrent}
                      aria-label={
                        isCurrent
                          ? `${e.versionLabel} version — the one you're looking at`
                          : `Switch to the ${e.versionLabel} version of ${d.album.title}`
                      }
                      className={`btn-tab ${isCurrent ? "btn-tab-active" : ""}`}
                    >
                      {e.versionLabel}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-xs text-[var(--dim)]">
                This album comes in more than one version. Pick the
                version you want — the tracklist, saving, and downloading
                on this page are for that version only, not the others
                mixed in.
              </p>
            </div>
          )}
          <p className="mt-2 text-xs text-[var(--dim)]">
            Songs below list the clean and explicit versions separately
            wherever both exist — the E badge marks the explicit one.
          </p>
          <dl className="mx-auto mt-4 grid max-w-md grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-left text-sm sm:mx-0">
            <dt className="font-bold text-[var(--text)]">Producer</dt>
            <dd className="text-[var(--dim)]">{d.producer ?? "Not listed in sources"}</dd>
            <dt className="font-bold text-[var(--text)]">Label</dt>
            <dd className="text-[var(--dim)]">{d.album.label ?? "Not listed"}</dd>
            <dt className="font-bold text-[var(--text)]">On this album</dt>
            <dd className="text-[var(--dim)]">
              {d.contributors.length > 0 ? d.contributors.join(", ") : d.album.artist}
            </dd>
          </dl>
          {d.wikiUrl && (
            <p className="mt-2 text-xs text-[var(--dim)]">
              Album background & credits:{" "}
              <a href={d.wikiUrl} target="_blank" rel="noreferrer" className="underline">
                Wikipedia
              </a>{" "}
              · Catalog data: Apple Music / Deezer
            </p>
          )}
          {d.albumInfo && (
            <div className="mt-3 text-left">
              <p className="text-sm font-bold text-[var(--text)]">About this album</p>
              <p className="mt-1 line-clamp-4 text-sm leading-relaxed text-[var(--dim)]">
                {d.albumInfo}
              </p>
            </div>
          )}
          <div className="mt-4 flex flex-wrap justify-center gap-2 sm:justify-start">
            <button
              type="button"
              onClick={() => player.playQueue(albumQueue, 0)}
              className="btn btn-primary"
            >
              <IconPlay className="h-4 w-4" />
              Play
            </button>
            <button
              type="button"
              disabled={saveMut.isPending || savedId != null}
              onClick={() => saveMut.mutate()}
              className="btn btn-secondary"
            >
              {savedId != null ? (
                <>
                  <IconCheck className="h-4 w-4" />
                  In your library
                </>
              ) : saveMut.isPending ? (
                "Saving…"
              ) : (
                <>
                  <IconPlus className="h-4 w-4" />
                  Save to library
                </>
              )}
            </button>
            <button
              type="button"
              disabled={downloadMut.isPending || downloaded}
              onClick={() => downloadMut.mutate()}
              aria-label={
                currentEdition
                  ? `Download the ${currentEdition.versionLabel} version of ${d.album.title} for offline`
                  : `Download ${d.album.title} for offline`
              }
              className="btn btn-secondary"
            >
              {downloaded ? (
                <>
                  <IconCheck className="h-4 w-4" />
                  Downloaded for offline
                </>
              ) : downloadMut.isPending ? (
                "Downloading…"
              ) : (
                <>
                  <IconDownload className="h-4 w-4" />
                  {currentEdition
                    ? `Download the ${currentEdition.versionLabel} version`
                    : "Download for offline"}
                </>
              )}
            </button>
            {d.album.artworkUrl && (
              <button
                type="button"
                onClick={() =>
                  void downloadToDevice(d.album.artworkUrl as string, `${d.album.artist} - ${d.album.title} (cover).jpg`)
                }
                className="btn btn-secondary"
              >
                <IconDownload className="h-4 w-4" />
                Cover to device
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                downloadText(
                  `${d.album.title} — ${d.album.artist}\nReleased: ${d.releaseDateLabel ?? d.album.releaseLabel ?? "Not listed"}\nProducer: ${d.producer ?? "Not listed"}\nLabel: ${d.album.label ?? "Not listed"}\nFeaturing: ${d.contributors.join(", ")}\n\nTracklist:\n${tracklistText}\n`,
                  `${d.album.artist} - ${d.album.title} (tracklist).txt`,
                )
              }
              className="btn btn-secondary"
            >
              <IconDownload className="h-4 w-4" />
              Tracklist to device
            </button>
          </div>
          {(saveMut.data || downloaded) && (
            <button
              type="button"
              onClick={goLibrary}
              className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)] underline"
            >
              Open it in your Library
              <IconArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="mt-6">
        <AlbumInfoEditor
          albumTitle={d.album.title}
          initial={{
            title: d.album.title,
            artist: d.album.artist,
            genre: d.album.genre ?? "",
            releaseDate: d.releaseDateLabel ?? d.album.releaseLabel ?? "",
            label: d.album.label ?? "",
            producer: d.producer ?? "",
            contributors: d.contributors.join(", "),
            albumInfo: d.albumInfo ?? "",
          }}
          saveInfo={editSaveInfo}
        />
      </div>

      <div className="mt-6">
        <CoverFinder
          title={d.album.title}
          artist={d.album.artist}
          onPick={(url) => applyCoverMut.mutate(url)}
        />
        {coverMsg && <p className="mt-2 text-sm font-semibold text-[var(--text)]">{coverMsg}</p>}
      </div>

      <SectionTitle>Tracklist</SectionTitle>
      <p className="mt-1 text-xs text-[var(--dim)]">
        Tap Play and the whole album plays through YouTube inside the
        app, track after track in order — nothing jumps out to the
        YouTube app. Songs you uploaded yourself play from your own
        files instead. Want to fix a song's name, change its order, or
        take a song off? Save this album to your library and open it
        there — every song on your library copy has its own Edit song
        button.
      </p>
      {d.tracks.length === 0 && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          The catalog doesn't list any songs for this album yet.
        </p>
      )}
      {trackGroups.map((g) => (
        <div key={g.disc}>
          {multiDisc && <DiscHeading disc={g.disc} count={g.entries.length} />}
          <div className="mt-1 divide-y divide-[var(--border)]">
            {g.entries.map(({ item: t, index: i }, j) => (
              <TrackRow
                key={`${t.title}-${i}`}
                track={playTracks[i] as PlayTrack}
                onPlay={() =>
                  player.playQueue(albumQueue, albumQueueIndex[i] ?? 0)
                }
                showAlbumArt={false}
                trackNumber={t.trackNumber > 0 ? t.trackNumber : j + 1}
              />
            ))}
          </div>
        </div>
      ))}
      {d.tracks.length > 0 && (
        <p className="mt-4 border-t border-[var(--border)] pt-3 text-sm text-[var(--dim)]">
          {[fmtAlbumLength(albumTotalMs), d.album.label]
            .filter(Boolean)
            .join(" • ")}
        </p>
      )}

      {d.videos.length > 0 && (
        <>
          <SectionTitle>Music videos from this album</SectionTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {d.videos.map((v, i) => (
              <VideoCard key={`${v.title}-${i}`} video={v} onOpen={() => openVideo(v)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ArtistPage({
  name,
  artistId,
  openAlbum,
  openVideo,
  openSaved,
}: {
  name: string;
  artistId: string | null;
  openAlbum: (id: string) => void;
  openVideo: (v: CatalogVideo) => void;
  openSaved: (albumId: number) => void;
}) {
  const [bioOpen, setBioOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editBio, setEditBio] = useState("");
  const [editGenre, setEditGenre] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPhotoUrl, setEditPhotoUrl] = useState("");
  const [editBgUrl, setEditBgUrl] = useState("");
  const [editMsg, setEditMsg] = useState<string | null>(null);
  const player = usePlayer();
  const queryClient = useQueryClient();
  const artist = useQuery({
    queryKey: ["artist", name, artistId],
    queryFn: () => api.getArtist({ name, artistId }),
  });
  const saveProfileMut = useMutation({
    mutationFn: () =>
      api.updateArtistProfile({
        name,
        bio: editBio,
        genre: editGenre,
        description: editDesc,
        photoUrl: editPhotoUrl,
        backgroundUrl: editBgUrl,
      }),
    onSuccess: () => {
      setEditMsg("Profile saved ✓");
      void queryClient.invalidateQueries({ queryKey: ["artist", name, artistId] });
    },
    onError: () => setEditMsg("That save didn't work — try again."),
  });
  const photoMut = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 8 * 1024 * 1024) {
        throw new Error("That photo is over the 8 MB limit.");
      }
      const dataBase64 = await fileToBase64(file);
      return api.uploadArtistPhoto({
        name,
        dataBase64,
        mimeType: file.type || "image/jpeg",
      });
    },
    onSuccess: () => {
      setEditMsg("Artist photo saved ✓");
      void queryClient.invalidateQueries({ queryKey: ["artist", name, artistId] });
    },
    onError: (e) =>
      setEditMsg(e instanceof Error ? e.message : "That photo didn't upload."),
  });
  const bgMut = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > 12 * 1024 * 1024) {
        throw new Error("That background picture is over the 12 MB limit.");
      }
      const dataBase64 = await fileToBase64(file);
      return api.uploadArtistBackground({
        name,
        dataBase64,
        mimeType: file.type || "image/jpeg",
      });
    },
    onSuccess: () => {
      setEditMsg("Background picture saved ✓ — it's behind the name and photo at the top of this page now.");
      void queryClient.invalidateQueries({ queryKey: ["artist", name, artistId] });
    },
    onError: (e) =>
      setEditMsg(e instanceof Error ? e.message : "That background didn't upload."),
  });
  if (artist.isPending) {
    return <p className="py-16 text-center text-sm text-[var(--dim)]">Loading {name}…</p>;
  }
  if (artist.error || !artist.data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-[var(--dim)]">That artist profile didn't load.</p>
        <button
          type="button"
          onClick={() => void artist.refetch()}
          className="btn btn-primary mt-3"
        >
          Try again
        </button>
      </div>
    );
  }
  const d = artist.data;
  const hasBg = Boolean(d.backgroundUrl);
  return (
    <div className="pt-4">
      <div className="relative overflow-hidden rounded-[var(--radius)]">
        {d.backgroundUrl && (
          <img
            src={d.backgroundUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-cover object-top"
          />
        )}
        {hasBg && <div className="absolute inset-0 bg-black/55" aria-hidden="true" />}
        <div
          className={`relative flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left ${hasBg ? "p-5 sm:p-7" : ""}`}
        >
          {d.photoUrl ? (
            <img
              src={d.photoUrl}
              alt={`Photo of ${d.name}`}
              className="h-36 w-36 rounded-full object-cover ring-2 ring-white/40"
            />
          ) : (
            <span className="flex h-36 w-36 items-center justify-center rounded-full bg-[var(--surface2)] font-display text-4xl font-extrabold text-[var(--dim)]">
              {d.name.slice(0, 1)}
            </span>
          )}
          <div>
            <h1
              className={`font-display text-3xl font-extrabold ${hasBg ? "text-white" : "text-[var(--text)]"}`}
            >
              {d.name}
            </h1>
            <p className={`mt-1 text-sm ${hasBg ? "text-white/80" : "text-[var(--dim)]"}`}>
              {d.description ?? "Artist"}
              {d.genre ? ` · ${d.genre}` : ""}
            </p>
            {d.wikiUrl && (
              <a
                href={d.wikiUrl}
                target="_blank"
                rel="noreferrer"
                className={`mt-1 inline-block text-xs underline ${hasBg ? "text-white/70" : "text-[var(--dim)]"}`}
              >
                Bio source: Wikipedia
              </a>
            )}
          </div>
        </div>
      </div>
      {d.bio && (
        <div className="mt-4">
          <p className={`text-sm leading-relaxed text-[var(--text)] ${bioOpen ? "" : "line-clamp-4"}`}>
            {d.bio}
          </p>
          <button
            type="button"
            onClick={() => setBioOpen((v) => !v)}
            className="mt-1 text-sm font-semibold text-[var(--accent)]"
          >
            {bioOpen ? "Show less" : "Read the full bio"}
          </button>
        </div>
      )}
      {!d.bio && (
        <p className="mt-4 text-sm text-[var(--dim)]">
          No biography found for this artist in the sources yet — add their
          info with Edit profile below. Their albums, songs, and videos are
          below.
        </p>
      )}

      <div className="mt-5 rounded-[var(--radius)] bg-[var(--surface)] p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display text-base font-bold text-[var(--text)]">
            Artist profile
          </h3>
          <button
            type="button"
            aria-expanded={editOpen}
            aria-label={`Edit the profile for ${d.name}`}
            onClick={() => {
              setEditBio(d.bio ?? "");
              setEditGenre(d.genre ?? "");
              setEditDesc(d.description ?? "");
              setEditPhotoUrl("");
              setEditBgUrl("");
              setEditMsg(null);
              setEditOpen((v) => !v);
            }}
            className="btn btn-secondary btn-sm"
          >
            {editOpen ? "Close" : "Edit profile"}
          </button>
        </div>
        <p className="mt-1 text-sm text-[var(--dim)]">
          {d.profileId
            ? "The AI created this profile when the album was uploaded — photo, bio, and info included where the sources have them."
            : "Albums you upload for this artist get a profile like this automatically."}{" "}
          Anything missing, you can fill in right here.
        </p>
        {editOpen && (
          <div className="mt-3 space-y-2">
            <label className="block text-sm font-bold text-[var(--text)]" htmlFor="artist-photo-file">
              Artist photo
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="artist-photo-file" className="btn btn-secondary btn-sm">
                {photoMut.isPending ? "Uploading photo…" : "Upload a photo"}
              </label>
              <input
                id="artist-photo-file"
                aria-label={`Upload a photo for ${d.name}`}
                type="file"
                accept="image/*"
                disabled={photoMut.isPending}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) photoMut.mutate(f);
                }}
                className="sr-only"
              />
              <input
                aria-label="Or paste a photo URL for the artist"
                value={editPhotoUrl}
                onChange={(e) => setEditPhotoUrl(e.target.value)}
                placeholder="…or paste a photo URL"
                className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <label className="block text-sm font-bold text-[var(--text)]" htmlFor="artist-bg-file">
              Background picture — the banner behind this page
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="artist-bg-file" className="btn btn-secondary btn-sm">
                {bgMut.isPending ? "Uploading background…" : "Upload a background picture"}
              </label>
              <input
                id="artist-bg-file"
                aria-label={`Upload a background picture for ${d.name}'s profile page`}
                type="file"
                accept="image/*"
                disabled={bgMut.isPending}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) bgMut.mutate(f);
                }}
                className="sr-only"
              />
              <input
                aria-label="Or paste a background picture URL for the artist"
                value={editBgUrl}
                onChange={(e) => setEditBgUrl(e.target.value)}
                placeholder="…or paste a background picture URL"
                className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]"
              />
            </div>
            <label className="block text-sm font-bold text-[var(--text)]" htmlFor="artist-bio-edit">
              About the artist
            </label>
            <textarea
              id="artist-bio-edit"
              value={editBio}
              onChange={(e) => setEditBio(e.target.value)}
              rows={4}
              placeholder={`What should people know about ${d.name}?`}
              className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
            />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                aria-label="Artist genre"
                value={editGenre}
                onChange={(e) => setEditGenre(e.target.value)}
                placeholder="Genre — e.g. Hip-Hop/Rap"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
              />
              <input
                aria-label="Short artist description"
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Short line — e.g. Rapper from Atlanta"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
              />
            </div>
            <button
              type="button"
              disabled={saveProfileMut.isPending}
              onClick={() => saveProfileMut.mutate()}
              className="btn btn-primary"
            >
              {saveProfileMut.isPending ? "Saving…" : "Save profile"}
            </button>
            {editMsg && <p className="text-sm font-semibold text-[var(--text)]">{editMsg}</p>}
          </div>
        )}
        {!editOpen && editMsg && (
          <p className="mt-2 text-sm font-semibold text-[var(--text)]">{editMsg}</p>
        )}
      </div>

      {d.topTracks.length > 0 && (
        <>
          <SectionTitle>Top songs</SectionTitle>
          <div className="mt-1 divide-y divide-[var(--border)]">
            {d.topTracks.map((t, i) => {
              const pt = catalogToPlay(t);
              return (
                <TrackRow
                  key={pt.key + i}
                  track={pt}
                  onPlay={() => player.playQueue(d.topTracks.map(catalogToPlay), i)}
                />
              );
            })}
          </div>
        </>
      )}

      <SectionTitle>Albums</SectionTitle>
      {d.albums.length === 0 && d.uploadedAlbums.length === 0 && (
        <p className="mt-2 text-sm text-[var(--dim)]">No albums listed for this artist in the catalog yet. Albums you upload for this artist will show up here automatically.</p>
      )}
      {d.uploadedAlbums.length > 0 && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          Includes {d.uploadedAlbums.length === 1 ? "your uploaded album" : `${d.uploadedAlbums.length} of your uploaded albums`} — AI filed {d.uploadedAlbums.length === 1 ? "it" : "them"} to this profile.
        </p>
      )}
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {d.uploadedAlbums.map((a) => (
          <button
            key={`uploaded-${a.id}`}
            type="button"
            onClick={() => openSaved(a.id)}
            aria-label={`Open your uploaded album ${a.title} by ${a.artist}`}
            className="text-left"
          >
            <span className="relative block">
              <Cover url={a.artworkUrl} title={a.title} size="aspect-square w-full" />
              <span className="absolute left-1.5 top-1.5 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                Your upload
              </span>
            </span>
            <span className="mt-2 block truncate font-display text-sm font-bold text-[var(--text)]">
              {a.title}
            </span>
            <span className="block truncate text-xs text-[var(--dim)]">
              {a.artist}
              {a.releaseLabel ? ` · ${a.releaseLabel}` : ""}
              {` · ${a.trackCount} ${a.trackCount === 1 ? "song" : "songs"}`}
            </span>
          </button>
        ))}
        {d.albums.map((a) => (
          <AlbumCard key={a.catalogId} album={a} onOpen={() => openAlbum(a.catalogId)} />
        ))}
      </div>

      {d.videos.length > 0 && (
        <>
          <SectionTitle>Music videos</SectionTitle>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {d.videos.map((v, i) => (
              <VideoCard key={`${v.title}-${i}`} video={v} onOpen={() => openVideo(v)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- Scan folder memory (the Fildo folder) ----------
// Scan always remembers the NAME of the folder it was last pointed
// at — the Fildo download folder — and shows it, so the user knows
// exactly which folder to pick again. Older builds also stored the
// folder's File System Access handle in IndexedDB when a pick came
// through that picker; a handle stored that way can still be
// re-scanned from its own “Scan '<folder>' again” button, but new
// picks can't store one — the picker itself is blocked inside this
// app's frame — so picks now arrive through the directory input
// each Scan button wraps, which carries folder names and file
// paths only.
const SCAN_FOLDER_NAME_KEY = "sm-life-scan-folder-name";
// The File System Access folder picker (showDirectoryPicker) is
// never tried from here: it doesn't exist on the user's phone web
// view, and inside this app's frame Chromium refuses it outright
// (“Cross-origin sub frames aren't allowed to show a file picker”).
// Every earlier Scan build that stepped in front of the tap to try
// it — or to fall back from it — left the button dead on his phone
// (nothing opened at all). The Scan buttons are plain labels that
// wrap their own folder input directly, so a tap reaches the
// input through the browser's native label activation with no
// script, no handler, and no async hop in between. Their inputs
// are configured EXACTLY like the folder-pick inputs that work on
// his phone (“Pick Fildo album folders”, “Choose the album
// folder”): `webkitdirectory` and NO `multiple` attribute. The
// Scan inputs carried `multiple` until 2026-11-17 — with both
// attributes set, his phone's file app opens in plain multi-file
// mode and ignores the folder request: folders only navigate,
// there is no “Use this folder”, and songs can only be tapped one
// by one (his report that day). Dropping `multiple` puts the pick
// back in folder mode. A brief detour later that day made the
// main Scan a Recents/Select-all multi-file pick; the user
// corrected it the same day — Recents holds only pictures, no
// music — so the SD-card folder pick is the Scan again, and the
// copy states plainly that a web page cannot make the phone's
// picker open at the SD card (the phone owns that dialog); the
// closest working way is the menu → SD card → Music folder →
// “Use this folder” walk the section copy gives. See the “Scan
// your SD card” section in ImportPanel.

type FsHandleLike = { kind: string; name: string };
type FsFileHandleLike = FsHandleLike & { getFile: () => Promise<File> };
type FsDirHandleLike = FsHandleLike & {
  values: () => {
    next: () => Promise<{ done?: boolean; value: FsHandleLike }>;
  };
  queryPermission?: (o: { mode: string }) => Promise<string>;
  requestPermission?: (o: { mode: string }) => Promise<string>;
};

function scanFolderDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open("sm-life-folders", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("handles");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function loadScanFolderHandle(): Promise<FsDirHandleLike | null> {
  const db = await scanFolderDb();
  if (!db) return null;
  const out = await new Promise<FsDirHandleLike | null>((resolve) => {
    try {
      const req = db
        .transaction("handles")
        .objectStore("handles")
        .get("scan-folder");
      req.onsuccess = () =>
        resolve((req.result as FsDirHandleLike | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  db.close();
  return out;
}

// Walk a remembered folder into plain Files whose webkitRelativePath
// reads "<folder>/<subfolders>/<file>" — the shape Scan groups by.
async function collectFolderFiles(
  dir: FsDirHandleLike,
  prefix: string,
  out: File[],
): Promise<void> {
  const it = dir.values();
  let step = await it.next();
  while (!step.done) {
    const entry = step.value;
    if (entry.kind === "file") {
      const file = await (entry as FsFileHandleLike).getFile();
      try {
        Object.defineProperty(file, "webkitRelativePath", {
          value: `${prefix}/${file.name}`,
          configurable: true,
        });
      } catch {
        // Grouping falls back to the bare file name.
      }
      out.push(file);
    } else if (entry.kind === "directory") {
      await collectFolderFiles(
        entry as FsDirHandleLike,
        `${prefix}/${entry.name}`,
        out,
      );
    }
    step = await it.next();
  }
}

function ImportPanel({
  openArtist,
}: {
  openArtist: (name: string, id: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const [shareText, setShareText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [albumTitle, setAlbumTitle] = useState("");
  const [albumArtist, setAlbumArtist] = useState("");
  const [filedArtist, setFiledArtist] = useState<{
    name: string;
    id: string | null;
  } | null>(null);
  // Whole-folder upload: the user picks the album's folder (e.g. from
  // an app with no share button, like NOMD Music), planAlbumFolder's AI
  // names the album + artist and orders the songs, and each planned
  // album uploads with one tap.
  type FolderPlan = {
    key: number;
    // Identifies the picked album (first song's folder path + song
    // count) so picking the same folder twice doesn't plan it twice,
    // while picking several different folders stacks them all into
    // one batch to upload together.
    signature: string;
    folderName: string;
    title: string;
    artist: string;
    coverFile: File | null;
    coverName: string | null;
    tracks: {
      file: File;
      title: string;
      trackNumber: number;
      discNumber: number;
    }[];
    status: "ready" | "uploading" | "done" | "error";
    note: string | null;
    filed: { name: string; id: string | null } | null;
  };
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderErr, setFolderErr] = useState<string | null>(null);
  const [folderIgnored, setFolderIgnored] = useState(0);
  const [plans, setPlans] = useState<FolderPlan[]>([]);
  const planSeq = useRef(0);
  const patchPlan = (key: number, patch: Partial<FolderPlan>) =>
    setPlans((prev) =>
      prev.map((p) => (p.key === key ? { ...p, ...patch } : p)),
    );
  // Device scan: the user points the app at the one folder that holds
  // all their music (the phone's safety rule — the app can't read any
  // files until the user picks that folder), and from there the scan
  // walks every folder inside it by itself: it plans every album in
  // batches, skips albums already in the library so nothing lands
  // twice, and uploads the rest on its own with live progress — no
  // adding albums one by one. The scanned albums ride the same plan
  // cards as folder uploads, so one the scan can't name an artist for
  // stays behind as a card the user can name and upload.
  const [scanBusy, setScanBusy] = useState(false);
  const [scanErr, setScanErr] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [scanSummary, setScanSummary] = useState<string | null>(null);
  const scanStop = useRef(false);
  // Each Scan button is a <label> wrapping its own directory
  // input as a direct child (see the “How the Scan buttons work”
  // note further down): a tap reaches the input through the
  // browser's own label activation, with nothing in between.
  // The folder Scan was last pointed at: its name is always
  // remembered; a folder handle stored by an older build can
  // still be re-scanned with one tap from its own button.
  const [scanFolderName, setScanFolderName] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(SCAN_FOLDER_NAME_KEY);
    } catch {
      return null;
    }
  });
  const [scanHandleName, setScanHandleName] = useState<string | null>(null);
  useEffect(() => {
    void loadScanFolderHandle().then((h) => {
      if (h) setScanHandleName(h.name);
    });
  }, []);
  const rememberScanFolder = (name: string) => {
    if (!name) return;
    setScanFolderName(name);
    try {
      window.localStorage.setItem(SCAN_FOLDER_NAME_KEY, name);
    } catch {
      // Name just won't persist this time.
    }
  };
  // Walk a remembered folder and hand everything in it to the scan.
  // Quiet on purpose (no error text): only the “Scan '<folder>'
  // again” button calls this, and it reports the failure itself when
  // this can't run.
  const scanHandleIntoScan = async (
    dir: FsDirHandleLike,
  ): Promise<boolean> => {
    try {
      const opts = { mode: "read" };
      let perm = dir.queryPermission
        ? await dir.queryPermission(opts)
        : "granted";
      if (perm !== "granted" && dir.requestPermission) {
        perm = await dir.requestPermission(opts);
      }
      if (perm !== "granted") return false;
      rememberScanFolder(dir.name);
      setScanHandleName(dir.name);
      const files: File[] = [];
      await collectFolderFiles(dir, dir.name, files);
      if (files.length === 0) return false;
      await scanDevice(files);
      return true;
    } catch {
      return false;
    }
  };
  // How the Scan buttons work (rebuilt 2026-11-17, the user's
  // words: “Can you just change it to scan to SD card? … I just
  // want to hit the scan file folder button, click the music
  // folder on the SD card, hit use this folder, and let it scan
  // all the folders that's in that music folder”): each “Scan SD
  // card” button is a <label> that WRAPS its own directory input
  // as a direct child — no htmlFor pointing across the panel at a
  // shared hidden input, no onClick handler, no script of any kind
  // between the tap and the input. Every earlier wiring put
  // something in front of the tap (a File System Access picker
  // attempt Chromium refuses inside this app's frame, a fallback
  // script-click after awaits, a label handler doing state writes
  // and storage reads) and on the user's phone the button sat
  // there dead — nothing opened at all. A label wrapping its own
  // input is the most direct activation a page can offer: the tap
  // lands on the label, the browser itself clicks the input
  // inside it, and the phone's file manager opens. The user then
  // picks the SD card, opens its Music folder, and taps “Use this
  // folder”; the input's onChange hands every file in that folder
  // (and every folder inside it) to scanDevice, which does the
  // rest exactly as before.
  // Can the picker be made to OPEN on the SD card? No — stated
  // plainly in the section copy too: a web page cannot steer the
  // phone's system picker to a tab, a card, or a folder; the
  // phone owns that dialog and opens it where it opens it. The
  // closest working way is the walk the copy gives: tap Scan SD
  // card → in the file manager open the menu and pick the SD
  // card → open the Music folder → tap “Use this folder”. (A
  // Recents/Select-all multi-file pick was tried later the same
  // day and dropped on the user's correction: his Recents holds
  // only pictures, no music.)
  // The input itself must match the working folder picks exactly:
  // `webkitdirectory` and NO `multiple`. The Scan inputs carried
  // `multiple` until the fix later on 2026-11-17 (added in fix #3
  // as “harmless in folder mode”); on his phone's file app it is
  // not harmless — the picker opens in multi-file mode, folders
  // can't be chosen (no “Use this folder” button ever appears),
  // and he was left tapping songs one by one, which is the exact
  // complaint this fix answers. If a phone's file app still shows
  // songs instead of a folder button, the section copy gives the
  // other one-shot pick that app does offer — open the folder,
  // Select all, Open — and scanDevice scans whatever arrived.
  // The remembered folder is NOT re-scanned from the Scan
  // buttons: it has its own “Scan '<folder>' again” button, so a
  // tap on Scan always means “let me pick the folder”.
  // Re-scan the remembered folder without picking — the one place
  // the stored folder handle is used, behind its own button.
  const rescanRememberedFolder = async () => {
    if (scanBusy) return;
    const dir = await loadScanFolderHandle();
    if (!dir) {
      setScanErr(
        "No folder is remembered yet — tap “Scan SD card” and pick the Music folder on your SD card first.",
      );
      return;
    }
    setScanErr(null);
    setScanSummary(null);
    if (!(await scanHandleIntoScan(dir))) {
      setScanErr(
        "Your browser didn't hand SM Life that folder again — tap “Scan SD card” and pick it once more.",
      );
    }
  };

  const importMut = useMutation({
    mutationFn: (text: string) => api.importShared({ text }),
    onSuccess: (r) => {
      setMsg(`Imported “${r.title}” by ${r.artist} — ${r.trackCount} songs, in your library ✓`);
      setErr(null);
      setShareText("");
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
    onError: (e) => {
      setErr(e instanceof Error ? e.message : "That import didn't work.");
      setMsg(null);
    },
  });

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!albumTitle.trim() || !albumArtist.trim()) {
      setErr("Give the album a title and artist first, then pick the files.");
      return;
    }
    setBusy(true);
    setErr(null);
    setMsg(null);
    setFiledArtist(null);
    try {
      const created = await api.createUserAlbum({
        title: albumTitle.trim(),
        artist: albumArtist.trim(),
      });
      setFiledArtist({ name: created.artist, id: created.artistId });
      if (created.alreadyInLibrary) {
        // Same title + artist is already in the library — the copy
        // there was kept, so don't upload the files a second time.
        setMsg(created.filedNote);
        setAlbumTitle("");
        setAlbumArtist("");
        void queryClient.invalidateQueries({ queryKey: ["library"] });
        void queryClient.invalidateQueries({ queryKey: ["artist"] });
        return;
      }
      setMsg(created.filedNote);
      let done = 0;
      for (const file of Array.from(files)) {
        if (file.size > 16 * 1024 * 1024) {
          throw new Error(`“${file.name}” is over the 16 MB per-file limit.`);
        }
        const base64 = await fileToBase64(file);
        const title = file.name.replace(/\.[^.]+$/, "").replace(/^\d+[\s._-]+/, "");
        await api.uploadTrack({
          albumId: created.albumId,
          title: title || file.name,
          artist: created.artist,
          dataBase64: base64,
          mimeType: file.type || "audio/mpeg",
          fileName: file.name,
        });
        done += 1;
        setMsg(`Uploading… ${done} of ${files.length} songs in`);
      }
      // Tracks are in — now build the album's info (who's on it, who
      // produced it, what it's about) from the sources, and make sure
      // the artist profile is complete.
      let creditsNote = "";
      try {
        const credits = await api.enrichUploadedAlbum({
          albumId: created.albumId,
        });
        const bits: string[] = [];
        if (credits.contributors.length > 0)
          bits.push(`On it: ${credits.contributors.slice(0, 6).join(", ")}`);
        if (credits.producer) bits.push(`Produced by ${credits.producer}`);
        if (bits.length > 0) creditsNote = ` ${bits.join(" · ")}.`;
      } catch {
        // Credits are a bonus — the upload itself already succeeded.
      }
      setMsg(
        `Done — “${albumTitle.trim()}” with ${done} full songs is in your library ✓ ${created.filedNote}${creditsNote}`,
      );
      setAlbumTitle("");
      setAlbumArtist("");
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["artist"] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const planFolder = async (picked: FileList | null) => {
    if (!picked || picked.length === 0) return;
    const AUDIO = new Set([
      "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif",
      "aiff", "wma",
    ]);
    const IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp"]);
    const extOf = (name: string) => {
      const m = name.match(/\.([a-z0-9]+)$/i);
      return m ? m[1]!.toLowerCase() : "";
    };
    const all = Array.from(picked);
    const relevant = all.filter((f) => {
      const e = extOf(f.name);
      return AUDIO.has(e) || IMAGE.has(e);
    });
    const audioFiles = relevant.filter((f) => AUDIO.has(extOf(f.name)));
    setFolderErr(null);
    if (audioFiles.length === 0) {
      setFolderErr(
        "No songs in that folder — pick the folder that holds the album's audio files (MP3, WAV, M4A…).",
      );
      return;
    }
    if (relevant.length > 400) {
      setFolderErr(
        "That folder holds more than one upload can take — pick the album's own folder, not a whole music library.",
      );
      return;
    }
    setFolderBusy(true);
    try {
      const res = await api.planAlbumFolder({
        files: relevant.map((f) => ({
          name: f.name,
          path: f.webkitRelativePath || f.name,
          size: f.size,
        })),
      });
      if (res.albums.length === 0) {
        setFolderErr(
          "The AI couldn't find an album in that folder. Try picking the album's own folder, or pick the songs yourself below.",
        );
        return;
      }
      setFolderIgnored((prev) => prev + (all.length - relevant.length));
      // Stack this pick onto any albums already planned: the user can
      // pick several folders of the same artist one after another (or
      // one folder holding several albums) and upload them all at
      // once into that artist's profile. Picking the same album folder
      // twice doesn't add it twice.
      const fresh = res.albums.map((a) => ({
        key: (planSeq.current += 1),
        signature: `${
          a.tracks[0]
            ? (relevant[a.tracks[0].fileIndex]?.webkitRelativePath ??
              a.folderName)
            : a.folderName
        }|${a.tracks.length}`,
        folderName: a.folderName,
          title: a.title,
          artist: a.artist,
          coverFile:
            a.coverFileIndex != null
              ? (relevant[a.coverFileIndex] ?? null)
              : null,
          coverName:
            a.coverFileIndex != null
              ? (relevant[a.coverFileIndex]?.name ?? null)
              : null,
          tracks: a.tracks.map((t) => ({
            file: relevant[t.fileIndex]!,
            title: t.title,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
          })),
          status: "ready" as const,
          note: null,
          filed: null,
        }));
      setPlans((prev) => [
        ...prev,
        ...fresh.filter(
          (np) => !prev.some((p) => p.signature === np.signature),
        ),
      ]);
    } catch (e) {
      setFolderErr(
        e instanceof Error ? e.message : "Reading that folder didn't work.",
      );
    } finally {
      setFolderBusy(false);
    }
  };

  const uploadAllPlans = async () => {
    // One run for a folder that held several albums: upload each
    // planned album in turn (skipping any already in or done).
    for (const p of plans) {
      if (p.status !== "ready" && p.status !== "error") continue;
      if (!p.title.trim() || !p.artist.trim()) continue;
      await uploadFolderAlbum(p);
    }
  };

  const uploadFolderAlbum = async (plan: FolderPlan) => {
    const title = plan.title.trim();
    const artist = plan.artist.trim();
    if (!title || !artist) {
      patchPlan(plan.key, {
        note: "Give the album a title and artist first — the AI couldn't read both from the folder.",
      });
      return null;
    }
    patchPlan(plan.key, { status: "uploading", note: "Starting…" });
    try {
      const created = await api.createUserAlbum({ title, artist });
      if (created.alreadyInLibrary) {
        // Same title + artist already in the library — the copy there
        // was kept; skip the file uploads so nothing lands twice.
        patchPlan(plan.key, {
          status: "done",
          filed: { name: created.artist, id: created.artistId },
          note: created.filedNote,
        });
        void queryClient.invalidateQueries({ queryKey: ["library"] });
        void queryClient.invalidateQueries({ queryKey: ["artist"] });
        return { done: 0, skipped: 0 };
      }
      let done = 0;
      const skipped: string[] = [];
      for (const t of plan.tracks) {
        if (t.file.size > 16 * 1024 * 1024) {
          skipped.push(t.file.name);
          continue;
        }
        const base64 = await fileToBase64(t.file);
        await api.uploadTrack({
          albumId: created.albumId,
          title: t.title,
          artist: created.artist,
          dataBase64: base64,
          mimeType: t.file.type || "audio/mpeg",
          fileName: t.file.name,
          trackNumber: t.trackNumber,
          discNumber: t.discNumber,
        });
        done += 1;
        patchPlan(plan.key, {
          note: `Uploading… ${done} of ${plan.tracks.length} songs in`,
        });
      }
      // The folder's own cover picture becomes the album's cover.
      let coverNote = "";
      if (plan.coverFile && plan.coverFile.size <= 12 * 1024 * 1024) {
        try {
          await api.uploadAlbumCover({
            albumId: created.albumId,
            dataBase64: await fileToBase64(plan.coverFile),
            mimeType: plan.coverFile.type || "image/jpeg",
          });
          coverNote = " The cover picture from the folder is on the album.";
        } catch {
          // The songs matter most — a failed cover never fails the album.
        }
      }
      let creditsNote = "";
      try {
        const credits = await api.enrichUploadedAlbum({
          albumId: created.albumId,
        });
        const bits: string[] = [];
        if (credits.contributors.length > 0)
          bits.push(`On it: ${credits.contributors.slice(0, 6).join(", ")}`);
        if (credits.producer) bits.push(`Produced by ${credits.producer}`);
        if (bits.length > 0) creditsNote = ` ${bits.join(" · ")}.`;
      } catch {
        // Credits are a bonus — the upload itself already succeeded.
      }
      patchPlan(plan.key, {
        status: "done",
        filed: { name: created.artist, id: created.artistId },
        note:
          `Done — “${title}” with ${done} full songs is in your library ✓ ${created.filedNote}${coverNote}${creditsNote}` +
          (skipped.length > 0
            ? ` Left out ${skipped.length} ${skipped.length === 1 ? "song" : "songs"} over the 16 MB per-file limit: ${skipped.join(", ")}.`
            : ""),
      });
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["artist"] });
      return { done, skipped: skipped.length };
    } catch (e) {
      patchPlan(plan.key, {
        status: "error",
        note: `Upload stopped: ${e instanceof Error ? e.message : "something went wrong."} Any songs that already went up are in your library.`,
      });
      return null;
    }
  };

  const scanDevice = async (picked: FileList | File[] | null) => {
    if (!picked || picked.length === 0) return;
    const AUDIO = new Set([
      "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "aif",
      "aiff", "wma",
    ]);
    const IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp"]);
    const extOf = (name: string) => {
      const m = name.match(/\.([a-z0-9]+)$/i);
      return m ? m[1]!.toLowerCase() : "";
    };
    const all = Array.from(picked);
    // Remember the folder this scan was pointed at (the top folder of
    // the picked paths) — the Fildo card shows it, so the user always
    // knows which folder Scan calls home.
    const firstPath = all[0]?.webkitRelativePath ?? "";
    const rootName = firstPath.split("/").filter((p) => p.length > 0)[0];
    if (rootName && firstPath.includes("/")) rememberScanFolder(rootName);
    // A pick with no folder path on any file means the phone's file
    // app handed over the songs themselves (its Select-all/Open pick)
    // instead of the folder — the scan still takes everything that
    // arrived, and the end summary says so plainly instead of
    // pretending a folder was picked.
    const flatPick = !all.some((f) =>
      (f.webkitRelativePath ?? "").includes("/"),
    );
    const relevant = all.filter((f) => {
      const e = extOf(f.name);
      return AUDIO.has(e) || IMAGE.has(e);
    });
    const audioCount = relevant.filter((f) =>
      AUDIO.has(extOf(f.name)),
    ).length;
    setScanErr(null);
    setScanSummary(null);
    setScanNote(null);
    if (audioCount === 0) {
      setScanErr(
        "No songs in there — pick the Music folder on your SD card. The scan looks through every folder inside the one you pick.",
      );
      return;
    }
    setScanBusy(true);
    scanStop.current = false;
    const ignoredCount = all.length - relevant.length;
    try {
      // What's already in the library, so the scan never adds an
      // album twice: uploaded albums by name, with their song file
      // names to confirm a match is really the same album.
      const norm = (s: string) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();
      const lib = await api.listLibrary({});
      const inLibrary = new Map<
        string,
        { fileNames: Set<string>; trackCount: number; hasFull: boolean }
      >();
      for (const a of lib.albums) {
        if (a.source !== "uploaded") continue;
        inLibrary.set(`${norm(a.title)}|${norm(a.artist)}`, {
          fileNames: new Set(
            a.tracks
              .map((t) => (t.fileName ?? "").toLowerCase())
              .filter((n) => n.length > 0),
          ),
          trackCount: a.tracks.length,
          hasFull: a.tracks.some((t) => t.hasFullFile),
        });
      }
      // Group the picked files by album folder — the same rule the
      // planner uses (a trailing "Disc 2"/"CD1" subfolder folds into
      // the album above it) — then plan the groups in batches the
      // planner can take (400 files max per call), so a whole music
      // library fits, not just one album folder.
      const DISC_SEG = /^(?:cd|disc|disk)\s*[-_. ]?(\d{1,2})$/i;
      const groupKeyOf = (f: File) => {
        const parts = (f.webkitRelativePath || f.name)
          .split("/")
          .filter((p) => p.length > 0);
        let dirs = parts.slice(0, -1);
        const last = dirs[dirs.length - 1];
        if (last && dirs.length >= 2 && DISC_SEG.test(last.trim())) {
          dirs = dirs.slice(0, -1);
        }
        return dirs.join("/");
      };
      const groups = new Map<string, File[]>();
      for (const f of relevant) {
        const k = groupKeyOf(f);
        const arr = groups.get(k) ?? [];
        arr.push(f);
        groups.set(k, arr);
      }
      const batches: File[][] = [];
      let batch: File[] = [];
      for (const files of groups.values()) {
        if (files.length > 380) {
          // One folder bigger than a whole batch: slice it — the
          // merge below stitches its plans back into one album.
          if (batch.length > 0) {
            batches.push(batch);
            batch = [];
          }
          for (let i = 0; i < files.length; i += 380) {
            batches.push(files.slice(i, i + 380));
          }
          continue;
        }
        if (batch.length > 0 && batch.length + files.length > 380) {
          batches.push(batch);
          batch = [];
        }
        batch.push(...files);
      }
      if (batch.length > 0) batches.push(batch);

      type ScanDraft = {
        groupKey: string;
        folderName: string;
        title: string;
        artist: string;
        coverFile: File | null;
        coverName: string | null;
        tracks: FolderPlan["tracks"];
      };
      const drafts: ScanDraft[] = [];
      let songsRead = 0;
      for (const b of batches) {
        if (scanStop.current) break;
        const res = await api.planAlbumFolder({
          files: b.map((f) => ({
            name: f.name,
            path: f.webkitRelativePath || f.name,
            size: f.size,
          })),
        });
        songsRead += res.audioCount;
        for (const a of res.albums) {
          const firstTrack = a.tracks[0];
          const firstFile = firstTrack ? b[firstTrack.fileIndex] : undefined;
          const gk = firstFile ? groupKeyOf(firstFile) : a.folderName;
          const tracks = a.tracks.map((t) => ({
            file: b[t.fileIndex]!,
            title: t.title,
            trackNumber: t.trackNumber,
            discNumber: t.discNumber,
          }));
          const coverFile =
            a.coverFileIndex != null ? (b[a.coverFileIndex] ?? null) : null;
          const draft = drafts.find((d) => d.groupKey === gk);
          if (draft) {
            draft.tracks = [...draft.tracks, ...tracks].sort((x, y) => {
              if (x.discNumber !== y.discNumber)
                return x.discNumber - y.discNumber;
              if (x.trackNumber !== y.trackNumber)
                return x.trackNumber - y.trackNumber;
              return (x.file.webkitRelativePath || x.file.name).localeCompare(
                y.file.webkitRelativePath || y.file.name,
                undefined,
                { numeric: true },
              );
            });
            // Slices of one huge folder can restart the numbering —
            // renumber any disc whose numbers now collide.
            const byDisc = new Map<number, typeof draft.tracks>();
            for (const t of draft.tracks) {
              const arr = byDisc.get(t.discNumber) ?? [];
              arr.push(t);
              byDisc.set(t.discNumber, arr);
            }
            for (const arr of byDisc.values()) {
              if (new Set(arr.map((t) => t.trackNumber)).size !== arr.length) {
                arr.forEach((t, i) => {
                  t.trackNumber = i + 1;
                });
              }
            }
            if (!draft.coverFile && coverFile) {
              draft.coverFile = coverFile;
              draft.coverName = coverFile.name;
            }
            if (!draft.title && a.title) draft.title = a.title;
            if (!draft.artist && a.artist) draft.artist = a.artist;
          } else {
            drafts.push({
              groupKey: gk,
              folderName: a.folderName,
              title: a.title,
              artist: a.artist,
              coverFile,
              coverName: coverFile?.name ?? null,
              tracks,
            });
          }
        }
        setScanNote(
          `Reading your folders… found ${songsRead} songs in ${drafts.length} ${drafts.length === 1 ? "album" : "albums"} so far`,
        );
      }

      // Sort the scan out: albums already in the library are skipped,
      // a second copy of an album elsewhere on the device is skipped,
      // albums with no artist the scan could read wait as cards for
      // the user to name, and the rest upload by themselves.
      const existingSigs = new Set(plans.map((p) => p.signature));
      const seen = new Set<string>();
      const toAdd: FolderPlan[] = [];
      const needName: FolderPlan[] = [];
      let alreadyIn = 0;
      let dupCopies = 0;
      let alreadyPlanned = 0;
      for (const d of drafts) {
        const first = d.tracks[0];
        const plan: FolderPlan = {
          key: (planSeq.current += 1),
          signature: `${
            first
              ? (first.file.webkitRelativePath ?? d.folderName)
              : d.folderName
          }|${d.tracks.length}`,
          folderName: d.folderName,
          title: d.title,
          artist: d.artist,
          coverFile: d.coverFile,
          coverName: d.coverName,
          tracks: d.tracks,
          status: "ready",
          note: null,
          filed: null,
        };
        if (existingSigs.has(plan.signature)) {
          alreadyPlanned += 1;
          continue;
        }
        const named = Boolean(d.title.trim() && d.artist.trim());
        if (named) {
          const key = `${norm(d.title)}|${norm(d.artist)}`;
          if (seen.has(key)) {
            dupCopies += 1;
            continue;
          }
          seen.add(key);
          const ex = inLibrary.get(key);
          if (ex && ex.hasFull) {
            const overlap = d.tracks.some((t) =>
              ex.fileNames.has(t.file.name.toLowerCase()),
            );
            if (overlap || ex.trackCount === d.tracks.length) {
              alreadyIn += 1;
              continue;
            }
          }
          toAdd.push(plan);
        } else {
          needName.push(plan);
        }
      }
      const fresh = [...toAdd, ...needName];
      if (fresh.length > 0) {
        setPlans((prev) => [
          ...prev,
          ...fresh.filter((np) => !prev.some((p) => p.signature === np.signature)),
        ]);
      }

      let addedAlbums = 0;
      let addedSongs = 0;
      let bigSkipped = 0;
      let failedAlbums = 0;
      let stoppedEarly = false;
      for (let i = 0; i < toAdd.length; i += 1) {
        if (scanStop.current) {
          stoppedEarly = true;
          break;
        }
        const p = toAdd[i];
        if (!p) continue;
        setScanNote(
          `Adding album ${i + 1} of ${toAdd.length} — “${p.title}” by ${p.artist}…`,
        );
        const r = await uploadFolderAlbum(p);
        if (r) {
          addedAlbums += 1;
          addedSongs += r.done;
          bigSkipped += r.skipped;
        } else {
          failedAlbums += 1;
        }
      }
      setScanNote(null);
      const bits: string[] = [];
      bits.push(
        stoppedEarly
          ? `Scan stopped — added ${addedAlbums} ${addedAlbums === 1 ? "album" : "albums"} (${addedSongs} full songs) before it stopped. The albums that didn't get added are on the cards below — tap “Upload all” above them to finish them.`
          : `Scan done — added ${addedAlbums} ${addedAlbums === 1 ? "album" : "albums"} (${addedSongs} full songs) to your library.`,
      );
      if (flatPick)
        bits.push(
          "Your file app handed over the songs themselves instead of the folder, so these were named from the song files. If a folder ever shows songs instead of a “Use this folder” button, open the folder, choose Select all, then Open — Scan takes everything in it at once.",
        );
      if (addedAlbums > 0)
        bits.push(
          "Every album was filed under its artist's profile — open an artist to see their albums and songs.",
        );
      if (alreadyIn > 0)
        bits.push(
          `Skipped ${alreadyIn} ${alreadyIn === 1 ? "album" : "albums"} already in your library — nothing was added twice.`,
        );
      if (dupCopies > 0)
        bits.push(
          `Left out ${dupCopies} duplicate ${dupCopies === 1 ? "copy" : "copies"} found in other folders on the device.`,
        );
      if (alreadyPlanned > 0)
        bits.push(
          `${alreadyPlanned} ${alreadyPlanned === 1 ? "album was" : "albums were"} already on the cards below from a folder you picked earlier.`,
        );
      if (needName.length > 0)
        bits.push(
          `${needName.length} ${needName.length === 1 ? "album" : "albums"} below still need an artist name — fill it in on ${needName.length === 1 ? "its card" : "their cards"} and tap Upload.`,
        );
      if (failedAlbums > 0)
        bits.push(
          `${failedAlbums} ${failedAlbums === 1 ? "album" : "albums"} hit a problem — ${failedAlbums === 1 ? "it's" : "they're"} marked on the cards below, with a button to try again.`,
        );
      if (bigSkipped > 0)
        bits.push(
          `${bigSkipped} ${bigSkipped === 1 ? "song was" : "songs were"} over the 16 MB per-song limit and couldn't be added — each one is named on its album's card.`,
        );
      if (ignoredCount > 0)
        bits.push(
          `${ignoredCount} ${ignoredCount === 1 ? "file wasn't" : "files weren't"} songs or pictures and were left alone.`,
        );
      setScanSummary(bits.join(" "));
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["artist"] });
    } catch (e) {
      setScanNote(null);
      setScanErr(
        e instanceof Error
          ? `The scan stopped: ${e.message}`
          : "The scan stopped — something went wrong. Any albums already added are in your library.",
      );
    } finally {
      setScanBusy(false);
    }
  };

  return (
    <div className="rounded-[var(--radius)] bg-[var(--surface)] p-4">
      <div className="rounded-[var(--radius)] border border-[var(--border)] p-3">
        <h3 className="font-display text-base font-bold text-[var(--text)]">
          Download from Fildo
        </h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Fildo doesn't give other apps a way in — there's no Fildo
          button or link SM Life can plug into — so albums come over
          through your own files, like this:
        </p>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-[var(--dim)]">
          <li>
            <strong className="text-[var(--text)]">
              Download the album in Fildo first.
            </strong>{" "}
            Open Fildo, find the album, and download the whole thing —
            Fildo saves it as a folder on this device.
          </li>
          <li>
            <strong className="text-[var(--text)]">
              Tap Scan here in SM Life.
            </strong>{" "}
            Use “Scan SD card” right below — your file manager opens,
            you pick the folder, tap “Use this folder”, and Scan
            remembers it for next time. If the file manager shows the
            folder's songs instead of a “Use this folder” button,
            open the folder, choose “Select all”, then tap Open —
            Scan takes everything in the folder at once that way too.
          </li>
          <li>
            <strong className="text-[var(--text)]">
              Point Scan at the folder with the music
            </strong>{" "}
            — the Music folder on your SD card for the music already
            on the card, or the folder Fildo saved the album into
            (look for a Fildo folder in your Downloads).
          </li>
          <li>
            <strong className="text-[var(--text)]">Scan does the rest.</strong>{" "}
            It pulls in whole album folders at once — never track by
            track — the AI files each folder as one album under the
            right artist, anything already in your library is skipped so
            you never get two copies, and the songs play in full right
            here. The files stay in your device's file manager too,
            right where Fildo put them.
          </li>
        </ol>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label
            className={`btn btn-primary ${scanBusy ? "pointer-events-none opacity-50" : ""}`}
          >
            <IconSearch className="h-4 w-4" />
            {scanBusy ? "Scanning…" : "Scan SD card"}
            <input
              ref={(el) => {
                el?.setAttribute("webkitdirectory", "");
              }}
              aria-label="Scan the SD card — pick the Music folder on your SD card"
              type="file"
              disabled={scanBusy}
              onChange={(e) => {
                void scanDevice(e.target.files);
                e.target.value = "";
              }}
              className="sr-only"
            />
          </label>
          <label
            htmlFor="fildo-pick"
            className={`btn btn-secondary ${folderBusy ? "pointer-events-none opacity-50" : ""}`}
          >
            <IconUpload className="h-4 w-4" />
            Pick Fildo album folders
          </label>
          <input
            id="fildo-pick"
            ref={(el) => {
              el?.setAttribute("webkitdirectory", "");
            }}
            aria-label="Pick a Fildo album folder to add to the batch"
            type="file"
            disabled={folderBusy}
            onChange={(e) => {
              void planFolder(e.target.files);
              e.target.value = "";
            }}
            className="sr-only"
          />
          {scanHandleName && (
            <button
              type="button"
              onClick={() => void rescanRememberedFolder()}
              disabled={scanBusy}
              aria-label={`Scan the remembered folder ${scanHandleName} again`}
              className="btn btn-secondary"
            >
              <IconSearch className="h-4 w-4" />
              Scan “{scanHandleName}” again
            </button>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
          Want several albums in one batch? Tap “Pick Fildo album
          folders” once per album folder — each one lines up below, and
          the “Upload all” button brings the whole batch in at once.
        </p>
        {scanFolderName && (
          <p className="mt-1.5 text-xs font-semibold text-[var(--text)]">
            {scanHandleName
              ? `Scan remembers your folder: “${scanFolderName}” — the “Scan “${scanFolderName}” again” button re-checks it without picking, and any Scan button opens your file manager so you can pick a folder yourself. What's already in your library is skipped either way.`
              : `Scan remembers: last time you pointed it at “${scanFolderName}”. Point it at that same folder again and it picks up right where it left off, skipping what's already in your library.`}
          </p>
        )}
      </div>

      <h3 className="mt-6 font-display text-base font-bold text-[var(--text)]">
        Scan your SD card — add all your music at once
      </h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Tap “Scan SD card” and your file manager opens. Straight
        talk: SM Life cannot make that picker open on the SD card —
        no web app can; your phone owns that window and opens it
        where it opens it. The closest working way is one short
        walk inside it: open the menu and pick your SD card, open
        the Music folder on it, and tap “Use this folder”. That's
        the whole pick — one folder. The app then looks through
        every folder inside that Music folder by itself, reads
        every song and album in there, and adds them all to your
        library — no uploading albums one by one, each album filed
        under the right artist's profile, with the profile created
        if that artist is new. Scan remembers the folder you
        picked, so next time it picks up right where it left off.
        Albums already in your library are skipped, so nothing
        lands twice. Your phone makes you pick the folder yourself
        — that's its safety rule; the app can't look through your
        SD card until you point it at the Music folder. Keep the
        app open while it works — a big library can take a while —
        and you can stop it any time.
      </p>
      <p className="mt-2 text-sm font-semibold text-[var(--text)]">
        If your file app doesn't show a “Use this folder” button:
        open the Music folder, tap the three-dot menu, choose
        “Select all”, then tap Open. That hands Scan everything in
        the folder in one pick — you never have to tap songs one by
        one.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label
          className={`btn btn-primary ${scanBusy ? "pointer-events-none opacity-50" : ""}`}
        >
          <IconSearch className="h-4 w-4" />
          {scanBusy ? "Scanning your SD card…" : "Scan SD card"}
          <input
            ref={(el) => {
              el?.setAttribute("webkitdirectory", "");
            }}
            aria-label="Scan the SD card — pick the Music folder on your SD card"
            type="file"
            disabled={scanBusy}
            onChange={(e) => {
              void scanDevice(e.target.files);
              e.target.value = "";
            }}
            className="sr-only"
          />
        </label>
        {scanBusy && (
          <button
            type="button"
            onClick={() => {
              scanStop.current = true;
            }}
            className="btn btn-secondary"
          >
            Stop the scan
          </button>
        )}
      </div>
      {scanNote && (
        <p className="mt-3 text-sm font-semibold text-[var(--text)]">
          {scanNote}
        </p>
      )}
      {scanSummary && (
        <p className="mt-3 text-sm font-semibold text-[var(--text)]">
          {scanSummary}
        </p>
      )}
      {scanErr && (
        <p className="mt-3 text-sm text-[var(--accent)]">{scanErr}</p>
      )}

      <h3 className="mt-6 font-display text-base font-bold text-[var(--text)]">
        Share an album into the app
      </h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        In your other music player, hit Share on an album and copy what it
        gives you — the link, or the album name like “Artist - Album” — then
        paste it here. The whole album lands in your library at once, filled
        with its tracklist and previews. No hunting tracks one by one. No
        share button in that app? Upload the album's folder below instead.
      </p>
      <label htmlFor="share-text" className="mt-3 block text-sm font-bold text-[var(--text)]">
        Paste the shared album link or name
      </label>
      <textarea
        id="share-text"
        value={shareText}
        onChange={(e) => setShareText(e.target.value)}
        rows={2}
        placeholder="e.g. https://music.apple.com/us/album/… or Drake - Take Care"
        className="mt-1.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
      />
      <button
        type="button"
        disabled={!shareText.trim() || importMut.isPending}
        onClick={() => importMut.mutate(shareText.trim())}
        className="mt-2 btn btn-primary"
      >
        {importMut.isPending ? "Importing the album…" : "Import album"}
      </button>

      <h3 className="mt-6 font-display text-base font-bold text-[var(--text)]">
        Upload the whole album folder
      </h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Got the album as a folder of songs on your phone — say from an app
        with no share button, like NOMD Music? Pick the folder and the AI
        uploads it like that: it reads the folder, names the album and the
        artist, puts the songs in order (Disc 1, then Disc 2 right under it
        when the folder splits them up), uses the cover picture from the
        folder when there is one, and files the album to the artist's
        profile — creating the profile if they don't have one yet. You can
        also pick a bigger folder holding several albums (like an artist
        folder), or pick several album folders one after another: each
        folder is one album, the AI plans them all, and one tap uploads
        them all into that artist's profile. The folders themselves are
        never stored — the app builds each album from the songs inside
        it, and those songs play back in full. For music you own.
      </p>
      <label htmlFor="album-folder" className="btn btn-primary mt-3">
        {folderBusy
          ? "AI is reading the folder…"
          : plans.length > 0
            ? "Add another album folder"
            : "Choose the album folder"}
      </label>
      <input
        id="album-folder"
        ref={(el) => {
          el?.setAttribute("webkitdirectory", "");
        }}
        aria-label="Choose the album folder to upload"
        type="file"
        disabled={folderBusy}
        onChange={(e) => {
          void planFolder(e.target.files);
          e.target.value = "";
        }}
        className="sr-only"
      />
      {plans.length > 0 && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          More folders from the same artist? Add each one — every album
          below lands in that artist's profile, in the Albums section,
          alongside their videos.
        </p>
      )}
      {folderErr && (
        <p className="mt-3 text-sm text-[var(--accent)]">{folderErr}</p>
      )}
      {plans.length > 0 && folderIgnored > 0 && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          {folderIgnored} {folderIgnored === 1 ? "file" : "files"} in the
          folder weren't songs or pictures and were left out.
        </p>
      )}
      {plans.filter((p) => p.status === "ready" || p.status === "error")
        .length > 1 && (
        <button
          type="button"
          disabled={plans.some((p) => p.status === "uploading")}
          onClick={() => void uploadAllPlans()}
          className="btn btn-primary mt-3"
        >
          {plans.some((p) => p.status === "uploading")
            ? "Uploading the albums…"
            : `Upload all ${plans.filter((p) => p.status === "ready" || p.status === "error").length} albums`}
        </button>
      )}
      {plans.map((p) => {
        const discs = [...new Set(p.tracks.map((t) => t.discNumber))].sort(
          (a, b) => a - b,
        );
        return (
          <div
            key={p.key}
            className="mt-3 rounded-[var(--radius)] border border-[var(--border)] p-3"
          >
            <p className="text-sm font-bold text-[var(--text)]">
              From the “{p.folderName}” folder — {p.tracks.length}{" "}
              {p.tracks.length === 1 ? "song" : "songs"}
              {discs.length > 1 ? ` across ${discs.length} discs` : ""}
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <input
                aria-label={`Album title for the ${p.folderName} folder upload`}
                value={p.title}
                disabled={p.status === "uploading" || p.status === "done"}
                onChange={(e) => patchPlan(p.key, { title: e.target.value })}
                placeholder="Album title"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
              />
              <input
                aria-label={`Artist for the ${p.folderName} folder upload`}
                value={p.artist}
                disabled={p.status === "uploading" || p.status === "done"}
                onChange={(e) => patchPlan(p.key, { artist: e.target.value })}
                placeholder="Artist — the AI reads it from the folder"
                className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
              />
            </div>
            <div className="mt-2 max-h-52 space-y-2 overflow-y-auto">
              {discs.map((d) => (
                <div key={d}>
                  {discs.length > 1 && (
                    <p className="text-xs font-bold tracking-wide text-[var(--dim)] uppercase">
                      Disc {d}
                    </p>
                  )}
                  <ol className="text-sm text-[var(--dim)]">
                    {p.tracks
                      .filter((t) => t.discNumber === d)
                      .map((t, ti) => (
                        <li key={`${d}-${ti}`}>
                          {t.trackNumber}. {t.title}
                        </li>
                      ))}
                  </ol>
                </div>
              ))}
            </div>
            {p.coverName && (
              <p className="mt-1 text-sm text-[var(--dim)]">
                Cover picture from the folder: {p.coverName}
              </p>
            )}
            {p.status === "ready" && (
              <button
                type="button"
                disabled={
                  !p.title.trim() ||
                  !p.artist.trim() ||
                  plans.some((q) => q.status === "uploading")
                }
                onClick={() => void uploadFolderAlbum(p)}
                className="btn btn-primary mt-2"
              >
                Upload this album
              </button>
            )}
            {p.status === "error" && (
              <button
                type="button"
                disabled={
                  !p.title.trim() ||
                  !p.artist.trim() ||
                  plans.some((q) => q.status === "uploading")
                }
                onClick={() => void uploadFolderAlbum(p)}
                className="btn btn-secondary mt-2"
              >
                Try the upload again
              </button>
            )}
            {p.note && (
              <p className="mt-2 text-sm font-semibold text-[var(--text)]">
                {p.note}
              </p>
            )}
            {p.filed && p.status === "done" && (
              <button
                type="button"
                onClick={() => openArtist(p.filed!.name, p.filed!.id)}
                aria-label={`View ${p.filed.name} artist profile to see this album in the Albums section`}
                className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)] underline"
              >
                See it on the {p.filed.name} profile — in Albums
                <IconArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>
        );
      })}

      <h3 className="mt-6 font-display text-base font-bold text-[var(--text)]">
        Or pick the album's songs yourself
      </h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        No folder? Pick all the songs at once — they become one album in your
        library and play back in full. MP3, WAV, or M4A, up to 16 MB each.
        The AI files every upload to that artist's profile, so it shows up in
        the Albums section on their page — type the artist's name and the AI
        matches it to the right profile, even if the capitalization is off.
        If the artist has no profile yet, the AI creates one on the spot:
        their name and photo, what they're about, and the album's info —
        who's on the album and who produced it, where the sources list
        them.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          aria-label="Album title for uploaded files"
          value={albumTitle}
          onChange={(e) => setAlbumTitle(e.target.value)}
          placeholder="Album title"
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
        />
        <input
          aria-label="Artist name for uploaded files"
          value={albumArtist}
          onChange={(e) => setAlbumArtist(e.target.value)}
          placeholder="Artist"
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
        />
      </div>
      <label
        htmlFor="album-files"
        className="btn btn-secondary mt-3"
      >
        {busy ? "Uploading…" : "Choose the album's songs"}
      </label>
      <input
        id="album-files"
        aria-label="Choose audio files for the album"
        type="file"
        accept="audio/*,.mp3,.wav,.m4a"
        multiple
        disabled={busy}
        onChange={(e) => void uploadFiles(e.target.files)}
        className="sr-only"
      />
      {msg && <p className="mt-3 text-sm font-semibold text-[var(--text)]">{msg}</p>}
      {filedArtist && !busy && (
        <button
          type="button"
          onClick={() => openArtist(filedArtist.name, filedArtist.id)}
          aria-label={`View ${filedArtist.name} artist profile to see this album in the Albums section`}
          className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)] underline"
        >
          See it on the {filedArtist.name} profile — in Albums
          <IconArrowRight className="h-4 w-4" />
        </button>
      )}
      {err && <p className="mt-3 text-sm text-[var(--accent)]">{err}</p>}
    </div>
  );
}

function AiFillPanel() {
  const queryClient = useQueryClient();
  const [artist, setArtist] = useState("");
  const [album, setAlbum] = useState("");
  const fillMut = useMutation({
    mutationFn: () => api.aiFillAlbum({ artistName: artist.trim(), albumTitle: album.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["artist"] });
    },
  });
  return (
    <div className="rounded-[var(--radius)] bg-[var(--surface)] p-4">
      <h3 className="font-display text-base font-bold text-[var(--text)]">
        AI: fill an album for me
      </h3>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Don't have the tracks? Name any album and the AI finds it, pulls in
        the real tracklist, the cover, and the album info, and drops it in
        your library ready to play previews. Full songs come from files you
        upload above.
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          aria-label="Artist for AI album fill"
          value={artist}
          onChange={(e) => setArtist(e.target.value)}
          placeholder="Artist — e.g. Drake"
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
        />
        <input
          aria-label="Album title for AI album fill"
          value={album}
          onChange={(e) => setAlbum(e.target.value)}
          placeholder="Album — e.g. Take Care"
          className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
        />
      </div>
      <button
        type="button"
        disabled={!artist.trim() || !album.trim() || fillMut.isPending}
        onClick={() => fillMut.mutate()}
        className="mt-2 btn btn-primary"
      >
        {fillMut.isPending ? (
          "AI is finding the songs…"
        ) : (
          <>
            <IconSparkles className="h-4 w-4" />
            Fill this album
          </>
        )}
      </button>
      {fillMut.data && (
        <p className="mt-3 text-sm font-semibold text-[var(--text)]">
          “{fillMut.data.title}” is in your library with {fillMut.data.trackCount}{" "}
          songs ✓ — find it under Your albums below.
        </p>
      )}
      {fillMut.error && (
        <p className="mt-3 text-sm text-[var(--accent)]">
          {fillMut.error instanceof Error ? fillMut.error.message : "Couldn't fill that album."}
        </p>
      )}
    </div>
  );
}

function SavedAlbumPage({
  album,
  openArtist,
  openVideo,
}: {
  album: SavedAlbum;
  openArtist: (name: string, id: string | null) => void;
  openVideo: (video: CatalogVideo) => void;
}) {
  const player = usePlayer();
  const queryClient = useQueryClient();
  const videosQ = useQuery({
    queryKey: ["albumVideos", album.id, album.tracks.length],
    queryFn: () => api.albumVideos({ albumId: album.id }),
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [artistHint, setArtistHint] = useState("");
  const fileMut = useMutation({
    mutationFn: () =>
      api.aiFileAlbum({ albumId: album.id, artistHint: artistHint.trim() }),
    onSuccess: (r) => {
      setMsg(`${r.filedNote} ✓`);
      void queryClient.invalidateQueries({ queryKey: ["library"] });
      void queryClient.invalidateQueries({ queryKey: ["artist"] });
    },
    onError: (e) => {
      setMsg(e instanceof Error ? e.message : "AI filing didn't work — try again.");
    },
  });
  const downloadMut = useMutation({
    mutationFn: (v: boolean) =>
      api.setAlbumDownloaded({ albumId: album.id, downloaded: v }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["library"] }),
  });
  const removeMut = useMutation({
    mutationFn: () => api.removeSavedAlbum({ albumId: album.id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["library"] }),
  });
  const applyCoverMut = useMutation({
    mutationFn: (url: string) => api.applyCover({ albumId: album.id, artworkUrl: url }),
    onSuccess: () => {
      setMsg("Cover added ✓");
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const enrichMut = useMutation({
    mutationFn: () => api.enrichUploadedAlbum({ albumId: album.id }),
    onSuccess: (r) => {
      setMsg(
        r.producer || r.contributors.length > 0
          ? "Album info built ✓ — credits are on this page now."
          : "The sources don't list credits for this album yet — nothing was guessed or filled in. You can type them in yourself with Edit album info below.",
      );
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
    onError: () => setMsg("Building the album info didn't work — try again."),
  });
  // The album-info editor: the user's own words, saved straight onto
  // this library album.
  const editSaveInfo = async (f: AlbumInfoFields) => {
    await api.updateAlbumInfo({
      albumId: album.id,
      title: f.title,
      artist: f.artist,
      genre: f.genre,
      releaseLabel: f.releaseDate,
      releaseDateLabel: f.releaseDate,
      label: f.label,
      producer: f.producer,
      contributors: f.contributors
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      albumInfo: f.albumInfo,
    });
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  };
  const editApplyCover = async (url: string) => {
    await api.updateAlbumInfo({ albumId: album.id, artworkUrl: url });
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  };
  const editUploadCover = async (file: File) => {
    if (file.size > 12 * 1024 * 1024) {
      throw new Error("That cover picture is over the 12 MB limit.");
    }
    const dataBase64 = await fileToBase64(file);
    await api.uploadAlbumCover({
      albumId: album.id,
      dataBase64,
      mimeType: file.type || "image/jpeg",
    });
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  };
  const playTracks = album.tracks.map((t) => savedToPlay(t, album.artworkUrl));
  // Move a song one place up or down the tracklist (the Edit song
  // panel's buttons): the song swaps disc + track number with its
  // neighbour in the album's listed order. When the two neighbours
  // carry the same number (uploads whose files had no numbers), the
  // whole disc is renumbered in its new order instead, so the move
  // still lands.
  const moveTrack = async (index: number, dir: -1 | 1) => {
    const a = album.tracks[index];
    const b = album.tracks[index + dir];
    if (!a || !b) return;
    if (a.discNumber === b.discNumber && a.trackNumber === b.trackNumber) {
      const discTracks = album.tracks.filter(
        (t) => t.discNumber === a.discNumber,
      );
      const pos = discTracks.findIndex((t) => t.id === a.id);
      const swapWith = discTracks[pos + dir];
      if (!swapWith) return;
      const reordered = [...discTracks];
      reordered[pos] = swapWith;
      reordered[pos + dir] = a;
      for (let k = 0; k < reordered.length; k++) {
        const t = reordered[k];
        if (t && t.trackNumber !== k + 1) {
          await api.updateSavedTrack({ trackId: t.id, trackNumber: k + 1 });
        }
      }
    } else {
      await api.updateSavedTrack({
        trackId: a.id,
        trackNumber: b.trackNumber,
        discNumber: b.discNumber,
      });
      await api.updateSavedTrack({
        trackId: b.id,
        trackNumber: a.trackNumber,
        discNumber: a.discNumber,
      });
    }
    void queryClient.invalidateQueries({ queryKey: ["library"] });
  };
  const savedGroups = groupByDisc(album.tracks);
  const savedMultiDisc = savedGroups.length > 1;
  const savedTotalMs = album.tracks.reduce((sum, t) => sum + t.durationMs, 0);
  return (
    <div className="pt-4">
      <div className="flex flex-col gap-5 sm:flex-row">
        <CoverChanger
          albumTitle={album.title}
          url={album.artworkUrl}
          uploadCoverFile={editUploadCover}
          applyCoverUrl={editApplyCover}
        />
        <div className="min-w-0 flex-1 text-center sm:text-left">
          <h1 className="font-display text-3xl font-extrabold leading-tight text-[var(--text)]">
            {album.title}
          </h1>
          <button
            type="button"
            onClick={() => openArtist(album.artist, null)}
            aria-label={`Open artist profile for ${album.artist} to see this album in the Albums section`}
            className="mt-1 font-display text-lg font-bold text-[var(--accent)]"
          >
            {album.artist}
          </button>
          <p className="mt-1 text-xs text-[var(--dim)]">
            On the {album.artist} profile, in Albums — tap the artist name to see it there.
          </p>
          <p className="mt-2 text-sm text-[var(--dim)]">
            {album.genre ? `${album.genre} · ` : ""}
            {album.releaseDateLabel
              ? `Released ${album.releaseDateLabel} · `
              : album.releaseLabel
                ? `Released ${album.releaseLabel} · `
                : ""}
            {album.tracks.length} songs
            {savedMultiDisc ? ` · ${savedGroups.length} discs` : ""} ·{" "}
            {album.source === "uploaded"
              ? "your uploaded files"
              : album.source === "imported"
                ? "shared into the app"
                : "from the catalog"}
          </p>
          <dl className="mx-auto mt-4 grid max-w-md grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-left text-sm sm:mx-0">
            <dt className="font-bold text-[var(--text)]">Producer</dt>
            <dd className="text-[var(--dim)]">{album.producer ?? "Not listed in sources"}</dd>
            <dt className="font-bold text-[var(--text)]">Label</dt>
            <dd className="text-[var(--dim)]">{album.label ?? "Not listed"}</dd>
            <dt className="font-bold text-[var(--text)]">On this album</dt>
            <dd className="text-[var(--dim)]">
              {album.contributors.length > 0 ? album.contributors.join(", ") : album.artist}
            </dd>
          </dl>
          {album.albumInfo && (
            <div className="mt-3 text-left">
              <p className="text-sm font-bold text-[var(--text)]">About this album</p>
              <p className="mt-1 line-clamp-4 text-sm leading-relaxed text-[var(--dim)]">
                {album.albumInfo}
              </p>
            </div>
          )}
          <button
            type="button"
            disabled={enrichMut.isPending}
            onClick={() => enrichMut.mutate()}
            aria-label={`Build the album info for ${album.title}: who's on it, who produced it, and what it's about`}
            className="btn btn-secondary btn-sm mt-3"
          >
            <IconSparkles className="h-4 w-4" />
            {enrichMut.isPending
              ? "AI is building the album info…"
              : "AI: build the album info"}
          </button>
          <div className="mt-4 flex flex-wrap justify-center gap-2 sm:justify-start">
            <button
              type="button"
              disabled={playTracks.length === 0}
              onClick={() => player.playQueue(playTracks, 0)}
              className="btn btn-primary"
            >
              <IconPlay className="h-4 w-4" />
              Play
            </button>
            <button
              type="button"
              disabled={downloadMut.isPending}
              onClick={() => downloadMut.mutate(!album.downloaded)}
              className="btn btn-secondary"
            >
              {album.downloaded ? (
                <>
                  <IconCheck className="h-4 w-4" />
                  Downloaded — tap to remove
                </>
              ) : (
                <>
                  <IconDownload className="h-4 w-4" />
                  Download for offline
                </>
              )}
            </button>
            <button
              type="button"
              disabled={removeMut.isPending}
              onClick={() => removeMut.mutate()}
              className="btn btn-danger-ghost"
            >
              Remove from library
            </button>
          </div>
          <p className="mt-3 text-xs text-[var(--dim)]">
            {album.downloaded
              ? "Downloaded: this album stays in your library for offline listening."
              : "Offline downloads keep the album and its playable tracks saved inside the app."}
          </p>
        </div>
      </div>
      <div className="mt-6">
        <AlbumInfoEditor
          albumTitle={album.title}
          initial={{
            title: album.title,
            artist: album.artist,
            genre: album.genre ?? "",
            releaseDate: album.releaseDateLabel ?? album.releaseLabel ?? "",
            label: album.label ?? "",
            producer: album.producer ?? "",
            contributors: album.contributors.join(", "),
            albumInfo: album.albumInfo ?? "",
          }}
          saveInfo={editSaveInfo}
        />
      </div>
      <div className="mt-6">
        <CoverFinder
          title={album.title}
          artist={album.artist}
          onPick={(url) => applyCoverMut.mutate(url)}
        />
        {msg && <p className="mt-2 text-sm font-semibold text-[var(--text)]">{msg}</p>}
      </div>
      <div className="mt-6 rounded-[var(--radius)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-base font-bold text-[var(--text)]">
          AI: file this album to its artist profile
        </h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          This album belongs in the Albums section on its artist's profile.
          The AI checks the artist name, fixes it if it's written wrong, and
          files the album there. Leave the box blank to re-file under{" "}
          {album.artist}, or type the correct artist to move it.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            aria-label="Correct artist for AI filing (optional)"
            value={artistHint}
            onChange={(e) => setArtistHint(e.target.value)}
            placeholder={`Artist — currently ${album.artist}`}
            className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
          />
          <button
            type="button"
            disabled={fileMut.isPending}
            onClick={() => fileMut.mutate()}
            className="btn btn-primary shrink-0"
          >
            <IconSparkles className="h-4 w-4" />
            {fileMut.isPending ? "AI is filing…" : "File to artist profile"}
          </button>
        </div>
        {fileMut.data && (
          <button
            type="button"
            onClick={() => openArtist(fileMut.data.artist, fileMut.data.artistId)}
            aria-label={`View ${fileMut.data.artist} artist profile`}
            className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent)] underline"
          >
            View the {fileMut.data.artist} profile
            <IconArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
      <SectionTitle>Songs</SectionTitle>
      {album.tracks.length > 0 && (
        <p className="mt-1 text-sm text-[var(--dim)]">
          These songs are yours to run: every one has an Edit song
          button — fix its title or the artist on it, change its track
          number, move it up or down, or take it off the album.
        </p>
      )}
      {album.tracks.length === 0 && (
        <p className="mt-2 text-sm text-[var(--dim)]">
          No songs in this album yet — add files from the share/import panel in
          your Library.
        </p>
      )}
      {savedGroups.map((g) => (
        <div key={g.disc}>
          {savedMultiDisc && <DiscHeading disc={g.disc} count={g.entries.length} />}
          <div className="mt-1 divide-y divide-[var(--border)]">
            {g.entries.map(({ item: t, index: i }, j) => (
              <div key={t.id}>
                <TrackRow
                  track={playTracks[i] as PlayTrack}
                  onPlay={() => player.playQueue(playTracks, i)}
                  showAlbumArt={false}
                  trackNumber={t.trackNumber > 0 ? t.trackNumber : j + 1}
                />
                <SavedTrackEditor
                  track={t}
                  albumTitle={album.title}
                  canMoveUp={i > 0}
                  canMoveDown={i < album.tracks.length - 1}
                  onMove={(dir) => moveTrack(i, dir)}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      {album.tracks.length > 0 && (savedTotalMs > 0 || album.label) && (
        <p className="mt-4 border-t border-[var(--border)] pt-3 text-sm text-[var(--dim)]">
          {[
            savedTotalMs > 0 ? fmtAlbumLength(savedTotalMs) : null,
            album.label,
          ]
            .filter(Boolean)
            .join(" • ")}
        </p>
      )}

      <SectionTitle>Music videos from this album</SectionTitle>
      {videosQ.isPending ? (
        <p className="mt-2 text-sm text-[var(--dim)]">Finding this album's videos…</p>
      ) : videosQ.data && videosQ.data.videos.length > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {videosQ.data.videos.map((v, i) => (
            <VideoCard key={`${v.title}-${i}`} video={v} onOpen={() => openVideo(v)} />
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-[var(--dim)]">
          No music videos in the catalog match this album's songs yet. When
          videos exist for these songs, they show up here automatically.
        </p>
      )}
    </div>
  );
}

function LibraryPage({
  openSaved,
  openCatalogAlbum,
  openArtist,
  theme,
  applyTheme,
  uploadJump,
  planTier,
  onSetPlan,
  planPending,
  showAds,
  onUpgrade,
  onAskTiana,
}: {
  openSaved: (albumId: number) => void;
  openCatalogAlbum: (catalogId: string) => void;
  openArtist: (name: string, id: string | null) => void;
  theme: "light" | "dark";
  applyTheme: (t: "light" | "dark") => void;
  // Bumped by the shell every time an Upload button is tapped, so the
  // page scrolls straight to the upload panel below.
  uploadJump: number;
  planTier: PlanTier;
  onSetPlan: (tier: PlanTier) => void;
  planPending: boolean;
  showAds: boolean;
  onUpgrade: () => void;
  onAskTiana: () => void;
}) {
  const appRequestsQ = useQuery({
    queryKey: ["appRequests"],
    queryFn: () => api.listAppRequests({}),
  });
  const uploadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (uploadJump > 0) {
      const t = setTimeout(
        () =>
          uploadRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          }),
        60,
      );
      return () => clearTimeout(t);
    }
  }, [uploadJump]);
  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.listLibrary({}),
  });
  const player = usePlayer();
  const queryClient = useQueryClient();
  const [newPlaylist, setNewPlaylist] = useState("");
  const createMut = useMutation({
    mutationFn: (name: string) => api.createPlaylist({ name }),
    onSuccess: () => {
      setNewPlaylist("");
      void queryClient.invalidateQueries({ queryKey: ["library"] });
    },
  });
  const deletePlaylistMut = useMutation({
    mutationFn: (id: number) => api.deletePlaylist({ playlistId: id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["library"] }),
  });
  const removeItemMut = useMutation({
    mutationFn: (id: number) => api.removePlaylistItem({ itemId: id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["library"] }),
  });

  if (library.isPending) {
    return <p className="py-16 text-center text-sm text-[var(--dim)]">Loading your library…</p>;
  }
  if (library.error || !library.data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-[var(--dim)]">Your library didn't load.</p>
        <button
          type="button"
          onClick={() => void library.refetch()}
          className="btn btn-primary mt-3"
        >
          Try again
        </button>
      </div>
    );
  }
  const d = library.data;
  const downloaded = d.albums.filter((a) => a.downloaded);
  return (
    <div>
      <h1 className="mt-4 font-display text-2xl font-extrabold text-[var(--text)]">
        Your library
      </h1>
      {showAds && <HouseAdCard variant="premium" onUpgrade={onUpgrade} />}
      <div ref={uploadRef} className="mt-4 space-y-4 scroll-mt-40">
        <h2 className="flex items-center gap-2 font-display text-lg font-bold text-[var(--text)]">
          <IconUpload className="h-5 w-5 text-[var(--accent)]" />
          Upload your music
        </h2>
        <ImportPanel openArtist={openArtist} />
        <AiFillPanel />
      </div>

      <SectionTitle>Downloaded for offline</SectionTitle>
      {downloaded.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--dim)]">
          Nothing downloaded yet. Open any album and hit “Download for
          offline” and it'll live here.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {downloaded.map((a) => (
            <AlbumCard
              key={a.id}
              album={{
                catalogId: a.catalogId,
                title: a.title,
                artist: a.artist,
                artistId: null,
                artworkUrl: a.artworkUrl,
                genre: a.genre,
                releaseLabel: a.releaseLabel,
                releaseDateIso: null,
                trackCount: a.tracks.length,
                explicitness: "none",
              }}
              onOpen={() => openSaved(a.id)}
            />
          ))}
        </div>
      )}

      <SectionTitle>Your albums</SectionTitle>
      {d.albums.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--dim)]">
          No albums saved yet. Search for one, share one in above, or let the
          AI fill one for you.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {d.albums.map((a) => (
            <AlbumCard
              key={a.id}
              album={{
                catalogId: a.catalogId,
                title: a.title,
                artist: a.artist,
                artistId: null,
                artworkUrl: a.artworkUrl,
                genre: a.genre,
                releaseLabel: a.releaseLabel,
                releaseDateIso: null,
                trackCount: a.tracks.length,
                explicitness: "none",
              }}
              onOpen={() =>
                a.catalogId.startsWith("user-")
                  ? openSaved(a.id)
                  : openCatalogAlbum(a.catalogId)
              }
            />
          ))}
        </div>
      )}

      <SectionTitle>Playlists</SectionTitle>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (newPlaylist.trim()) createMut.mutate(newPlaylist.trim());
        }}
      >
        <input
          aria-label="Name for a new playlist"
          value={newPlaylist}
          onChange={(e) => setNewPlaylist(e.target.value)}
          placeholder="New playlist name"
          className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)]"
        />
        <button
          type="submit"
          disabled={!newPlaylist.trim() || createMut.isPending}
          className="btn btn-primary"
        >
          Create
        </button>
      </form>
      {d.playlists.length === 0 && (
        <p className="mt-3 text-sm text-[var(--dim)]">
          No playlists yet — create one, then add songs with the “+ Playlist”
          button on any track.
        </p>
      )}
      <div className="mt-3 space-y-4">
        {d.playlists.map((p) => {
          const playItems: PlayTrack[] = p.items.map((i) => ({
            key: `pl-${i.id}`,
            title: i.title,
            artist: i.artist,
            artworkUrl: i.artworkUrl,
            previewUrl: i.previewUrl,
            durationMs: i.durationMs,
            playlistItemId: i.id,
          }));
          return (
            <div key={p.id} className="rounded-[var(--radius)] bg-[var(--surface)] p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-base font-bold text-[var(--text)]">
                  {p.name}
                  <span className="ml-2 text-xs font-normal text-[var(--dim)]">
                    {p.items.length} songs
                  </span>
                </h3>
                <span className="flex gap-2">
                  <button
                    type="button"
                    disabled={playItems.length === 0}
                    onClick={() => player.playQueue(playItems, 0)}
                    aria-label={`Play playlist ${p.name}`}
                    className="btn btn-primary btn-xs"
                  >
                    <IconPlay className="h-3.5 w-3.5" />
                    Play
                  </button>
                  <button
                    type="button"
                    onClick={() => deletePlaylistMut.mutate(p.id)}
                    aria-label={`Delete playlist ${p.name}`}
                    className="btn btn-danger-ghost btn-xs"
                  >
                    Delete
                  </button>
                </span>
              </div>
              <div className="mt-2 divide-y divide-[var(--border)]">
                {p.items.map((item, idx) => (
                  <div key={item.id} className="flex items-center gap-2 py-1">
                    <div className="min-w-0 flex-1">
                      <TrackRow
                        track={playItems[idx] as PlayTrack}
                        onPlay={() => player.playQueue(playItems, idx)}
                      />
                    </div>
                    <button
                      type="button"
                      aria-label={`Remove ${item.title} from ${p.name}`}
                      onClick={() => removeItemMut.mutate(item.id)}
                      className="icon-btn shrink-0 border border-[var(--border)] !p-1.5 text-[var(--dim)]"
                    >
                      <IconX className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {d.history.length > 0 && (
        <>
          <SectionTitle>Recently played</SectionTitle>
          <div className="mt-2 space-y-1 pb-2">
            {d.history.slice(0, 15).map((h) => (
              <div key={h.id} className="flex items-center gap-3 px-1 py-1">
                <Cover url={h.artworkUrl} title={h.title} size="h-9 w-9" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--text)]">{h.title}</span>
                  <span className="block truncate text-xs text-[var(--dim)]">{h.artist}</span>
                </span>
                <span className="shrink-0 text-[11px] text-[var(--dim)]">
                  {new Date(h.playedAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <SectionTitle>Settings</SectionTitle>
      <div className="mt-3 space-y-4 rounded-[var(--radius)] bg-[var(--surface)] p-4">
        <div>
          <p className="text-sm font-bold text-[var(--text)]">Ask Tiana</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
            This copy of the app isn&apos;t connected to Tiana, so a
            change sent from here wouldn&apos;t reach her. To ask for a
            change, send it in Muse, where SM Life Streaming lives.
            Your earlier requests are listed below, with what was done
            for each one.
          </p>
          <button
            type="button"
            onClick={onAskTiana}
            aria-label="Ask Tiana to change the app"
            className="btn btn-primary mt-3"
          >
            <IconSparkles className="h-4 w-4" />
            Ask Tiana
          </button>
          {(appRequestsQ.data?.requests ?? []).length > 0 && (
            <ul className="mt-3 space-y-2">
              {(appRequestsQ.data?.requests ?? []).map((r) => (
                <li
                  key={r.id}
                  className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[var(--text)]">{r.text}</p>
                    <p className="mt-0.5 text-xs font-semibold text-[var(--dim)]">
                      {r.status === "done"
                        ? `Update is completed ✓${r.resolutionNote ? ` — ${r.resolutionNote}` : ""}`
                        : "Saved — waiting for Tiana to build it"}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Hear Tiana's reply to: ${r.text}`}
                    onClick={() => speakTiana(requestSpeechText(r), true)}
                    className="icon-btn shrink-0 border border-[var(--border)] !p-2"
                  >
                    <IconSpeaker className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-sm font-bold text-[var(--text)]">Your plan</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
            {planTier === "developer"
              ? "You're the developer — this is your own account, so you get the whole app with no ads, ever. Switch to Free below any time to preview exactly what a free App Store download looks like with its ads."
              : planTier === "premium"
                ? "Premium is on — the whole app, paid for, with no ads anywhere."
                : "You're on Free — the whole app, with ads. Pay for Premium and every ad turns off. The developer's own account never sees ads."}
          </p>
          <div className="mt-3 space-y-2" role="radiogroup" aria-label="Choose your plan">
            {(
              [
                {
                  tier: "developer" as PlanTier,
                  name: "Developer",
                  desc: "Your own account as the developer. The whole app, no ads — you never play with ads.",
                },
                {
                  tier: "free" as PlanTier,
                  name: "Free",
                  desc: "The free App Store download. The whole app, with ads on Home, Search, and the player.",
                },
                {
                  tier: "premium" as PlanTier,
                  name: "Premium",
                  desc: "The paid plan. The whole app, no ads anywhere — paying turns every ad off.",
                },
              ] as const
            ).map((opt) => {
              const active = planTier === opt.tier;
              return (
                <div
                  key={opt.tier}
                  className={`flex items-center gap-3 rounded-[var(--radius)] border p-3 ${
                    active
                      ? "border-[var(--text)] bg-[var(--surface2)]"
                      : "border-[var(--border)]"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-[var(--text)]">
                      {opt.name}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
                          opt.tier === "free"
                            ? "bg-[var(--surface)] text-[var(--dim)]"
                            : "bg-black text-[#ffb340]"
                        }`}
                      >
                        {opt.tier === "free" ? "With ads" : "No ads"}
                      </span>
                      {active && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--accent)]">
                          <IconCheck className="h-3.5 w-3.5" />
                          Current plan
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-[var(--dim)]">
                      {opt.desc}
                    </p>
                  </div>
                  {!active && (
                    <button
                      type="button"
                      disabled={planPending}
                      onClick={() => onSetPlan(opt.tier)}
                      aria-label={
                        opt.tier === "premium"
                          ? "Switch to Premium plan — pay to remove all ads"
                          : opt.tier === "free"
                            ? "Switch to Free plan — preview the app with ads"
                            : "Switch to Developer plan — your ad-free developer account"
                      }
                      className="btn btn-primary btn-sm shrink-0"
                    >
                      {opt.tier === "premium"
                        ? "Go Premium"
                        : opt.tier === "free"
                          ? "Preview Free"
                          : "Use Developer"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
            In the App Store version, Premium is paid through the store
            and the ads turn off the moment the payment goes through.
            Here the switch happens right away so you can preview every
            tier on your own phone.
          </p>
        </div>
        <div>
          <p className="text-sm font-bold text-[var(--text)]">Theme</p>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Dark or light for the whole app — it stays on your pick next
            time you open the app.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              aria-label="Use light theme"
              aria-pressed={theme === "light"}
              onClick={() => applyTheme("light")}
              className={`btn btn-sm ${theme === "light" ? "btn-primary" : "btn-secondary"}`}
            >
              <IconSun className="h-4 w-4" />
              Light
            </button>
            <button
              type="button"
              aria-label="Use dark theme"
              aria-pressed={theme === "dark"}
              onClick={() => applyTheme("dark")}
              className={`btn btn-sm ${theme === "dark" ? "btn-primary" : "btn-secondary"}`}
            >
              <IconMoon className="h-4 w-4" />
              Dark
            </button>
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-[var(--text)]">Spatial Audio</p>
            <button
              type="button"
              aria-label="Toggle Spatial Audio"
              aria-pressed={player.spatial}
              onClick={() => player.setSpatial(!player.spatial)}
              className="btn-toggle"
            >
              <span className="switch" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Widens the stereo sound and adds clarity, Apple Music style —
            the song keeps playing straight through when you switch it.
            Stays on until you switch it off.
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-[var(--text)]">DJ crossfade</p>
            <button
              type="button"
              aria-label="Toggle DJ crossfade"
              aria-pressed={player.crossfadeOn}
              onClick={() => player.setCrossfadeOn(!player.crossfadeOn)}
              className="btn-toggle"
            >
              <span className="switch" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Blends the end of one song into the start of the next.
          </p>
        </div>
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-[var(--text)]">Slowed</p>
            <button
              type="button"
              aria-label="Toggle slow down pitch and speed"
              aria-pressed={player.slowed}
              onClick={() => player.setSlowed(!player.slowed)}
              className="btn-toggle btn-toggle-amber"
            >
              <span className="switch" aria-hidden="true" />
            </button>
          </div>
          <p className="mt-0.5 text-xs text-[var(--dim)]">
            Slows pitch and speed down together, DJ style. Stays on until
            you switch it off.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------- assistant-triggered playback ----------
// When the user asks the assistant in chat or on a call to play a track,
// the assistant calls the requestPlayback action; this bridge polls for
// that request, starts the track in the app's own player, and acks it so
// the assistant can confirm back to the user that it's playing.
function AssistantPlaybackBridge({
  onStarted,
}: {
  onStarted: (label: string) => void;
}) {
  const player = usePlayer();
  const queryClient = useQueryClient();
  const handledRef = useRef<Set<number>>(new Set());
  const pending = useQuery({
    queryKey: ["pending-playback"],
    queryFn: () => api.getPendingPlayback({}),
    refetchInterval: 4000,
  });
  const ackMut = useMutation({
    mutationFn: (v: {
      requestId: number;
      status: "playing" | "done" | "failed";
    }) => api.ackPlayback(v),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["pending-playback"] }),
  });
  const req = pending.data?.request ?? null;
  const reqId = req?.id;
  useEffect(() => {
    if (!req || reqId == null) return;
    if (handledRef.current.has(reqId)) return;
    handledRef.current.add(reqId);
    const track: PlayTrack = {
      key: `assistant-${req.id}`,
      title: req.title,
      artist: req.artist,
      artworkUrl: req.artworkUrl,
      previewUrl: req.previewUrl,
      fallbackPreviewUrl: req.fallbackPreviewUrl,
      durationMs: req.durationMs,
      savedTrackId: req.savedTrackId,
      albumTitle: req.albumTitle ?? undefined,
    };
    player.playQueue([track], 0);
    ackMut.mutate({ requestId: req.id, status: "playing" });
    onStarted(`${req.title} — ${req.artist}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqId]);
  return null;
}

// ---------- voice search (speak to search) ----------
// YouTube-style speak-to-search: tap the mic, say a song, artist, or
// album out loud, and the words land in the search box and the search
// runs on its own — no typing, no extra Search tap. Recognition is
// the browser's own built-in speech recognizer (the Web Speech API —
// SpeechRecognition / webkitSpeechRecognition); the app adds no new
// server source and sends nothing anywhere itself: it only receives
// the transcript and hands it to the same search everything else
// uses. Where the browser has no recognizer (or the mic is blocked),
// the button says so plainly and typing still works as before.

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike {
  error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function VoiceSearchButton({
  onResult,
  onInterim,
}: {
  // Called once with the finished words — the caller runs the search.
  onResult: (text: string) => void;
  // Called as words are heard, so the search box fills in live.
  onInterim?: (text: string) => void;
}) {
  const [heard, setHeard] = useState("");
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const heardRef = useRef("");
  const deliveredRef = useRef(false);
  const erroredRef = useRef(false);
  // Latest callbacks in refs, so a recognition session started
  // earlier still delivers to the current caller.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onInterimRef = useRef(onInterim);
  onInterimRef.current = onInterim;

  useEffect(
    () => () => {
      try {
        recRef.current?.abort();
      } catch {
        // Already gone — nothing to clean up.
      }
      recRef.current = null;
    },
    [],
  );

  const deliver = useCallback((text: string) => {
    const t = text.trim();
    if (!t || deliveredRef.current) return;
    deliveredRef.current = true;
    onResultRef.current(t);
  }, []);

  const start = () => {
    setError(null);
    setHeard("");
    heardRef.current = "";
    deliveredRef.current = false;
    erroredRef.current = false;
    const Ctor = speechRecognitionCtor();
    if (!Ctor) {
      setError(
        "Voice search isn't available in this browser — type your search instead, it works the same.",
      );
      return;
    }
    let rec: SpeechRecognitionLike;
    try {
      rec = new Ctor();
    } catch {
      setError("Voice search couldn't start here — type your search instead.");
      return;
    }
    recRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        const alt = r[0];
        if (!alt) continue;
        if (r.isFinal) finalText += alt.transcript;
        else interimText += alt.transcript;
      }
      if (finalText.trim()) {
        heardRef.current = finalText.trim();
        setHeard(finalText.trim());
        onInterimRef.current?.(finalText.trim());
        deliver(finalText);
      } else if (interimText.trim()) {
        heardRef.current = interimText.trim();
        setHeard(interimText.trim());
        onInterimRef.current?.(interimText.trim());
      }
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return;
      erroredRef.current = true;
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError(
          "The microphone is blocked — allow microphone access for this app, then tap Voice again.",
        );
      } else if (e.error === "no-speech") {
        setError("Didn't hear anything — tap Voice and speak right away.");
      } else if (e.error === "audio-capture") {
        setError("No microphone was found on this device.");
      } else if (e.error === "network") {
        setError(
          "Voice search needs an internet connection — check it and tap Voice again.",
        );
      } else {
        setError(
          "Voice search hit a snag — tap Voice to try again, or type your search.",
        );
      }
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
      // A recognizer that ends holding only interim words (it stopped
      // before marking them final) still searches for what it heard.
      if (!erroredRef.current) deliver(heardRef.current);
    };
    try {
      rec.start();
      setListening(true);
    } catch {
      // start() throws when a session is already running — the live
      // one keeps listening.
      setListening(true);
    }
  };

  const stop = () => {
    try {
      recRef.current?.stop();
    } catch {
      setListening(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={
          listening
            ? "Listening — speak now. Tap to stop voice search"
            : "Search by voice — tap and speak"
        }
        aria-pressed={listening}
        onClick={() => (listening ? stop() : start())}
        className={
          listening
            ? "btn shrink-0 animate-pulse bg-[var(--accent)] text-white"
            : "btn btn-secondary shrink-0"
        }
      >
        <IconMic className="h-4 w-4" />
        {listening ? "Listening…" : "Voice"}
      </button>
      {(listening || error || heard) && (
        <p
          role="status"
          aria-live="polite"
          className={`w-full basis-full text-sm ${
            error ? "font-semibold text-[var(--accent)]" : "text-[var(--dim)]"
          }`}
        >
          {error ??
            (listening
              ? heard
                ? `Listening… “${heard}”`
                : "Listening… speak now — say a song, an artist, or an album."
              : `You said “${heard}” — searching for it now.`)}
        </p>
      )}
    </>
  );
}

// ---------- search bar suggestions ----------
// Live dropdown under the search bar, in place from the first letter
// typed: artists, albums, songs and videos that begin with what's
// typed (or whose artist's name contains it), plus the user's own
// library — all from the dedicated suggest action, refreshed on every
// keystroke. Rows open the profile / album directly or play the song.

function SearchSuggestions({
  input,
  open,
  onClose,
  onPickArtist,
  onPickAlbum,
  onPickSaved,
  onPickSong,
  onPickVideo,
  onSeeAll,
}: {
  input: string;
  open: boolean;
  onClose: () => void;
  onPickArtist: (name: string, artistId: string | null) => void;
  onPickAlbum: (catalogId: string) => void;
  onPickSaved: (albumId: number) => void;
  onPickSong: (track: PlayTrack) => void;
  onPickVideo: (video: CatalogVideo) => void;
  onSeeAll: () => void;
}) {
  const trimmed = input.trim();
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(trimmed), 200);
    return () => clearTimeout(t);
  }, [trimmed]);
  // Suggestions start at the FIRST letter typed and refresh on every
  // keystroke — the dedicated suggest action only returns names and
  // titles that begin with what's typed, so one letter is enough.
  const results = useQuery({
    queryKey: ["suggest", debounced],
    queryFn: () => api.suggest({ query: debounced }),
    enabled: open && debounced.length >= 1,
  });
  if (!open || trimmed.length < 1) return null;
  const d = results.data;
  const lib = d?.libraryMatches;
  const artists = (d?.artists ?? []).slice(0, 3);
  const albums = (d?.albums ?? []).slice(0, 3);
  const libArtists = (lib?.artists ?? []).slice(0, 2);
  const libAlbums = (lib?.albums ?? []).slice(0, 2);
  const libTracks = (lib?.tracks ?? []).slice(0, 4);
  const songs = (d?.songs ?? []).slice(0, 4);
  const videos = (d?.videos ?? []).slice(0, 3);
  const hasAny =
    artists.length > 0 ||
    albums.length > 0 ||
    libArtists.length > 0 ||
    libAlbums.length > 0 ||
    libTracks.length > 0 ||
    songs.length > 0 ||
    videos.length > 0;
  // Section order follows what was typed: an exact artist-name match
  // keeps Artists on top; an exact album-title match (and no exact
  // artist) puts Albums on top, so the album itself pops up first.
  const keyOf = (s: string) =>
    s
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\b(feat|ft)\.? .*/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const exactArtist =
    artists.some((a) => keyOf(a.name) === keyOf(trimmed)) ||
    libArtists.some((n) => keyOf(n) === keyOf(trimmed));
  const exactAlbum =
    albums.some((a) => keyOf(a.title) === keyOf(trimmed)) ||
    libAlbums.some((a) => keyOf(a.title) === keyOf(trimmed));
  const albumsFirst = exactAlbum && !exactArtist;
  return (
    <div
      role="listbox"
      aria-label="Search suggestions"
      className="absolute inset-x-0 top-full z-50 mt-2 flex max-h-[70vh] flex-col overflow-y-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] shadow-xl"
    >
      {results.isPending && (
        <p className="px-4 py-3 text-sm text-[var(--dim)]">
          Searching for “{trimmed}”…
        </p>
      )}
      {d && !hasAny && (
        <p className="px-4 py-3 text-sm text-[var(--dim)]">
          Nothing in the catalog or your library matches “{trimmed}” yet
          — press Search to see everything.
        </p>
      )}
      {artists.length > 0 && (
        <div className={`py-1 ${albumsFirst ? "order-3" : "order-1"}`}>
          <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
            Artists
          </p>
          {artists.map((a) => (
            <button
              key={`sa-${a.name}`}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={`Open artist profile for ${a.name}`}
              onClick={() => {
                onPickArtist(a.name, a.artistId);
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface2)]"
            >
              {a.artworkUrl ? (
                <img
                  src={a.artworkUrl}
                  alt={`Photo of ${a.name}`}
                  className="h-10 w-10 shrink-0 rounded-full object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] font-display font-bold text-[var(--dim)]">
                  {a.name.slice(0, 1)}
                </span>
              )}
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[var(--text)]">
                  {a.name}
                </span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  Artist profile{a.genre ? ` · ${a.genre}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {libArtists.length > 0 && (
        <div className={`py-1 ${albumsFirst ? "order-4" : "order-2"}`}>
          <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
            Artists in your library
          </p>
          {libArtists.map((name) => (
            <button
              key={`sla-${name}`}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={`Open artist profile for ${name}`}
              onClick={() => {
                onPickArtist(name, null);
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface2)]"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--surface2)] font-display font-bold text-[var(--dim)]">
                {name.slice(0, 1)}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[var(--text)]">
                  {name}
                </span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  Artist profile · in your library
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {albums.length > 0 && (
        <div className={`py-1 ${albumsFirst ? "order-1" : "order-3"}`}>
          <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
            Albums
          </p>
          {albums.map((a) => (
            <button
              key={`sal-${a.catalogId}`}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={`Open album ${a.title} by ${a.artist}`}
              onClick={() => {
                onPickAlbum(a.catalogId);
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface2)]"
            >
              <Cover
                url={a.artworkUrl}
                title={a.title}
                size="h-10 w-10 shrink-0 rounded-[var(--radius)]"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[var(--text)]">
                  {a.title}
                </span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  Album · {a.artist}
                  {a.releaseLabel ? ` · ${a.releaseLabel}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {libAlbums.length > 0 && (
        <div className={`py-1 ${albumsFirst ? "order-2" : "order-4"}`}>
          <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
            Albums in your library
          </p>
          {libAlbums.map((a) => (
            <button
              key={`slb-${a.id}`}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={`Open album ${a.title} by ${a.artist} from your library`}
              onClick={() => {
                onPickSaved(a.id);
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface2)]"
            >
              <Cover
                url={a.artworkUrl}
                title={a.title}
                size="h-10 w-10 shrink-0 rounded-[var(--radius)]"
              />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-[var(--text)]">
                  {a.title}
                </span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  Album · {a.artist} · in your library
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {songs.length > 0 && (
        <div className="order-5 py-1">
          <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
            Songs
          </p>
          {songs.map((t, i) => {
            const pt = catalogToPlay(t);
            return (
              <button
                key={`ss-${pt.key}-${i}`}
                type="button"
                role="option"
                aria-selected={false}
                aria-label={`Play ${t.title} by ${t.artist}`}
                onClick={() => {
                  onPickSong(pt);
                  onClose();
                }}
                className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface2)]"
              >
                <Cover
                  url={t.artworkUrl}
                  title={t.title}
                  size="h-10 w-10 shrink-0 rounded-[var(--radius)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--text)]">
                    {t.title}
                  </span>
                  <span className="block truncate text-xs text-[var(--dim)]">
                    Song · {t.artist}
                  </span>
                </span>
                <IconPlay className="h-4 w-4 shrink-0 text-[var(--dim)]" />
              </button>
            );
          })}
        </div>
      )}
      {libTracks.length > 0 && (
        <div className="order-5 py-1">
          <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
            Songs in your library
          </p>
          {libTracks.map((t) => {
            const pt: PlayTrack = {
              key: `saved-${t.id}`,
              title: t.title,
              artist: t.artist,
              artworkUrl: t.artworkUrl,
              previewUrl: t.previewUrl,
              durationMs: t.durationMs,
              savedTrackId: t.id,
            };
            return (
              <button
                key={`slt-${t.id}`}
                type="button"
                role="option"
                aria-selected={false}
                aria-label={`Play ${t.title} by ${t.artist} from your library`}
                onClick={() => {
                  onPickSong(pt);
                  onClose();
                }}
                className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface2)]"
              >
                <Cover
                  url={t.artworkUrl}
                  title={t.title}
                  size="h-10 w-10 shrink-0 rounded-[var(--radius)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--text)]">
                    {t.title}
                  </span>
                  <span className="block truncate text-xs text-[var(--dim)]">
                    Song · {t.artist} · in your library
                  </span>
                </span>
                <IconPlay className="h-4 w-4 shrink-0 text-[var(--dim)]" />
              </button>
            );
          })}
        </div>
      )}
      {videos.length > 0 && (
        <div className="order-6 py-1">
          <p className="px-4 pb-1 pt-2 text-[11px] font-bold uppercase tracking-wide text-[var(--dim)]">
            Videos
          </p>
          {videos.map((v, i) => (
            <button
              key={`sv-${v.title}-${v.artist}-${i}`}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={`Watch music video ${v.title} by ${v.artist}`}
              onClick={() => {
                onPickVideo(v);
                onClose();
              }}
              className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[var(--surface2)]"
            >
              <Cover
                url={v.artworkUrl}
                title={v.title}
                size="h-10 w-16 shrink-0 rounded-[var(--radius)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-[var(--text)]">
                  {v.title}
                </span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  Music video · {v.artist}
                </span>
              </span>
              <IconPlay className="h-4 w-4 shrink-0 text-[var(--dim)]" />
            </button>
          ))}
        </div>
      )}
      {d && (
        <button
          type="button"
          onClick={() => {
            onSeeAll();
            onClose();
          }}
          className="order-7 block w-full border-t border-[var(--border)] px-4 py-3 text-left text-sm font-semibold text-[var(--accent)] hover:bg-[var(--surface2)]"
        >
          See all results for “{trimmed}”
        </button>
      )}
    </div>
  );
}

// ---------- spoken word (podcasts + audiobooks): resume ----------
// Where he left off, per episode/chapter, kept in this browser: while
// a podcast episode or audiobook chapter plays, its position is saved
// every few seconds; starting it again seeks back to that spot once
// the audio can play. Finished items (played to the last seconds)
// clear their saved spot so they start fresh next time.
const SPOKEN_PROGRESS_PREFIX = "spoken-progress:";
function spokenSaved(key: string): number {
  try {
    const v = Number(window.localStorage.getItem(SPOKEN_PROGRESS_PREFIX + key));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function useSpokenResume() {
  const player = usePlayer();
  const playerRef = useRef(player);
  playerRef.current = player;
  const pendingRef = useRef<{ key: string; secs: number } | null>(null);
  useEffect(() => {
    const save = setInterval(() => {
      const p = playerRef.current;
      const cur = p.current;
      if (
        !cur ||
        !(cur.key.startsWith("podcast-") || cur.key.startsWith("audiobook-"))
      ) {
        return;
      }
      try {
        if (p.duration > 0 && p.currentTime > 5 && p.duration - p.currentTime > 8) {
          window.localStorage.setItem(
            SPOKEN_PROGRESS_PREFIX + cur.key,
            String(Math.floor(p.currentTime)),
          );
        } else if (p.duration > 0 && p.duration - p.currentTime <= 8) {
          window.localStorage.removeItem(SPOKEN_PROGRESS_PREFIX + cur.key);
        }
      } catch {
        // Storage unavailable — resume just doesn't persist.
      }
    }, 4000);
    const seeker = setInterval(() => {
      const pend = pendingRef.current;
      const p = playerRef.current;
      if (pend && p.current?.key === pend.key && p.duration > 0) {
        p.seek(pend.secs);
        pendingRef.current = null;
      }
    }, 500);
    return () => {
      clearInterval(save);
      clearInterval(seeker);
    };
  }, []);
  const playWithResume = useCallback(
    (tracks: PlayTrack[], index: number, atSecs?: number) => {
      const t = tracks[index];
      playerRef.current.playQueue(tracks, index);
      if (t) {
        const secs = atSecs ?? spokenSaved(t.key);
        if (secs > 10) pendingRef.current = { key: t.key, secs };
      }
    },
    [],
  );
  return { playWithResume };
}

// ---------- podcasts ----------

type ChartShow = ApiResponse<typeof api, "podcastCharts">["shows"][number];
type PodcastHit = ApiResponse<typeof api, "searchPodcasts">["shows"][number];

function PodcastsPage() {
  const player = usePlayer();
  const { playWithResume } = useSpokenResume();
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);
  const [selected, setSelected] = useState<{
    collectionId: string;
    title: string;
  } | null>(null);
  const charts = useQuery({
    queryKey: ["podcastCharts"],
    queryFn: () => api.podcastCharts({}),
    enabled: !selected && debounced.length === 0,
  });
  const search = useQuery({
    queryKey: ["podcastSearch", debounced],
    queryFn: () => api.searchPodcasts({ query: debounced }),
    enabled: !selected && debounced.length >= 1,
  });
  const episodesQ = useQuery({
    queryKey: ["podcastEpisodes", selected?.collectionId],
    queryFn: () => api.getPodcastEpisodes({ collectionId: selected!.collectionId }),
    enabled: selected != null,
  });

  if (selected) {
    const d = episodesQ.data;
    const tracks: PlayTrack[] = (d?.episodes ?? []).map((e) => ({
      key: `podcast-${e.episodeId}`,
      title: e.title,
      artist: d?.show.title ?? selected.title,
      artworkUrl: d?.show.artworkUrl ?? null,
      previewUrl: e.audioUrl,
      durationMs: e.durationMs,
      albumTitle: d?.show.title ?? selected.title,
    }));
    return (
      <div className="pt-4">
        <BackButton onClick={() => setSelected(null)} />
        <div className="mt-3 flex flex-col gap-5 sm:flex-row">
          <Cover url={d?.show.artworkUrl ?? null} title={selected.title} size="h-52 w-52 mx-auto sm:mx-0" />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <h1 className="font-display text-3xl font-extrabold leading-tight text-[var(--text)]">
              {d?.show.title ?? selected.title}
            </h1>
            <p className="mt-1 text-lg font-bold text-[var(--dim)]">
              {d?.show.host ?? ""}
            </p>
            <p className="mt-2 text-sm text-[var(--dim)]">
              {d?.show.genre ? `${d.show.genre} · ` : ""}
              {d ? `${d.episodes.length} episodes` : "Loading episodes…"}
            </p>
            <p className="mt-2 text-sm text-[var(--dim)]">
              Tap an episode to play it in the player. It picks up right
              where you left off.
            </p>
          </div>
        </div>
        <SectionTitle>Episodes</SectionTitle>
        {episodesQ.isPending && (
          <p className="mt-2 text-sm text-[var(--dim)]">Loading the episodes…</p>
        )}
        {episodesQ.error && (
          <div className="mt-2">
            <p className="text-sm text-[var(--dim)]">Those episodes didn't load.</p>
            <button
              type="button"
              onClick={() => void episodesQ.refetch()}
              className="btn btn-primary mt-3"
            >
              Try again
            </button>
          </div>
        )}
        {d && d.episodes.length === 0 && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            This show doesn't list any episodes in the catalog right now.
          </p>
        )}
        <div className="mt-1 divide-y divide-[var(--border)]">
          {(d?.episodes ?? []).map((e, i) => {
            const key = `podcast-${e.episodeId}`;
            const isCurrent = player.current?.key === key;
            const leftOff = !isCurrent ? spokenSaved(key) : 0;
            return (
              <div key={e.episodeId} className="py-3">
                <button
                  type="button"
                  aria-label={
                    isCurrent
                      ? player.playing
                        ? `Pause episode ${e.title}`
                        : `Resume episode ${e.title}`
                      : `Play episode ${e.title} from ${d?.show.title ?? selected.title}`
                  }
                  onClick={() => {
                    if (isCurrent) player.toggle();
                    else playWithResume(tracks, i);
                  }}
                  className="flex w-full items-start gap-3 text-left"
                >
                  <span
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                      isCurrent
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--surface2)] text-[var(--text)]"
                    }`}
                  >
                    {isCurrent && player.playing ? (
                      <IconPause className="h-4 w-4" />
                    ) : (
                      <IconPlay className="ml-0.5 h-4 w-4" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block text-sm font-semibold ${
                        isCurrent ? "text-[var(--accent)]" : "text-[var(--text)]"
                      }`}
                    >
                      {e.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-[var(--dim)]">
                      {[e.dateLabel, e.durationMs > 0 ? fmtDur(e.durationMs) : null]
                        .filter(Boolean)
                        .join(" · ")}
                      {leftOff > 10 ? ` · Left off at ${fmtDur(leftOff * 1000)}` : ""}
                      {isCurrent
                        ? player.playing
                          ? " · Playing now"
                          : " · Paused"
                        : ""}
                    </span>
                    {e.description && (
                      <span className="mt-1 line-clamp-2 block text-sm leading-relaxed text-[var(--dim)]">
                        {e.description}
                      </span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const searching = debounced.length >= 1;
  const chartShows: ChartShow[] = charts.data?.shows ?? [];
  const hits: PodcastHit[] = search.data?.shows ?? [];
  return (
    <div>
      <h1 className="mt-4 font-display text-2xl font-extrabold text-[var(--text)]">
        Podcasts
      </h1>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Shows and episodes that play right here in the app — its own
        section, away from your music.
      </p>
      <div className="mt-3">
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            aria-label="Search podcasts by show name or topic"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search podcasts — a show name or a topic…"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--text)]"
          />
          <VoiceSearchButton
            onInterim={(text) => setInput(text)}
            onResult={(text) => setInput(text)}
          />
        </div>
        <p className="mt-1 text-xs text-[var(--dim)]">
          Results update as you type — or tap Voice and say the show or
          topic out loud.
        </p>
      </div>
      {searching ? (
        <>
          <SectionTitle>{`Results for "${debounced}"`}</SectionTitle>
          {search.isPending && (
            <p className="mt-2 text-sm text-[var(--dim)]">Searching podcasts…</p>
          )}
          {search.data && hits.length === 0 && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              No podcasts matched “{debounced}” — try another name or topic.
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {hits.map((s) => (
              <button
                key={s.collectionId}
                type="button"
                onClick={() => setSelected({ collectionId: s.collectionId, title: s.title })}
                aria-label={`Open podcast ${s.title} by ${s.host}`}
                className="text-left"
              >
                <Cover url={s.artworkUrl} title={s.title} size="aspect-square w-full" />
                <span className="mt-2 block truncate text-sm font-semibold text-[var(--text)]">
                  {s.title}
                </span>
                <span className="block truncate text-xs text-[var(--dim)]">
                  {s.host}
                  {s.episodeCount ? ` · ${s.episodeCount} episodes` : ""}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <SectionTitle>Trending podcasts</SectionTitle>
          {charts.isPending && (
            <p className="mt-2 text-sm text-[var(--dim)]">Loading the charts…</p>
          )}
          {charts.error && (
            <div className="mt-2">
              <p className="text-sm text-[var(--dim)]">
                The podcast charts didn't load — search above still works.
              </p>
              <button
                type="button"
                onClick={() => void charts.refetch()}
                className="btn btn-primary mt-3"
              >
                Try again
              </button>
            </div>
          )}
          <div className="mt-3 space-y-1">
            {chartShows.map((s) => (
              <button
                key={s.collectionId}
                type="button"
                onClick={() => setSelected({ collectionId: s.collectionId, title: s.title })}
                aria-label={`Open podcast ${s.title} by ${s.host}`}
                className="flex w-full items-center gap-3 rounded-[var(--radius)] px-2 py-2 text-left hover:bg-[var(--surface2)]"
              >
                <Cover url={s.artworkUrl} title={s.title} size="h-14 w-14 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--text)]">
                    {s.title}
                  </span>
                  <span className="block truncate text-xs text-[var(--dim)]">
                    {s.host}
                    {s.genre ? ` · ${s.genre}` : ""}
                  </span>
                  {s.latestEpisodeTitle && (
                    <span className="block truncate text-xs text-[var(--dim)]">
                      Latest: {s.latestEpisodeTitle}
                      {s.latestEpisodeDate ? ` · ${s.latestEpisodeDate}` : ""}
                    </span>
                  )}
                </span>
                <IconArrowRight className="h-4 w-4 shrink-0 text-[var(--dim)]" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- audiobooks ----------

type BookHit = ApiResponse<typeof api, "searchAudiobooks">["books"][number];
type UploadedBook = ApiResponse<typeof api, "listUploadedBooks">["books"][number];

const BOOKMARK_PREFIX = "audiobook-bookmark:";
function readBookmark(key: string): number {
  try {
    const v = Number(window.localStorage.getItem(BOOKMARK_PREFIX + key));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

type BookSelection =
  | { kind: "librivox"; book: BookHit }
  | { kind: "itunes"; book: BookHit }
  | { kind: "uploaded"; book: UploadedBook }
  | null;

function AudiobooksPage() {
  const player = usePlayer();
  const queryClient = useQueryClient();
  const { playWithResume } = useSpokenResume();
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(input.trim()), 250);
    return () => clearTimeout(t);
  }, [input]);
  const [selected, setSelected] = useState<BookSelection>(null);
  const [, setBookmarkTick] = useState(0);
  // Upload-your-own-book state.
  const [upTitle, setUpTitle] = useState("");
  const [upAuthor, setUpAuthor] = useState("");
  const [upMsg, setUpMsg] = useState<string | null>(null);
  const [upBusy, setUpBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const home = useQuery({
    queryKey: ["audiobookHome"],
    queryFn: () => api.audiobookHome({}),
    enabled: !selected && debounced.length === 0,
  });
  const search = useQuery({
    queryKey: ["audiobookSearch", debounced],
    queryFn: () => api.searchAudiobooks({ query: debounced }),
    enabled: !selected && debounced.length >= 1,
  });
  const uploaded = useQuery({
    queryKey: ["uploadedBooks"],
    queryFn: () => api.listUploadedBooks({}),
  });
  const lvProjectId = selected?.kind === "librivox" ? selected.book.id : "";
  const chaptersQ = useQuery({
    queryKey: ["librivoxChapters", lvProjectId],
    queryFn: () => api.getLibrivoxChapters({ projectId: lvProjectId }),
    enabled: selected?.kind === "librivox",
  });

  async function uploadFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!upTitle.trim() || !upAuthor.trim()) {
      setUpMsg("Type the book's title and author first, then pick the chapter files.");
      return;
    }
    setUpBusy(true);
    try {
      const { bookId } = await api.createUploadedBook({
        title: upTitle.trim(),
        author: upAuthor.trim(),
      });
      const list = Array.from(files);
      for (let i = 0; i < list.length; i++) {
        const f = list[i]!;
        if (f.size > 48 * 1024 * 1024) {
          setUpMsg(`“${f.name}” is over the 48 MB chapter limit and was skipped.`);
          continue;
        }
        setUpMsg(`Uploading chapter ${i + 1} of ${list.length}…`);
        const dataBase64 = await fileToBase64(f);
        await api.uploadBookChapter({
          bookId,
          title: f.name.replace(/\.[a-z0-9]+$/i, "").replace(/[_]+/g, " ").trim() || `Chapter ${i + 1}`,
          chapterNumber: i + 1,
          fileName: f.name,
          dataBase64,
          mimeType: f.type || "audio/mpeg",
        });
      }
      setUpMsg("Your audiobook is in — it's under Your audiobooks below ✓");
      setUpTitle("");
      setUpAuthor("");
      void queryClient.invalidateQueries({ queryKey: ["uploadedBooks"] });
    } catch (e) {
      setUpMsg(e instanceof Error ? e.message : "That upload didn't work — try again.");
    } finally {
      setUpBusy(false);
    }
  }

  async function removeUploadedBook(bookId: number) {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    await api.removeUploadedBook({ bookId });
    setConfirmRemove(false);
    setSelected(null);
    void queryClient.invalidateQueries({ queryKey: ["uploadedBooks"] });
  }

  // One chapter row: play/pause, where-he-left-off, and (for
  // audiobooks) a bookmark he can set at the spot he's listening to
  // and jump back to.
  const chapterRow = (t: PlayTrack, i: number, tracks: PlayTrack[]) => {
    const isCurrent = player.current?.key === t.key;
    const leftOff = !isCurrent ? spokenSaved(t.key) : 0;
    const bookmark = readBookmark(t.key);
    return (
      <div key={t.key} className="py-3">
        <button
          type="button"
          aria-label={
            isCurrent
              ? player.playing
                ? `Pause ${t.title}`
                : `Resume ${t.title}`
              : `Play ${t.title}`
          }
          onClick={() => {
            if (isCurrent) player.toggle();
            else playWithResume(tracks, i);
          }}
          className="flex w-full items-start gap-3 text-left"
        >
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
              isCurrent
                ? "bg-[var(--accent)] text-white"
                : "bg-[var(--surface2)] text-[var(--text)]"
            }`}
          >
            {isCurrent && player.playing ? (
              <IconPause className="h-4 w-4" />
            ) : (
              <IconPlay className="ml-0.5 h-4 w-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={`block text-sm font-semibold ${
                isCurrent ? "text-[var(--accent)]" : "text-[var(--text)]"
              }`}
            >
              {t.title}
            </span>
            <span className="mt-0.5 block text-xs text-[var(--dim)]">
              {t.durationMs > 0 ? fmtDur(t.durationMs) : "Length not listed"}
              {leftOff > 10 ? ` · Left off at ${fmtDur(leftOff * 1000)}` : ""}
              {bookmark > 0 ? ` · Bookmark at ${fmtDur(bookmark * 1000)}` : ""}
              {isCurrent ? (player.playing ? " · Playing now" : " · Paused") : ""}
            </span>
          </span>
        </button>
        {(isCurrent || bookmark > 0) && (
          <div className="ml-[52px] mt-1.5 flex flex-wrap gap-2">
            {isCurrent && (
              <button
                type="button"
                aria-label={`Bookmark where you are in ${t.title}`}
                onClick={() => {
                  try {
                    window.localStorage.setItem(
                      BOOKMARK_PREFIX + t.key,
                      String(Math.floor(player.currentTime)),
                    );
                  } catch {
                    // Storage unavailable — bookmark just doesn't stick.
                  }
                  setBookmarkTick((v) => v + 1);
                }}
                className="btn btn-secondary btn-xs"
              >
                Bookmark where I am ({fmtDur(player.currentTime * 1000)})
              </button>
            )}
            {bookmark > 0 && (
              <button
                type="button"
                aria-label={`Jump to your bookmark at ${fmtDur(bookmark * 1000)} in ${t.title}`}
                onClick={() => playWithResume(tracks, i, bookmark)}
                className="btn btn-secondary btn-xs"
              >
                Jump to bookmark ({fmtDur(bookmark * 1000)})
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  if (selected?.kind === "librivox") {
    const b = selected.book;
    const tracks: PlayTrack[] = (chaptersQ.data?.chapters ?? []).map((c) => ({
      key: `audiobook-lv-${c.chapterId}`,
      title: c.title,
      artist: b.author,
      artworkUrl: null,
      previewUrl: c.audioUrl,
      durationMs: c.durationMs,
      albumTitle: b.title,
    }));
    return (
      <div className="pt-4">
        <BackButton onClick={() => setSelected(null)} />
        <h1 className="mt-3 font-display text-3xl font-extrabold leading-tight text-[var(--text)]">
          {b.title}
        </h1>
        <p className="mt-1 text-lg font-bold text-[var(--dim)]">{b.author}</p>
        <p className="mt-2 text-sm text-[var(--dim)]">
          Free public-domain audiobook from LibriVox
          {b.durationMs > 0 ? ` · ${fmtDur(b.durationMs)} total` : ""}
          {b.chapterCount ? ` · ${b.chapterCount} chapters` : ""}
        </p>
        {b.description && (
          <p className="mt-2 line-clamp-4 text-sm leading-relaxed text-[var(--dim)]">
            {b.description}
          </p>
        )}
        <SectionTitle>Chapters</SectionTitle>
        {chaptersQ.isPending && (
          <p className="mt-2 text-sm text-[var(--dim)]">Loading the chapters…</p>
        )}
        {chaptersQ.error && (
          <div className="mt-2">
            <p className="text-sm text-[var(--dim)]">Those chapters didn't load.</p>
            <button
              type="button"
              onClick={() => void chaptersQ.refetch()}
              className="btn btn-primary mt-3"
            >
              Try again
            </button>
          </div>
        )}
        <div className="mt-1 divide-y divide-[var(--border)]">
          {tracks.map((t, i) => chapterRow(t, i, tracks))}
        </div>
      </div>
    );
  }

  if (selected?.kind === "itunes") {
    const b = selected.book;
    const track: PlayTrack = {
      key: `audiobook-it-${b.id}`,
      title: `${b.title} (preview)`,
      artist: b.author,
      artworkUrl: b.artworkUrl,
      previewUrl: b.previewUrl,
      durationMs: b.durationMs,
      albumTitle: b.title,
    };
    return (
      <div className="pt-4">
        <BackButton onClick={() => setSelected(null)} />
        <div className="mt-3 flex flex-col gap-5 sm:flex-row">
          <Cover url={b.artworkUrl} title={b.title} size="h-52 w-52 mx-auto sm:mx-0" />
          <div className="min-w-0 flex-1 text-center sm:text-left">
            <h1 className="font-display text-3xl font-extrabold leading-tight text-[var(--text)]">
              {b.title}
            </h1>
            <p className="mt-1 text-lg font-bold text-[var(--dim)]">{b.author}</p>
            <p className="mt-2 text-sm text-[var(--dim)]">
              From the audiobook catalog. This is a commercial book, so
              only its official preview plays here — the free LibriVox
              books and your own uploads play in full, chapter by chapter.
            </p>
          </div>
        </div>
        <SectionTitle>Listen</SectionTitle>
        {b.previewUrl ? (
          <div className="mt-1 divide-y divide-[var(--border)]">
            {chapterRow(track, 0, [track])}
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--dim)]">
            The catalog doesn't offer a preview for this book.
          </p>
        )}
      </div>
    );
  }

  if (selected?.kind === "uploaded") {
    const b = selected.book;
    const tracks: PlayTrack[] = b.chapters.map((c) => ({
      key: `audiobook-up-${c.id}`,
      title: c.title,
      artist: b.author,
      artworkUrl: null,
      previewUrl: null,
      durationMs: c.durationMs,
      albumTitle: b.title,
      bookChapterId: c.id,
    }));
    return (
      <div className="pt-4">
        <BackButton onClick={() => setSelected(null)} />
        <h1 className="mt-3 font-display text-3xl font-extrabold leading-tight text-[var(--text)]">
          {b.title}
        </h1>
        <p className="mt-1 text-lg font-bold text-[var(--dim)]">{b.author}</p>
        <p className="mt-2 text-sm text-[var(--dim)]">
          Your uploaded audiobook · {b.chapters.length}{" "}
          {b.chapters.length === 1 ? "chapter" : "chapters"} · plays in full
        </p>
        <SectionTitle>Chapters</SectionTitle>
        {tracks.length === 0 && (
          <p className="mt-2 text-sm text-[var(--dim)]">
            No chapter files in this book yet.
          </p>
        )}
        <div className="mt-1 divide-y divide-[var(--border)]">
          {tracks.map((t, i) => chapterRow(t, i, tracks))}
        </div>
        <button
          type="button"
          onClick={() => void removeUploadedBook(b.id)}
          aria-label={
            confirmRemove
              ? `Tap again to remove ${b.title} and its chapter files for good`
              : `Remove ${b.title} from your audiobooks`
          }
          className="btn btn-danger-ghost mt-4"
        >
          {confirmRemove ? "Tap again to remove this book" : "Remove this book"}
        </button>
      </div>
    );
  }

  const searching = debounced.length >= 1;
  const hits: BookHit[] = search.data?.books ?? [];
  const homeBooks: BookHit[] = (home.data?.books ?? []).map((b) => ({
    ...b,
    source: "librivox" as const,
  }));
  const bookCard = (b: BookHit) => (
    <button
      key={`${b.source}-${b.id}`}
      type="button"
      onClick={() =>
        setSelected(
          b.source === "librivox"
            ? { kind: "librivox", book: b }
            : { kind: "itunes", book: b },
        )
      }
      aria-label={`Open audiobook ${b.title} by ${b.author}`}
      className="text-left"
    >
      <Cover url={b.artworkUrl} title={b.title} size="aspect-square w-full" />
      <span className="mt-2 block truncate text-sm font-semibold text-[var(--text)]">
        {b.title}
      </span>
      <span className="block truncate text-xs text-[var(--dim)]">{b.author}</span>
      <span className="block truncate text-xs text-[var(--dim)]">
        {b.source === "librivox"
          ? `Free · LibriVox${b.chapterCount ? ` · ${b.chapterCount} chapters` : ""}${b.durationMs > 0 ? ` · ${fmtDur(b.durationMs)}` : ""}`
          : "Catalog · preview plays"}
      </span>
    </button>
  );
  return (
    <div>
      <h1 className="mt-4 font-display text-2xl font-extrabold text-[var(--text)]">
        Audiobooks
      </h1>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Books that play right here in the app — its own section, away
        from your music and podcasts. Chapters pick up where you left
        off, and you can set a bookmark.
      </p>
      <div className="mt-3">
        <div className="flex flex-wrap gap-2">
          <input
            type="search"
            aria-label="Search audiobooks by title or author"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search audiobooks — a title or an author…"
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--text)]"
          />
          <VoiceSearchButton
            onInterim={(text) => setInput(text)}
            onResult={(text) => setInput(text)}
          />
        </div>
        <p className="mt-1 text-xs text-[var(--dim)]">
          Searches free LibriVox books (they play in full) and the
          audiobook catalog (previews). Results update as you type — or
          tap Voice and say the title or author out loud.
        </p>
      </div>

      <SectionTitle>Your audiobooks</SectionTitle>
      {(uploaded.data?.books ?? []).length === 0 ? (
        <p className="mt-2 text-sm text-[var(--dim)]">
          None uploaded yet — add one below and it plays in full, like
          your uploaded music.
        </p>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {(uploaded.data?.books ?? []).map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelected({ kind: "uploaded", book: b })}
              aria-label={`Open your audiobook ${b.title} by ${b.author}`}
              className="text-left"
            >
              <Cover url={null} title={b.title} size="aspect-square w-full" />
              <span className="mt-2 block truncate text-sm font-semibold text-[var(--text)]">
                {b.title}
              </span>
              <span className="block truncate text-xs text-[var(--dim)]">
                {b.author} · {b.chapters.length}{" "}
                {b.chapters.length === 1 ? "chapter" : "chapters"} · your upload
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-4 rounded-[var(--radius)] bg-[var(--surface)] p-4">
        <h3 className="font-display text-base font-bold text-[var(--text)]">
          Upload your own audiobook
        </h3>
        <p className="mt-1 text-sm text-[var(--dim)]">
          Type the title and author, then pick the chapter files (one
          file per chapter, in order). They play in full inside the app.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-bold text-[var(--text)]" htmlFor="book-title-up">
              Book title
            </label>
            <input
              id="book-title-up"
              value={upTitle}
              onChange={(e) => setUpTitle(e.target.value)}
              className="mt-1.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-[var(--text)]" htmlFor="book-author-up">
              Author
            </label>
            <input
              id="book-author-up"
              value={upAuthor}
              onChange={(e) => setUpAuthor(e.target.value)}
              className="mt-1.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)]"
            />
          </div>
        </div>
        <label htmlFor="book-chapters-up" className="btn btn-primary mt-3">
          {upBusy ? "Uploading…" : "Pick chapter files"}
        </label>
        <input
          id="book-chapters-up"
          aria-label="Pick the chapter files for your audiobook"
          type="file"
          accept="audio/*"
          multiple
          disabled={upBusy}
          onChange={(e) => {
            void uploadFiles(e.target.files);
            e.target.value = "";
          }}
          className="sr-only"
        />
        {upMsg && (
          <p className="mt-2 text-sm font-semibold text-[var(--text)]">{upMsg}</p>
        )}
      </div>

      {searching ? (
        <>
          <SectionTitle>{`Results for "${debounced}"`}</SectionTitle>
          {search.isPending && (
            <p className="mt-2 text-sm text-[var(--dim)]">Searching audiobooks…</p>
          )}
          {search.data && hits.length === 0 && (
            <p className="mt-2 text-sm text-[var(--dim)]">
              No audiobooks matched “{debounced}” — try another title or author.
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {hits.map(bookCard)}
          </div>
        </>
      ) : (
        <>
          <SectionTitle>Free audiobooks from LibriVox</SectionTitle>
          <p className="mt-1 text-sm text-[var(--dim)]">
            Public-domain classics, read by volunteers — every one plays
            in full, free.
          </p>
          {home.isPending && (
            <p className="mt-2 text-sm text-[var(--dim)]">Loading free audiobooks…</p>
          )}
          {home.error && (
            <div className="mt-2">
              <p className="text-sm text-[var(--dim)]">
                The free audiobooks didn't load — search above still works.
              </p>
              <button
                type="button"
                onClick={() => void home.refetch()}
                className="btn btn-primary mt-3"
              >
                Try again
              </button>
            </div>
          )}
          <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {homeBooks.map(bookCard)}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- ask Tiana ----------

// Tiana talks back out loud: the phone's own built-in speech
// (speechSynthesis) reads her replies — no recording, no server, no
// extra download. The pick prefers a natural female English voice
// when the phone offers one and falls back to the phone's default
// voice otherwise. Automatic speeches (the send confirmation, an
// "Updated" note on open) only happen while the voice switch is on;
// a tap on a request's speaker button always speaks, because the
// tap itself is the user asking to hear it. The switch choice is
// remembered on this device.
const TIANA_VOICE_KEY = "sm-life-tiana-voice";

function tianaVoiceOn(): boolean {
  try {
    return window.localStorage.getItem(TIANA_VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

function pickTianaVoice(): SpeechSynthesisVoice | null {
  try {
    const voices = window.speechSynthesis?.getVoices() ?? [];
    if (voices.length === 0) return null;
    // Names phones commonly give their natural female voices.
    const femaleName =
      /(female|samantha|zira|aria|jenny|ava|allison|susan|karen|moira|tessa|fiona|victoria|veena|catherine|joanna|salli|kimberly|amy|emma|nicole)/i;
    const english = voices.filter((v) => /^en([-_]|$)/i.test(v.lang));
    const pool = english.length > 0 ? english : voices;
    return (
      pool.find((v) => femaleName.test(v.name)) ??
      pool.find((v) => v.lang === "en-US") ??
      pool[0] ??
      null
    );
  } catch {
    return null;
  }
}

// Music ducking: while Tiana speaks, the music drops way down
// under her voice, then comes back up to exactly where it was when
// she finishes — the song never stops and never loses its place;
// only its volume moves. Every surface that can be playing music
// (the audio decks, the YouTube stage) registers a duck handler;
// speakTiana ducks them all for the length of the reply. A handler
// must be idempotent: ducking while already ducked keeps the
// originally saved volume, and unducking restores it.
type DuckHandler = (ducked: boolean) => void;
const duckHandlers = new Set<DuckHandler>();

function registerDuckHandler(handler: DuckHandler): () => void {
  duckHandlers.add(handler);
  return () => {
    duckHandlers.delete(handler);
    // A player that goes away mid-reply never leaves music ducked.
    try {
      handler(false);
    } catch {
      // Nothing to restore on a dead player.
    }
  };
}

function setMusicDucked(ducked: boolean): void {
  for (const handler of duckHandlers) {
    try {
      handler(ducked);
    } catch {
      // One bad player can't break the speech or the other players.
    }
  }
}

// Sequence guard: when a new reply cuts an old one off, the old
// utterance's end event must not lift the duck early — only the
// latest reply's end brings the music back up.
let speechSeq = 0;

function speakTiana(text: string, force = false): void {
  let duckedHere = false;
  try {
    const synth = window.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
    if (!force && !tianaVoiceOn()) return;
    const clean = text.trim();
    if (!clean) return;
    const seq = ++speechSeq;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(clean);
    const voice = pickTianaVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = "en-US";
    }
    utterance.rate = 1;
    utterance.pitch = 1.05;
    const release = () => {
      if (seq === speechSeq) setMusicDucked(false);
    };
    utterance.onend = release;
    utterance.onerror = release;
    setMusicDucked(true);
    duckedHere = true;
    synth.speak(utterance);
  } catch {
    // Speech isn't available in this view — the words stay on
    // screen, and the music goes back up if this call ducked it.
    if (duckedHere) setMusicDucked(false);
  }
}

// What Tiana says for one request: a finished one announces
// "Update is completed" first, then its "Updated" note; one still
// waiting speaks its saved status.
function requestSpeechText(r: {
  status: "pending" | "done";
  resolutionNote: string | null;
}): string {
  if (r.status === "done") {
    return r.resolutionNote
      ? `Update is completed. ${r.resolutionNote}`
      : "Update is completed. Tiana built your change.";
  }
  return "Got it, I saved that for Tiana. It's saved, and waiting for Tiana to build it.";
}

// The Ask Tiana box on THIS copy (Render rebuild): it does NOT send
// requests anywhere. This copy has no bridge back to Muse, so nothing
// typed here would ever reach Tiana — the send form is replaced with
// a plain note saying so, and the box only shows the requests that
// were already saved and finished in the original app, as read-only
// history with their "Updated" notes. Send new app changes in Muse,
// where SM Life Streaming lives.
function AskTianaModal({ onClose }: { onClose: () => void }) {
  // His requests and their status, shown right here in the box (the
  // same list Library → Settings shows): pending ones are still
  // waiting to be built; done ones carry Tiana's "Updated" note.
  const requestsQ = useQuery({
    queryKey: ["appRequests"],
    queryFn: () => api.listAppRequests({}),
  });
  const myRequests = requestsQ.data?.requests ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ask Tiana to change the app"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
    >
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-[var(--surface)] p-5 sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-display text-xl font-extrabold text-[var(--text)]">
            Ask Tiana
          </h2>
          <button
            type="button"
            aria-label="Close Ask Tiana"
            onClick={onClose}
            className="icon-btn"
          >
            <IconX className="h-5 w-5" />
          </button>
        </div>
        <p className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm leading-relaxed text-[var(--text)]">
          This copy of the app isn&apos;t connected to Tiana, so a
          change sent from here wouldn&apos;t reach her. To ask for a
          change, send it in Muse, where SM Life Streaming lives.
          Below are the requests already saved there, with what was
          done for each one.
        </p>
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <h3 className="text-sm font-bold text-[var(--text)]">
            Your requests
          </h3>
          {requestsQ.isPending ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-[var(--dim)]">
              <span
                aria-hidden="true"
                className="h-4 w-4 animate-spin rounded-full border-2"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--accent) 25%, transparent)",
                  borderTopColor: "var(--accent)",
                }}
              />
              Loading your requests…
            </p>
          ) : myRequests.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--dim)]">
              No requests saved on this copy yet.
            </p>
          ) : (
            <ul className="mt-2 space-y-2">
              {myRequests.map((r) => (
                <li
                  key={r.id}
                  className="flex items-start gap-2 rounded-[var(--radius)] border border-[var(--border)] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[var(--text)]">{r.text}</p>
                    <p className="mt-0.5 text-xs font-semibold text-[var(--dim)]">
                      {r.status === "done"
                        ? `Update is completed ✓${r.resolutionNote ? ` — ${r.resolutionNote}` : ""}`
                        : "Saved — waiting for Tiana to build it"}
                      {" · "}
                      {new Date(r.createdAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Hear Tiana's reply to: ${r.text}`}
                    onClick={() => speakTiana(requestSpeechText(r), true)}
                    className="icon-btn shrink-0 border border-[var(--border)] !p-2"
                  >
                    <IconSpeaker className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- shell ----------

// ---------- Opening brand moment ----------
// When the app opens, the name sweeps across the screen once over
// the app itself, with a short opening sound — the Tubi-style
// opening the user asked for. It is NOT a separate splash page or
// screen: the app underneath is already live, the overlay never
// takes a tap (pointer-events-none), and it removes itself after
// about two seconds. The sound is a short original chime
// synthesized live with WebAudio — no audio file, and not any
// other app's sound. A browser view that won't play sound before
// the first tap simply stays silent for that open; the sweep
// still plays.
function playOpeningChime() {
  try {
    const AC =
      window.AudioContext ??
      (
        window as unknown as {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0.14;
    master.connect(ctx.destination);
    // A quick rising three-note motif landing on a soft high note.
    const notes: [number, number, number][] = [
      [523.25, 0, 0.32], // C5
      [659.25, 0.11, 0.32], // E5
      [783.99, 0.22, 0.46], // G5
      [1046.5, 0.33, 0.6], // C6
    ];
    for (const [freq, at, dur] of notes) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const g = ctx.createGain();
      const t0 = ctx.currentTime + at;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(1, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }
    window.setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 1600);
  } catch {
    // No sound this open — the sweep still plays.
  }
}

function OpeningBrand() {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    playOpeningChime();
    const t = window.setTimeout(() => setGone(true), 2150);
    return () => window.clearTimeout(t);
  }, []);
  if (gone) return null;
  return (
    <div
      aria-hidden="true"
      className="opening-brand pointer-events-none fixed inset-0 z-[70] flex items-center justify-center bg-[var(--player-bg)]"
    >
      <p className="opening-brand-name font-display whitespace-nowrap text-3xl font-extrabold tracking-tight text-[var(--player-text)] sm:text-5xl">
        SM Life <span className="text-[var(--accent)]">Streaming</span>
      </p>
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<
    "home" | "search" | "library" | "podcasts" | "audiobooks"
  >("home");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const player = usePlayer();
  const queryClientShell = useQueryClient();
  // Plan tier: this install starts on Developer (the owner's own
  // account — no ads). Ads render only while the tier is Free.
  const planQuery = useQuery({
    queryKey: ["plan"],
    queryFn: () => api.getPlan({}),
  });
  const planTier: PlanTier = planQuery.data?.tier ?? "developer";
  const showAds = planQuery.data?.adsEnabled ?? false;
  const setPlanMut = useMutation({
    mutationFn: (tier: PlanTier) => api.setPlan({ tier }),
    onSuccess: () =>
      void queryClientShell.invalidateQueries({ queryKey: ["plan"] }),
  });
  const goPremium = () => setPlanMut.mutate("premium");
  // Theme: the inline script in index.html already stamped the saved
  // choice (or the system preference on first open) on <html>, so the
  // app opens in the right theme; this state mirrors it for the toggle.
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" &&
    document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light",
  );
  const applyTheme = (t: "light" | "dark") => {
    setTheme(t);
    document.documentElement.dataset.theme = t;
    try {
      window.localStorage.setItem("sm-life-theme", t);
    } catch {
      // Storage unavailable — the theme still holds for this session.
    }
  };
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [video, setVideo] = useState<CatalogVideo | null>(null);
  const [ytVideo, setYtVideo] = useState<YouTubeVideo | null>(null);
  // True while the YouTube stage is playing a catalog song's FULL
  // song (a song tap routed there) rather than a video — the stage
  // labels itself "Full song" in that mode.
  const [ytSongMode, setYtSongMode] = useState(false);
  // The song the YouTube stage's Video / Song versions belong to,
  // when the open came from a catalog song or video (title / artist
  // / length): the stage's toggle searches YouTube with these to
  // load the OTHER version for real. Null for a plain YouTube-result
  // open — the toggle then works from the video's own title/channel.
  const [ytVersionBase, setYtVersionBase] = useState<{
    title: string;
    artist: string;
    durationMs: number;
  } | null>(null);
  // Video / Song flips that cross between the two players: when the
  // audio full player's Video pick opens a song's music video,
  // ytStartAt is the song's second the video picks up at (no
  // starting over) and ytReturnTrack is that song, whose own file
  // waits paused in the audio decks — the stage's Song pick hands
  // playback back to it at the video's second. Both stay null for
  // ordinary video/song opens, where a flip is just the stage's own
  // view change. trackVideoLoad is the on-player "finding the full
  // video" stage shown while that pick resolves.
  const [ytStartAt, setYtStartAt] = useState<number | null>(null);
  const [ytReturnTrack, setYtReturnTrack] = useState<PlayTrack | null>(null);
  const [trackVideoLoad, setTrackVideoLoad] = useState<{
    track: PlayTrack;
    status: "loading" | "failed";
  } | null>(null);
  // A catalog song tap goes straight to the full song: the player
  // hands the track to playFullSong (registered below), which
  // resolves the song's full-length YouTube match first — this state
  // is the on-player "finding it / couldn't find it" stage shown
  // while that runs. The 30-second preview is never a step on the
  // way; it remains only as an explicit fallback pick on the
  // "failed" stage.
  const [songLoad, setSongLoad] = useState<{
    track: PlayTrack;
    status: "loading" | "failed";
  } | null>(null);
  // Bumped by explicit closes/picks (never by the start-count effect)
  // so a resolution the user has already moved away from is dropped.
  const songSessionRef = useRef(0);
  // Mirror of the player's current track for async resolutions: a
  // found full song opens only while its track is still current.
  const currentTrackRef = useRef<PlayTrack | null>(null);
  useEffect(() => {
    currentTrackRef.current = player.current;
  }, [player.current]);
  // A catalog video tap goes straight to the full video: the tap
  // first resolves the video's full-length YouTube match (this state
  // is the on-player "loading / couldn't find it" stage shown while
  // that runs), and only the found full video opens the stage. The
  // catalog's short preview is never a step on the way — it remains
  // only as an explicit fallback pick on the "failed" stage.
  const [videoLoad, setVideoLoad] = useState<{
    video: CatalogVideo;
    status: "loading" | "failed";
  } | null>(null);
  const videoReqRef = useRef(0);
  const [showHum, setShowHum] = useState(false);
  const [showTiana, setShowTiana] = useState(false);
  // Ask Tiana requests: finished ones that haven't been dismissed yet
  // show as an "Updated" note on open.
  const appRequestsQ = useQuery({
    queryKey: ["appRequests"],
    queryFn: () => api.listAppRequests({}),
  });
  const unseenUpdates = (appRequestsQ.data?.requests ?? []).filter(
    (r) => r.status === "done" && !r.seenDone,
  );
  const seenMut = useMutation({
    mutationFn: (requestId: number) => api.markAppRequestSeen({ requestId }),
    onSuccess: () =>
      void queryClientShell.invalidateQueries({ queryKey: ["appRequests"] }),
  });
  // Speak each finished request's "Updated" note out loud once per
  // app open (while Tiana's voice switch is on), so he hears the
  // reply without having to read the banner. The speaker button on
  // the banner replays it any time.
  const spokenUpdatesRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    for (const r of unseenUpdates) {
      if (!spokenUpdatesRef.current.has(r.id)) {
        spokenUpdatesRef.current.add(r.id);
        speakTiana(requestSpeechText(r));
      }
    }
  }, [unseenUpdates]);
  // Ducking for the audio decks: while Tiana speaks, drop the
  // music to a low level under her voice; when she finishes, put
  // the user's volume back exactly where it was. Playback itself
  // is never touched — the song keeps its place.
  const playerVolumeRef = useRef(1);
  playerVolumeRef.current = player.volume;
  const setVolumeRef = useRef(player.setVolume);
  setVolumeRef.current = player.setVolume;
  useEffect(() => {
    let saved: number | null = null;
    return registerDuckHandler((ducked) => {
      if (ducked) {
        if (saved === null && playerVolumeRef.current > 0.15) {
          saved = playerVolumeRef.current;
          setVolumeRef.current(0.15);
        }
      } else if (saved !== null) {
        setVolumeRef.current(saved);
        saved = null;
      }
    });
  }, []);
  const [playerOpen, setPlayerOpen] = useState(false);
  // Slide-up: every time a NEW song starts, the player bar replays its
  // slide-up-from-the-bottom animation. The class is re-triggered by
  // removing it, forcing a reflow, and re-adding it.
  const dockAnimRef = useRef<HTMLDivElement | null>(null);
  const prevTrackKeyRef = useRef<string | null>(null);
  const currentKey = player.current
    ? `${player.current.key}:${player.index}`
    : null;
  useEffect(() => {
    if (currentKey && prevTrackKeyRef.current !== currentKey) {
      prevTrackKeyRef.current = currentKey;
      const el = dockAnimRef.current;
      if (el) {
        el.classList.remove("player-slide-anim");
        void el.offsetWidth;
        el.classList.add("player-slide-anim");
      }
    }
    if (!currentKey) prevTrackKeyRef.current = null;
  }, [currentKey]);
  // Full-screen Now Playing: when a song is deliberately started (a
  // tap on a song, a Play button, an assistant-started play), the
  // player goes big and takes the whole screen, Apple Music style,
  // instead of staying down in the small bar. The user tucks it back
  // to the mini bar with the handle whenever they want. A song that
  // rolls over on its own (crossfade / track end) never pops it back
  // open — only a fresh deliberate start (startCount) does.
  const prevStartCountRef = useRef(0);
  useEffect(() => {
    if (player.startCount > prevStartCountRef.current) {
      prevStartCountRef.current = player.startCount;
      videoReqRef.current += 1;
      setVideo(null);
      setYtVideo(null);
      setVideoLoad(null);
      setTrackVideoLoad(null);
      setYtReturnTrack(null);
      setYtStartAt(null);
      // A full-song resolution already running for THIS track (the
      // player handed it over during this very start) keeps its
      // loading stage; a stale one for any other track is dropped.
      const cur = player.current;
      // The version base playFullSong just set for this track (the
      // stage's Video / Song toggle searches with it) belongs to
      // this same start — clearing it here would leave the toggle
      // guessing from the video's title instead. Only a start that
      // isn't a full-song route clears it.
      if (!(cur?.fullSong && cur?.previewUrl)) setYtVersionBase(null);
      setSongLoad((s) => (s && cur && s.track.key === cur.key ? s : null));
      // A catalog song that routes to its full song on the YouTube
      // stage doesn't pop the full-screen audio player open — the
      // stage IS its player. Uploaded files (no preview URL on the
      // track) and everything else open the full player as before.
      if (!(cur?.fullSong && cur?.previewUrl)) setPlayerOpen(true);
    }
  }, [player.startCount]);
  const [assistantMsg, setAssistantMsg] = useState<string | null>(null);
  const library = useQuery({
    queryKey: ["library"],
    queryFn: () => api.listLibrary({}),
    enabled: overlay?.type === "saved",
  });

  const goTab = (
    t: "home" | "search" | "library" | "podcasts" | "audiobooks",
  ) => {
    setOverlay(null);
    setTab(t);
  };
  // Upload lives in the Library tab's ImportPanel; the header and
  // bottom-nav Upload buttons land the user right on it. The counter
  // re-triggers the scroll even when already on the Library tab.
  const [uploadJump, setUploadJump] = useState(0);
  const goUpload = () => {
    setOverlay(null);
    setTab("library");
    setUploadJump((n) => n + 1);
  };
  const openAlbum = (catalogId: string) => setOverlay({ type: "album", catalogId });
  const openArtist = (name: string, artistId: string | null) =>
    setOverlay({ type: "artist", name, artistId });
  // Videos play in the app's own player. A YouTube video opens its
  // full video directly; a catalog music video resolves its
  // full-length YouTube match first and opens that — full video,
  // inside the app's music player, no preview step in between. Opening one kind closes
  // the others, and a stale resolution (the user has moved on to a
  // song or another video) is ignored via the request counter.
  // A catalog song plays its FULL song in the app's own YouTube
  // player: the player hands the tapped track here (see the
  // fullSong routing in player.tsx), the song's full-length YouTube
  // match is resolved first via the same searchYouTube the videos
  // use, and the IFrame-API stage opens with it, labeled Full song.
  // The best match is a result whose own duration (the label
  // YouTube reports) lands close to the catalog track's real
  // length. When no result lands close — a skit or intro YouTube
  // posts at a different length, a title the plain search misses —
  // the resolution tries an "official audio" search, then falls
  // back to the best song-length result for the song, because an
  // album that stops dead plays nothing at all; only a search with
  // nothing plausible at all lands on the failed stage. The
  // catalog's 30-second preview never plays on this path. On
  // failure the stage offers a retry, with the short preview as an
  // explicit fallback pick.
  const playFullSong = useCallback(
    (track: PlayTrack) => {
      setPlayerOpen(false);
      setVideo(null);
      setVideoLoad(null);
      setTrackVideoLoad(null);
      setYtReturnTrack(null);
      setYtStartAt(null);
      setYtVideo(null);
      setYtSongMode(false);
      setYtVersionBase({
        title: track.title,
        artist: track.artist,
        durationMs: track.durationMs,
      });
      const session = (songSessionRef.current += 1);
      setSongLoad({ track, status: "loading" });
      void (async () => {
        try {
          let res = await api.searchYouTube({
            query: `${track.artist} ${track.title}`,
          });
          if (songSessionRef.current !== session) return;
          if (currentTrackRef.current?.key !== track.key) return;
          if (res.videos.length === 0) {
            // Nothing under the plain title — try once more the way
            // the song itself is usually posted ("official audio").
            res = await api.searchYouTube({
              query: `${track.artist} ${track.title} official audio`,
            });
            if (songSessionRef.current !== session) return;
            if (currentTrackRef.current?.key !== track.key) return;
          }
          let first = res.videos[0];
          if (track.durationMs > 0) {
            const target = track.durationMs / 1000;
            const secsOf = (v: YouTubeVideo) =>
              v.durationSecs || ytDurationSecs(v.durationLabel) || 0;
            // Best pick: a result whose own length lands close to
            // the track's real length — that is the full song, not a
            // clip or a teaser.
            const close = res.videos.find((v) => {
              const secs = secsOf(v);
              return (
                secs > 0 &&
                Math.abs(secs - target) <= Math.max(20, target * 0.15)
              );
            });
            if (close) {
              first = close;
            } else {
              // No close match — an album still has to PLAY. Take
              // the best song-length result for this song (a real
              // full-length video: at least a minute, and not an
              // hours-long compilation or a different long video)
              // instead of failing the whole album dead. Only a
              // search with nothing plausible at all lands on the
              // failed stage.
              const plausible = res.videos.find((v) => {
                const secs = secsOf(v);
                return (
                  secs >= 60 &&
                  secs <= Math.max(target * 1.8, target + 300)
                );
              });
              if (plausible) first = plausible;
            }
          }
          if (first) {
            setSongLoad(null);
            setYtSongMode(true);
            setYtVideo(first);
          } else {
            setSongLoad({ track, status: "failed" });
          }
        } catch {
          if (songSessionRef.current !== session) return;
          if (currentTrackRef.current?.key !== track.key) return;
          setSongLoad({ track, status: "failed" });
        }
      })();
    },
    [],
  );
  // The player routes catalog tracks with no file of their own to
  // the full-song handler above.
  const setFullSongHandler = player.setFullSongHandler;
  useEffect(() => {
    setFullSongHandler(playFullSong);
    return () => setFullSongHandler(null);
  }, [setFullSongHandler, playFullSong]);
  // Tapping the mini bar for a song that's playing its full song on
  // the YouTube stage reopens that stage; anything else opens the
  // full-screen audio player as before.
  const expandPlayer = () => {
    const cur = player.current;
    if (cur?.fullSong && cur?.previewUrl) {
      playFullSong(cur);
    } else {
      setPlayerOpen(true);
    }
  };
  const playVideo = (v: CatalogVideo) => {
    songSessionRef.current += 1;
    setSongLoad(null);
    setTrackVideoLoad(null);
    setYtReturnTrack(null);
    setYtStartAt(null);
    setYtSongMode(false);
    setYtVersionBase({ title: v.title, artist: v.artist, durationMs: 0 });
    setPlayerOpen(false);
    setVideo(null);
    setYtVideo(null);
    const req = (videoReqRef.current += 1);
    setVideoLoad({ video: v, status: "loading" });
    void (async () => {
      try {
        const res = await api.searchYouTube({
          query: `${v.artist} ${v.title}`,
        });
        if (videoReqRef.current !== req) return;
        const first = res.videos[0];
        if (first) {
          setVideoLoad(null);
          setYtVideo(first);
        } else {
          setVideoLoad({ video: v, status: "failed" });
        }
      } catch {
        if (videoReqRef.current !== req) return;
        setVideoLoad({ video: v, status: "failed" });
      }
    })();
  };
  const playYouTube = (v: YouTubeVideo) => {
    songSessionRef.current += 1;
    setSongLoad(null);
    setTrackVideoLoad(null);
    setYtReturnTrack(null);
    setYtStartAt(null);
    setYtSongMode(false);
    setYtVersionBase(null);
    videoReqRef.current += 1;
    setPlayerOpen(false);
    setVideo(null);
    setVideoLoad(null);
    setYtVideo(v);
  };
  // The audio full player's Video pick: find the song's full music
  // video (the same YouTube lookup the catalog videos use) and open
  // it on the stage, starting at the second the song was on — the
  // song's own file stays paused in the audio decks, and the
  // stage's Song pick hands playback back to it at the video's
  // second, so flipping either way never starts over. While the
  // video is being found, the on-player loading stage says so; if
  // none is found it says that honestly, with a retry.
  const showVideoForTrack = (track: PlayTrack, positionSeconds: number) => {
    songSessionRef.current += 1;
    setSongLoad(null);
    setYtSongMode(false);
    setYtVersionBase({
      title: track.title,
      artist: track.artist,
      durationMs: track.durationMs,
    });
    setPlayerOpen(false);
    setVideo(null);
    setVideoLoad(null);
    setYtVideo(null);
    setYtReturnTrack(null);
    setYtStartAt(null);
    player.pause();
    const req = (videoReqRef.current += 1);
    setTrackVideoLoad({ track, status: "loading" });
    void (async () => {
      try {
        const res = await api.searchYouTube({
          query: `${track.artist} ${track.title}`,
        });
        if (videoReqRef.current !== req) return;
        const first = res.videos[0];
        if (first) {
          setTrackVideoLoad(null);
          setYtReturnTrack(track);
          setYtStartAt(positionSeconds > 5 ? positionSeconds : null);
          setYtVideo(first);
        } else {
          setTrackVideoLoad({ track, status: "failed" });
        }
      } catch {
        if (videoReqRef.current !== req) return;
        setTrackVideoLoad({ track, status: "failed" });
      }
    })();
  };
  // The stage's Song pick for a video that was flipped to from a
  // library song's own file: close the stage, reopen the audio full
  // player, and resume that file at the video's second. The deck
  // still holds the file (it was only paused), so the seek lands
  // immediately and play continues from there.
  const returnToSong = (track: PlayTrack, seconds: number) => {
    setYtVideo(null);
    setYtReturnTrack(null);
    setYtStartAt(null);
    setPlayerOpen(true);
    // The decks only hold the file if this track is still the
    // player's current one — otherwise just reopen the player.
    if (player.current?.key !== track.key) return;
    if (seconds > 3) player.seek(seconds);
    if (!player.playing) player.toggle();
  };

  const savedAlbum =
    overlay?.type === "saved"
      ? library.data?.albums.find((a) => a.id === overlay.albumId)
      : undefined;

  // What the header Cast button would hand over right now: the playing
  // song's actual stream URL from the active deck.
  const castSrc = player.getCurrentSrc();
  const headerCastMedia: CastMedia | null =
    player.current && castSrc
      ? {
          url: castSrc,
          title: player.current.title,
          subtitle: player.current.artist,
          artworkUrl: player.current.artworkUrl,
        }
      : null;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <OpeningBrand />
      <header className="sticky top-0 z-40 border-b border-[var(--border)] bg-[var(--bg)]/95 pt-safe backdrop-blur">
        <div className="relative mx-auto max-w-5xl px-4 pb-3 pt-3">
          <form
            role="search"
            aria-label="Search music and videos"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setSuggestOpen(false);
              setQuery(input.trim());
              setOverlay(null);
              setTab("search");
            }}
            className="flex flex-wrap gap-2"
          >
            <input
              type="search"
              aria-label="Search songs, albums, artists, videos, and YouTube"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSuggestOpen(true);
              }}
              onFocus={() => setSuggestOpen(true)}
              onBlur={() => {
                // Delay so a tap/click on a suggestion row lands first.
                setTimeout(() => setSuggestOpen(false), 200);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSuggestOpen(false);
              }}
              placeholder="Search songs, albums, artists, videos, YouTube…"
              className="w-full min-w-0 flex-none rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-2.5 text-sm text-[var(--text)] sm:w-auto sm:flex-1"
            />
            <button
              type="submit"
              className="btn btn-dark shrink-0"
            >
              Search
            </button>
            <VoiceSearchButton
              onInterim={(text) => {
                setInput(text);
                setSuggestOpen(false);
              }}
              onResult={(text) => {
                setInput(text);
                setSuggestOpen(false);
                setQuery(text);
                setOverlay(null);
                setTab("search");
              }}
            />
            <button
              type="button"
              aria-label="Upload your music — go to the upload panel"
              onClick={goUpload}
              className="btn btn-primary shrink-0"
            >
              <IconUpload className="h-4 w-4" />
              Upload
            </button>
            <button
              type="button"
              aria-label="Ask Tiana to change the app"
              onClick={() => setShowTiana(true)}
              className="btn btn-secondary shrink-0"
            >
              <IconSparkles className="h-4 w-4" />
              Ask Tiana
            </button>
            <button
              type="button"
              aria-label={
                theme === "dark"
                  ? "Switch to light theme"
                  : "Switch to dark theme"
              }
              aria-pressed={theme === "dark"}
              onClick={() => applyTheme(theme === "dark" ? "light" : "dark")}
              className="btn btn-secondary shrink-0"
            >
              {theme === "dark" ? (
                <>
                  <IconSun className="h-4 w-4" />
                  Light
                </>
              ) : (
                <>
                  <IconMoon className="h-4 w-4" />
                  Dark
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => goTab("library")}
              aria-label={`Your plan is ${PLAN_LABEL[planTier]} — ${showAds ? "with ads" : "no ads"}. Open plan settings in your Library`}
              className="btn btn-secondary shrink-0"
            >
              {PLAN_LABEL[planTier]} · {showAds ? "With ads" : "No ads"}
            </button>
            <span className="shrink-0">
              <CastButton media={headerCastMedia} withLabel={false} />
            </span>
          </form>
          <SearchSuggestions
            input={input}
            open={suggestOpen}
            onClose={() => setSuggestOpen(false)}
            onPickArtist={openArtist}
            onPickAlbum={openAlbum}
            onPickSaved={(albumId) =>
              setOverlay({ type: "saved", albumId })
            }
            onPickSong={(track) => player.playQueue([track], 0)}
            onPickVideo={playVideo}
            onSeeAll={() => {
              setQuery(input.trim());
              setOverlay(null);
              setTab("search");
            }}
          />
        </div>
      </header>

      {unseenUpdates.length > 0 && (
        <div className="mx-auto max-w-5xl px-4 pt-3">
          {unseenUpdates.map((r) => (
            <div
              key={r.id}
              className="mb-2 flex items-center gap-2 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-2.5"
            >
              <IconSparkles className="h-5 w-5 shrink-0 text-[var(--accent)]" />
              <p className="min-w-0 flex-1 text-sm font-semibold text-[var(--text)]">
                Update is completed —{" "}
                {r.resolutionNote ?? "Tiana built your change."}
              </p>
              <button
                type="button"
                aria-label={`Hear the update note about: ${r.text}`}
                onClick={() => speakTiana(requestSpeechText(r), true)}
                className="icon-btn shrink-0 border border-[var(--border)] !p-1.5"
              >
                <IconSpeaker className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={`Dismiss the update note about: ${r.text}`}
                onClick={() => seenMut.mutate(r.id)}
                className="btn btn-secondary btn-xs shrink-0"
              >
                Got it
              </button>
            </div>
          ))}
        </div>
      )}

      <AssistantPlaybackBridge
        onStarted={(label) => setAssistantMsg(label)}
      />
      {assistantMsg && (
        <div className="mx-auto max-w-5xl px-4 pt-3">
          <div className="flex items-center gap-2 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-2.5">
            <IconHeadphones className="h-5 w-5 shrink-0 text-[var(--accent)]" />
            <p className="min-w-0 flex-1 text-sm font-semibold text-[var(--text)]">
              Started for you from chat: {assistantMsg} — playing in the
              app's player below. If it didn't start on its own, tap the play
              button in the player.
            </p>
            <button
              type="button"
              aria-label="Dismiss the assistant playback notice"
              onClick={() => setAssistantMsg(null)}
              className="icon-btn shrink-0 border border-[var(--border)] !p-1.5"
            >
              <IconX className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <main
        className={`mx-auto max-w-5xl px-4 ${
          video || ytVideo
            ? "pb-[42rem]"
            : videoLoad || songLoad || trackVideoLoad
              ? "pb-80"
              : showAds && player.current
                ? "pb-48"
                : "pb-36"
        }`}
      >
        {overlay?.type === "album" && (
          <>
            <BackButton onClick={() => setOverlay(null)} />
            <AlbumPage
              catalogId={overlay.catalogId}
              openArtist={openArtist}
              goLibrary={() => goTab("library")}
              openAlbum={openAlbum}
              openVideo={playVideo}
            />
          </>
        )}
        {overlay?.type === "artist" && (
          <>
            <BackButton onClick={() => setOverlay(null)} />
            <ArtistPage
              name={overlay.name}
              artistId={overlay.artistId}
              openAlbum={openAlbum}
              openVideo={playVideo}
              openSaved={(albumId) => setOverlay({ type: "saved", albumId })}
            />
          </>
        )}
        {overlay?.type === "saved" && (
          <>
            <BackButton onClick={() => setOverlay(null)} />
            {savedAlbum ? (
              <SavedAlbumPage album={savedAlbum} openArtist={openArtist} openVideo={playVideo} />
            ) : (
              <p className="py-16 text-center text-sm text-[var(--dim)]">
                That album isn't in your library anymore.
              </p>
            )}
          </>
        )}
        {!overlay && tab === "home" && (
          <HomePage
            openAlbum={openAlbum}
            openArtist={openArtist}
            openVideo={playVideo}
            showAds={showAds}
            onUpgrade={goPremium}
          />
        )}
        {!overlay && tab === "search" && (
          <SearchPage
            query={query}
            openAlbum={openAlbum}
            openArtist={openArtist}
            openVideo={playVideo}
            openYouTube={playYouTube}
            openHum={() => setShowHum(true)}
            onVoiceSearch={(text) => {
              setInput(text);
              setSuggestOpen(false);
              setQuery(text);
              setOverlay(null);
              setTab("search");
            }}
            openSaved={(albumId) => setOverlay({ type: "saved", albumId })}
            showAds={showAds}
            onUpgrade={goPremium}
          />
        )}
        {!overlay && tab === "library" && (
          <LibraryPage
            openSaved={(albumId) => setOverlay({ type: "saved", albumId })}
            openCatalogAlbum={openAlbum}
            openArtist={openArtist}
            theme={theme}
            applyTheme={applyTheme}
            uploadJump={uploadJump}
            planTier={planTier}
            onSetPlan={(tier) => setPlanMut.mutate(tier)}
            planPending={setPlanMut.isPending}
            showAds={showAds}
            onUpgrade={goPremium}
            onAskTiana={() => setShowTiana(true)}
          />
        )}
        {!overlay && tab === "podcasts" && <PodcastsPage />}
        {!overlay && tab === "audiobooks" && <AudiobooksPage />}
      </main>

      <button
        type="button"
        aria-label="Ask Tiana to change the app"
        onClick={() => setShowTiana(true)}
        className="btn btn-primary fixed bottom-44 right-3 z-40 shadow-lg"
      >
        <IconSparkles className="h-4 w-4" />
        Ask Tiana
      </button>

      <div className="fixed inset-x-0 bottom-0 z-40">
        {songLoad && (
          <SongLoadDock
            track={songLoad.track}
            status={songLoad.status}
            onClose={() => {
              songSessionRef.current += 1;
              setSongLoad(null);
            }}
            onRetry={() => playFullSong(songLoad.track)}
            onPreview={() => {
              const track = songLoad.track;
              songSessionRef.current += 1;
              setSongLoad(null);
              player.playQueue([{ ...track, fullSong: false }], 0);
            }}
          />
        )}
        {videoLoad && (
          <VideoLoadDock
            video={videoLoad.video}
            status={videoLoad.status}
            onClose={() => {
              videoReqRef.current += 1;
              setVideoLoad(null);
            }}
            onRetry={() => playVideo(videoLoad.video)}
            onPreview={() => {
              setVideoLoad(null);
              setVideo(videoLoad.video);
            }}
          />
        )}
        {trackVideoLoad && (
          <VideoLoadDock
            video={{
              title: trackVideoLoad.track.title,
              artist: trackVideoLoad.track.artist,
              previewUrl: trackVideoLoad.track.previewUrl,
            }}
            status={trackVideoLoad.status}
            onClose={() => {
              videoReqRef.current += 1;
              setTrackVideoLoad(null);
            }}
            onRetry={() =>
              showVideoForTrack(trackVideoLoad.track, player.currentTime)
            }
            onPreview={() => {
              const track = trackVideoLoad.track;
              setTrackVideoLoad(null);
              player.playQueue([{ ...track, fullSong: false }], 0);
            }}
          />
        )}
        {video && (
          <VideoDock video={video} onClose={() => setVideo(null)} />
        )}
        {ytVideo && (
          <YouTubeDock
            video={ytVideo}
            kind={ytSongMode ? "song" : "video"}
            startAtSeconds={ytStartAt}
            returnTrack={ytReturnTrack}
            onReturnToSong={returnToSong}
            versionTitle={ytVersionBase?.title ?? null}
            versionArtist={ytVersionBase?.artist ?? null}
            versionDurationMs={ytVersionBase?.durationMs ?? 0}
            onClose={() => {
              setYtVideo(null);
              setYtReturnTrack(null);
              setYtStartAt(null);
              setYtVersionBase(null);
            }}
          />
        )}
        {showAds && player.current && (
          <PlayerAdStrip onUpgrade={goPremium} />
        )}
        <div ref={dockAnimRef}>
          <PlayerBar onExpand={expandPlayer} />
        </div>
        <nav
          aria-label="Main"
          className="flex border-t border-[var(--border)] bg-[var(--surface)] pb-safe"
        >
          {(
            [
              ["home", "Home", IconHome],
              ["search", "Search", IconSearch],
              ["library", "Library", IconLibrary],
              ["podcasts", "Podcasts", IconMic],
              ["audiobooks", "Audiobooks", IconHeadphones],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              aria-current={!overlay && tab === key ? "page" : undefined}
              onClick={() => goTab(key)}
              className={`flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-semibold ${
                !overlay && tab === key ? "text-[var(--accent)]" : "text-[var(--dim)]"
              }`}
            >
              <Icon className="h-6 w-6" />
              {label}
            </button>
          ))}
          <button
            type="button"
            aria-label="Upload your music — go to the upload panel"
            onClick={goUpload}
            className="flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-semibold text-[var(--dim)]"
          >
            <IconUpload className="h-6 w-6" />
            Upload
          </button>
        </nav>
      </div>

      {playerOpen && player.current && (
        <FullPlayer
          onClose={() => setPlayerOpen(false)}
          showAds={showAds}
          onUpgrade={goPremium}
          onShowVideo={showVideoForTrack}
        />
      )}
      {showHum && <HumModal onClose={() => setShowHum(false)} />}
      {showTiana && <AskTianaModal onClose={() => setShowTiana(false)} />}
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Go back"
      className="btn btn-secondary btn-sm mt-3"
    >
      <IconArrowLeft className="h-4 w-4" />
      Back
    </button>
  );
}

export function App() {
  return (
    <PlayerProvider>
      <Shell />
    </PlayerProvider>
  );
}
