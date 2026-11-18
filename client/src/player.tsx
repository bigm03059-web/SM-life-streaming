import {
createContext,
useCallback,
useContext,
useEffect,
useRef,
useState,
type ReactNode,
} from "react";
import { api } from "./api";

export type PlayTrack = {
  key: string;
  title: string;
  artist: string;
  artworkUrl: string | null;
  previewUrl: string | null;
  fallbackPreviewUrl?: string | null;
  explicitness?: "explicit" | "clean" | "none" | null;
  durationMs: number;
  savedTrackId?: number | null;
  playlistItemId?: number | null;
  /** The uploaded file's original name (saved library tracks only) —
   *  used as the filename when the user downloads their own file to
   *  their device. Catalog tracks never carry one. */
  fileName?: string | null;
  /** An uploaded audiobook chapter (Audiobooks tab): its full file is
   *  resolved through getBookChapterPlayback, like savedTrackId does
   *  for uploaded music. */
  bookChapterId?: number | null;
  albumTitle?: string;
  /** A music-catalog track (from catalogToPlay / savedToPlay). When
   *  the track has no uploaded file of its own, it must play the FULL
   *  song through the app's YouTube stage — the shell registers the
   *  handler for that — never just the catalog's 30-second preview.
   *  Tracks with their own uploaded file ignore this and play the
   *  file in full, exactly as before. */
  fullSong?: boolean;
};

type PlayerState = {
  queue: PlayTrack[];
  index: number;
  current: PlayTrack | null;
  playing: boolean;
  loading: boolean;
  playbackError: string | null;
  currentTime: number;
  duration: number;
  crossfadeOn: boolean;
  crossfadeSecs: number;
  slowed: boolean;
  spatial: boolean;
  /** Playback volume, 0 to 1 — the full player's Volume slider. */
  volume: number;
  setVolume: (v: number) => void;
  /** Spoken-word playback speed (podcasts / audiobooks): 1 is normal.
   *  SLOWED still wins while it's on — it forces its own 0.72 rate. */
  speechRate: number;
  setSpeechRate: (v: number) => void;
  playQueue: (tracks: PlayTrack[], start: number) => void;
  /** Bumps every time a song is deliberately started through playQueue
   *  (a tap on a song, a Play button, an assistant-started play) — the
   *  shell watches it to pop the full-screen player open, Apple Music
   *  style. Auto-advance and next/prev do NOT bump it, so a song that
   *  rolls over on its own never yanks the screen back open. */
  startCount: number;
  toggle: () => void;
  pause: () => void;
  retry: () => void;
  next: () => void;
  prev: () => void;
  seek: (t: number) => void;
  setCrossfadeOn: (v: boolean) => void;
  setCrossfadeSecs: (v: number) => void;
  setSlowed: (v: boolean) => void;
  setSpatial: (v: boolean) => void;
  /** The active deck's current stream URL — what casting hands over. */
  getCurrentSrc: () => string | null;
  /** Registers the shell's full-song handler: when a catalog track
   *  with no uploaded file of its own is started, the player hands
   *  the track to this handler (which plays the full song in the
   *  app's YouTube stage) instead of loading the 30-second preview. */
  setFullSongHandler: (
    fn: ((track: PlayTrack) => void) | null,
  ) => void;
};

const PlayerCtx = createContext<PlayerState | null>(null);

const SLOWED_STORAGE_KEY = "music-player:slowed";

// The SLOWED toggle is a standing preference, not a per-track effect: it
// stays on across track changes, queue changes, and app reloads until the
// user switches it off. Persisted in localStorage so a reload of the app
// (the shell can drop and recreate the webview) doesn't silently reset it.
function readStoredSlowed(): boolean {
  try {
    return window.localStorage.getItem(SLOWED_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

const SPATIAL_STORAGE_KEY = "music-player:spatial-audio";

// SPATIAL AUDIO is a standing preference too — same localStorage pattern
// as SLOWED, restored on the next open, and it stays on across tracks
// until the user switches it off.
function readStoredSpatial(): boolean {
  try {
    return window.localStorage.getItem(SPATIAL_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

// Spatial Audio (Apple Music style): a clear, widened sound built with
// Web Audio — stereo widening plus a clarity EQ.
//  - Widening: each deck's output is split into channels and each side
//    gets the opposite channel subtracted (L' = L − k·R, R' = R − k·L),
//    which pushes the stereo image wider on headphones and speakers.
//  - Clarity: a presence peak (~3.2 kHz) and a gentle high shelf
//    (~6.5 kHz) lift detail and vocals when the effect is on.
//
// Two hard rules keep the toggle from ever stopping the music (the
// earlier broken effect toggle broke the first one, and pressing it
// silenced playback):
//  1. A deck is connected into the graph ONLY after the AudioContext
//     is confirmed running. Routing a playing element into a suspended
//     context leaves it "playing" into silence — its only output path
//     produces nothing. If the context won't run, the graph stays
//     unconnected and playback keeps the plain element output.
//  2. Once the graph exists, toggling changes node values only
//     (smooth ramps on the cross gains and EQ gains). No nodes are
//     created or disconnected and the elements are never touched, so
//     flipping the switch mid-song cannot pause, restart, or re-route
//     anything — the song plays straight through, just wider/clearer
//     or back to normal.
// Both preview hosts (Apple/Deezer CDNs) send CORS headers, so routing
// them through an AudioContext does not mute them; uploaded files play
// from same-origin blob URLs, which are equally safe.
const SPATIAL_WIDEN = 0.45;
const SPATIAL_PRESENCE_DB = 2.0;
const SPATIAL_SHELF_DB = 3.5;
type DeckGraph = {
  crossL: GainNode;
  crossR: GainNode;
  presence: BiquadFilterNode;
  shelf: BiquadFilterNode;
};

export function usePlayer(): PlayerState {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer outside provider");
  return ctx;
}

// The track's own uploaded full file, when it has one: a saved
// track's file, a playlist item's file, or an audiobook chapter's
// file, resolved through its playback action. Null when the track
// carries no file of its own (a pure catalog track, or a catalog
// album saved to the library — those rows have a savedTrackId but
// no file behind it).
async function resolveFileUrl(track: PlayTrack): Promise<string | null> {
  try {
    if (track.savedTrackId) {
      const r = await api.getTrackPlayback({ trackId: track.savedTrackId });
      if (r.url) return r.url;
    }
    if (track.playlistItemId) {
      const r = await api.getPlaylistItemPlayback({
        itemId: track.playlistItemId,
      });
      if (r.url) return r.url;
    }
    if (track.bookChapterId) {
      const r = await api.getBookChapterPlayback({
        chapterId: track.bookChapterId,
      });
      if (r.url) return r.url;
    }
  } catch {
    // No file resolved — the caller falls back to the previews.
  }
  return null;
}

// Ordered playable sources for a track: the user's own uploaded full file
// first, then the catalog's official preview, then the second catalog's
// preview of the same song — so one dead link never kills playback.
async function resolveUrls(track: PlayTrack): Promise<string[]> {
  const urls: string[] = [];
  const fileUrl = await resolveFileUrl(track);
  if (fileUrl) urls.push(fileUrl);
  if (track.previewUrl) urls.push(track.previewUrl);
  if (
    track.fallbackPreviewUrl &&
    track.fallbackPreviewUrl !== track.previewUrl
  ) {
    urls.push(track.fallbackPreviewUrl);
  }
  return [...new Set(urls)];
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const decksRef = useRef<HTMLAudioElement[]>([]);
  const activeRef = useRef(0);
  const fadingRef = useRef(false);
  const fadeTimerRef = useRef<number | null>(null);
  const initialSlowedRef = useRef<boolean | null>(null);
  if (initialSlowedRef.current === null) {
    initialSlowedRef.current = readStoredSlowed();
  }
  const initialSpatialRef = useRef<boolean | null>(null);
  if (initialSpatialRef.current === null) {
    initialSpatialRef.current = readStoredSpatial();
  }
  const audioCtxRef = useRef<AudioContext | null>(null);
  const deckGraphsRef = useRef<(DeckGraph | null)[]>([null, null]);
  const graphBuildingRef = useRef<Promise<boolean> | null>(null);
  // The shell's full-song handler (see setFullSongHandler): catalog
  // tracks with no file of their own are handed to it so the FULL
  // song plays in the app's YouTube stage, not the 30-second preview.
  const fullSongHandlerRef = useRef<((track: PlayTrack) => void) | null>(
    null,
  );
  const setFullSongHandler = useCallback(
    (fn: ((track: PlayTrack) => void) | null) => {
      fullSongHandlerRef.current = fn;
    },
    [],
  );
  const stateRef = useRef({
    crossfadeOn: true,
    crossfadeSecs: 5,
    slowed: initialSlowedRef.current,
    speechRate: 1,
    spatial: initialSpatialRef.current,
  });

  const [queue, setQueue] = useState<PlayTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [startCount, setStartCount] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [crossfadeOn, setCrossfadeOnState] = useState(true);
  const [crossfadeSecs, setCrossfadeSecsState] = useState(5);
  const [slowed, setSlowedState] = useState(initialSlowedRef.current);
  const [spatial, setSpatialState] = useState(initialSpatialRef.current);
  const [volume, setVolumeState] = useState(1);
  const [speechRate, setSpeechRateState] = useState(1);

  const queueRef = useRef<PlayTrack[]>([]);
  const indexRef = useRef(0);
  const volumeRef = useRef(1);
  queueRef.current = queue;
  indexRef.current = index;
  volumeRef.current = volume;
  stateRef.current = { crossfadeOn, crossfadeSecs, slowed, spatial, speechRate };

  // Build the spatial graph — once per deck, and only once the
  // AudioContext is confirmed RUNNING (rule 1 above). Resolves true
  // when at least one deck is wired in. Concurrent calls share one
  // build, and a failed build leaves playback on the plain path.
  const buildSpatialGraph = useCallback((): Promise<boolean> => {
    if (
      deckGraphsRef.current.length > 0 &&
      deckGraphsRef.current.every((g) => g !== null)
    ) {
      return Promise.resolve(true);
    }
    if (graphBuildingRef.current) return graphBuildingRef.current;
    const job = (async (): Promise<boolean> => {
      try {
        let ctx = audioCtxRef.current;
        if (!ctx) {
          const AC =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          if (!AC) return false;
          ctx = new AC();
          audioCtxRef.current = ctx;
        }
        await ctx.resume().catch(() => undefined);
        if (ctx.state !== "running") return false;
        const on = stateRef.current.spatial;
        const k = on ? SPATIAL_WIDEN : 0;
        decksRef.current.forEach((el, i) => {
          if (!el || !ctx || deckGraphsRef.current[i]) return;
          const source = ctx.createMediaElementSource(el);
          const splitter = ctx.createChannelSplitter(2);
          const merger = ctx.createChannelMerger(2);
          const directL = ctx.createGain();
          directL.gain.value = 1;
          const directR = ctx.createGain();
          directR.gain.value = 1;
          const crossL = ctx.createGain();
          crossL.gain.value = -k;
          const crossR = ctx.createGain();
          crossR.gain.value = -k;
          const presence = ctx.createBiquadFilter();
          presence.type = "peaking";
          presence.frequency.value = 3200;
          presence.Q.value = 0.9;
          presence.gain.value = on ? SPATIAL_PRESENCE_DB : 0;
          const shelf = ctx.createBiquadFilter();
          shelf.type = "highshelf";
          shelf.frequency.value = 6500;
          shelf.gain.value = on ? SPATIAL_SHELF_DB : 0;
          const out = ctx.createGain();
          out.gain.value = 1.05;
          source.connect(splitter);
          splitter.connect(directL, 0);
          directL.connect(merger, 0, 0);
          splitter.connect(crossL, 1);
          crossL.connect(merger, 0, 0);
          splitter.connect(crossR, 0);
          crossR.connect(merger, 0, 1);
          splitter.connect(directR, 1);
          directR.connect(merger, 0, 1);
          merger.connect(presence);
          presence.connect(shelf);
          shelf.connect(out);
          out.connect(ctx.destination);
          deckGraphsRef.current[i] = { crossL, crossR, presence, shelf };
        });
        return deckGraphsRef.current.some((g) => g !== null);
      } catch {
        // Web Audio unavailable — playback continues through the plain
        // element output, and the toggle simply has no graph to drive.
        return false;
      } finally {
        graphBuildingRef.current = null;
      }
    })();
    graphBuildingRef.current = job;
    return job;
  }, []);

  // Apply the current on/off amounts to a built graph — gain ramps
  // only (rule 2 above). This is all the Spatial Audio toggle does
  // once the graph exists, so flipping it mid-song can never
  // interrupt the song.
  const applySpatialAmount = useCallback(() => {
    const ctx = audioCtxRef.current;
    const on = stateRef.current.spatial;
    const k = on ? SPATIAL_WIDEN : 0;
    for (const g of deckGraphsRef.current) {
      if (!g) continue;
      const t = ctx ? ctx.currentTime : 0;
      g.crossL.gain.setTargetAtTime(-k, t, 0.03);
      g.crossR.gain.setTargetAtTime(-k, t, 0.03);
      g.presence.gain.setTargetAtTime(on ? SPATIAL_PRESENCE_DB : 0, t, 0.03);
      g.shelf.gain.setTargetAtTime(on ? SPATIAL_SHELF_DB : 0, t, 0.03);
    }
  }, []);

  // Play paths call this when Spatial Audio is wanted: build the graph
  // if it doesn't exist yet (we're inside a user-gesture call stack,
  // so the context can start), otherwise just wake the context and
  // refresh the amounts — never anything that can interrupt playback.
  const kickSpatial = useCallback(() => {
    if (!stateRef.current.spatial) return;
    const ctx = audioCtxRef.current;
    if (ctx && deckGraphsRef.current.some((g) => g !== null)) {
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => undefined);
      }
      applySpatialAmount();
    } else {
      void buildSpatialGraph().then((ok) => {
        if (ok) applySpatialAmount();
      });
    }
  }, [applySpatialAmount, buildSpatialGraph]);

  const current = queue[index] ?? null;

  const applyRate = useCallback((el: HTMLAudioElement) => {
    const slowed = stateRef.current.slowed;
    const rate = slowed ? 0.72 : stateRef.current.speechRate;
    el.playbackRate = rate;
    // defaultPlaybackRate is what a fresh load() starts at in some
    // browsers — setting it too keeps SLOWED from snapping back to full
    // speed when the next track loads.
    el.defaultPlaybackRate = rate;
    // preservesPitch=false is what makes it a DJ slow-down: pitch drops
    // with speed. Every spelling of the property gets set: some
    // engines (Safari / WKWebView, older WebViews) honor only the
    // prefixed one, and with just the standard property set they slow
    // the tempo while pitch-correcting the voice back up — the
    // "slower but not deeper" half-effect. This is the one rate path
    // for everything the decks play, so the 30-second preview clips
    // (the full player's "Play the 30-second preview instead" pick,
    // playlist previews, assistant-started previews) get the exact
    // same pitch-and-tempo drop at 0.72× as full songs and uploads,
    // for as long as the standing SLOWED switch stays on. The deck
    // wiring below also re-pins this on 'playing' and on every
    // 'ratechange', so an engine that resets a deck mid-clip (after
    // a load, seek, or stall) can never leave a preview running at
    // full speed or pitch-corrected back up while the switch is on.
    el.preservesPitch = !slowed;
    const ext = el as HTMLAudioElement & {
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    ext.mozPreservesPitch = !slowed;
    ext.webkitPreservesPitch = !slowed;
  }, []);

  const loadTrack = useCallback(
    async (deckIdx: number, track: PlayTrack, autoplay: boolean) => {
      const el = decksRef.current[deckIdx];
      if (!el) return;
      kickSpatial();
      setPlaybackError(null);
      // Full-song routing: a catalog track with no uploaded file of
      // its own plays the FULL song in the app's YouTube stage (the
      // shell's handler), never just the catalog's 30-second
      // preview. A track whose own file resolves falls through and
      // plays that file in full, exactly as before.
      if (track.fullSong) {
        const fileUrl = await resolveFileUrl(track);
        const handler = fullSongHandlerRef.current;
        if (!fileUrl && handler) {
          setLoading(false);
          setPlaying(false);
          setCurrentTime(0);
          setDuration(0);
          handler(track);
          return;
        }
      }
      const urls = await resolveUrls(track);
      if (urls.length === 0) {
        setPlaying(false);
        setLoading(false);
        setPlaybackError(
          "This track has no playable preview. Full songs play from files you upload in your Library.",
        );
        return;
      }
      setLoading(true);
      for (const url of urls) {
        try {
          el.src = url;
          el.volume = volumeRef.current;
          applyRate(el);
          el.load();
          // load() can reset rate/pitch in some browsers — re-pin after it.
          applyRate(el);
          if (autoplay) {
            await el.play();
            applyRate(el);
            setPlaying(true);
          }
          setLoading(false);
          return;
        } catch {
          // This source didn't start — fall through to the next one.
        }
      }
      setLoading(false);
      setPlaying(false);
      setPlaybackError(
        "That preview couldn't start. Check your connection and tap Retry, or pick another track.",
      );
    },
    [applyRate, kickSpatial],
  );

  const startCrossfade = useCallback(() => {
    const q = queueRef.current;
    const i = indexRef.current;
    const nextTrack = q[i + 1];
    if (!nextTrack || fadingRef.current) return;
    const cur = decksRef.current[activeRef.current];
    const nxt = decksRef.current[1 - activeRef.current];
    if (!cur || !nxt) return;
    kickSpatial();
    fadingRef.current = true;
    const secs = stateRef.current.crossfadeSecs;
    void (async () => {
      // Never crossfade into a catalog track's 30-second preview:
      // a full-song track with no file of its own plays its full
      // song on the YouTube stage instead. Skip the fade — when
      // this deck ends, the ended handler advances into loadTrack,
      // which does the routing.
      if (nextTrack.fullSong && !(await resolveFileUrl(nextTrack))) {
        fadingRef.current = false;
        return;
      }
      const urls = await resolveUrls(nextTrack);
      const url = urls[0];
      if (!url) {
        fadingRef.current = false;
        return;
      }
      nxt.src = url;
      nxt.volume = 0;
      applyRate(nxt);
      try {
        await nxt.play();
        applyRate(nxt);
      } catch {
        fadingRef.current = false;
        return;
      }
      const steps = Math.max(5, secs * 10);
      let step = 0;
      if (fadeTimerRef.current) window.clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = window.setInterval(() => {
        step += 1;
        const p = Math.min(1, step / steps);
        // The fade runs between silent and the user's chosen volume,
        // so a crossfade never blasts past the Volume slider's level.
        const vol = volumeRef.current;
        cur.volume = Math.max(0, (1 - p) * vol);
        nxt.volume = Math.min(1, p * vol);
        if (p >= 1) {
          if (fadeTimerRef.current) window.clearInterval(fadeTimerRef.current);
          cur.pause();
          cur.volume = vol;
          nxt.volume = vol;
          activeRef.current = 1 - activeRef.current;
          fadingRef.current = false;
          const ni = indexRef.current + 1;
          setIndex(ni);
          setCurrentTime(0);
          const t = queueRef.current[ni];
          if (t) {
            void api
              .recordPlay({
                title: t.title,
                artist: t.artist,
                artworkUrl: t.artworkUrl,
              })
              .catch(() => undefined);
          }
        }
      }, 100);
    })();
  }, [applyRate, kickSpatial]);

  // Deck setup + event wiring (once).
  useEffect(() => {
    const a = new Audio();
    const b = new Audio();
    a.preload = "auto";
    b.preload = "auto";
    decksRef.current = [a, b];
    // No spatial graph is built here: there is no user gesture at
    // mount, so an AudioContext created now would sit suspended — and
    // routing the decks into a suspended context is exactly what used
    // to silence playback. The graph is built on the first play or
    // toggle tap instead (kickSpatial / setSpatial).
    const onTime = () => {
      const el = decksRef.current[activeRef.current];
      if (!el) return;
      setCurrentTime(el.currentTime || 0);
      if (Number.isFinite(el.duration) && el.duration > 0) {
        setDuration(el.duration);
        const remain = el.duration - el.currentTime;
        if (
          stateRef.current.crossfadeOn &&
          queueRef.current.length > 1 &&
          indexRef.current < queueRef.current.length - 1 &&
          remain <= stateRef.current.crossfadeSecs &&
          remain > 0 &&
          !el.paused
        ) {
          startCrossfade();
        }
      }
    };
    const onMeta = (e: Event) => {
      // A freshly loaded track can come up at full speed even when SLOWED
      // is on — re-apply the standing rate to whichever deck just loaded.
      const loaded = e.target as HTMLAudioElement | null;
      if (loaded) applyRate(loaded);
      const el = decksRef.current[activeRef.current];
      if (el && Number.isFinite(el.duration)) setDuration(el.duration);
    };
    const onEnded = () => {
      if (fadingRef.current) return;
      const q = queueRef.current;
      const i = indexRef.current;
      if (i < q.length - 1) {
        const ni = i + 1;
        setIndex(ni);
        const t = q[ni];
        if (t) {
          void loadTrack(activeRef.current, t, true);
          void api
            .recordPlay({ title: t.title, artist: t.artist, artworkUrl: t.artworkUrl })
            .catch(() => undefined);
        }
      } else {
        setPlaying(false);
      }
    };
    const onPlay = (e: Event) => {
      // Last line of defense: whatever deck just started playing runs at
      // the standing SLOWED setting, never a leftover full-speed rate.
      const started = e.target as HTMLAudioElement | null;
      if (started) applyRate(started);
      setPlaying(true);
      setLoading(false);
      setPlaybackError(null);
    };
    const onPause = () => {
      const el = decksRef.current[activeRef.current];
      if (el?.paused && !fadingRef.current) setPlaying(false);
    };
    const onWaiting = (e: Event) => {
      if (e.target === decksRef.current[activeRef.current]) setLoading(true);
    };
    const onPlayingEvt = (e: Event) => {
      // Playback is actually flowing now — the last moment an engine
      // can quietly reset a deck to full speed / full pitch (some
      // WebViews only apply their defaults once data starts moving,
      // after the 'play' event already fired). Re-pin the standing
      // rate here too, so a preview clip that started slowed can
      // never be heard pitch-corrected back up.
      const started = e.target as HTMLAudioElement | null;
      if (started) applyRate(started);
      if (e.target === decksRef.current[activeRef.current]) setLoading(false);
    };
    const onRateChange = (e: Event) => {
      // Drift guard for the whole life of a clip: if a deck's rate
      // ever stops matching the standing setting — an engine reset
      // after a load, a seek, a stall, or a stream switch — pin it
      // straight back, pitch drop included. This is what keeps
      // SLOWED on the 30-second preview clips for their entire play,
      // not just the moment they start: the switch stays on, so the
      // rate stays at 0.72× with pitch preservation off until the
      // user switches SLOWED off. Re-applying the rate the deck
      // already has does not refire this event, so the guard cannot
      // loop; when the deck already matches, it does nothing.
      const el = e.target as HTMLAudioElement | null;
      if (!el) return;
      const want = stateRef.current.slowed
        ? 0.72
        : stateRef.current.speechRate;
      if (el.playbackRate !== want) applyRate(el);
    };
    const onError = (e: Event) => {
      const el = e.target as HTMLAudioElement | null;
      if (!el || el !== decksRef.current[activeRef.current]) return;
      if (!el.src || fadingRef.current) return;
      setLoading(false);
      setPlaying(false);
      setPlaybackError(
        "That preview hit a snag. Tap Retry to try again, or pick another track.",
      );
    };
    for (const el of [a, b]) {
      el.addEventListener("timeupdate", onTime);
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("ended", onEnded);
      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
      el.addEventListener("waiting", onWaiting);
      el.addEventListener("playing", onPlayingEvt);
      el.addEventListener("ratechange", onRateChange);
      el.addEventListener("error", onError);
    }
    return () => {
      for (const el of [a, b]) {
        el.removeEventListener("timeupdate", onTime);
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("play", onPlay);
        el.removeEventListener("pause", onPause);
        el.removeEventListener("waiting", onWaiting);
        el.removeEventListener("playing", onPlayingEvt);
        el.removeEventListener("ratechange", onRateChange);
        el.removeEventListener("error", onError);
        el.pause();
      }
    };
  }, [loadTrack, startCrossfade, applyRate]);

  const playQueue = useCallback(
    (tracks: PlayTrack[], start: number) => {
      if (tracks.length === 0) return;
      if (fadeTimerRef.current) window.clearInterval(fadeTimerRef.current);
      fadingRef.current = false;
      for (const el of decksRef.current) {
        el.pause();
        el.volume = volumeRef.current;
      }
      activeRef.current = 0;
      setQueue(tracks);
      setIndex(start);
      setStartCount((n) => n + 1);
      setCurrentTime(0);
      setDuration(0);
      const t = tracks[start];
      if (t) {
        void loadTrack(0, t, true);
        void api
          .recordPlay({ title: t.title, artist: t.artist, artworkUrl: t.artworkUrl })
          .catch(() => undefined);
      }
    },
    [loadTrack],
  );

  const toggle = useCallback(() => {
    const el = decksRef.current[activeRef.current];
    if (!el || !current) return;
    kickSpatial();
    if (el.paused) {
      // Nothing loaded yet (e.g. after an error) — load from the top.
      if (!el.src) {
        void loadTrack(activeRef.current, current, true);
        return;
      }
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  }, [current, loadTrack, kickSpatial]);

  // Pause whatever is playing without toggling — used when a music video
  // opens on the player dock, so the song doesn't keep playing under it.
  const pause = useCallback(() => {
    const el = decksRef.current[activeRef.current];
    if (el && !el.paused) el.pause();
  }, []);

  const retry = useCallback(() => {
    const t = queueRef.current[indexRef.current];
    if (t) void loadTrack(activeRef.current, t, true);
  }, [loadTrack]);

  const jump = useCallback(
    (ni: number) => {
      const q = queueRef.current;
      const t = q[ni];
      if (!t) return;
      if (fadeTimerRef.current) window.clearInterval(fadeTimerRef.current);
      fadingRef.current = false;
      for (const el of decksRef.current) {
        el.pause();
        el.volume = volumeRef.current;
      }
      activeRef.current = 0;
      setIndex(ni);
      setCurrentTime(0);
      void loadTrack(0, t, true);
      void api
        .recordPlay({ title: t.title, artist: t.artist, artworkUrl: t.artworkUrl })
        .catch(() => undefined);
    },
    [loadTrack],
  );

  const next = useCallback(() => {
    if (indexRef.current < queueRef.current.length - 1) {
      jump(indexRef.current + 1);
    }
  }, [jump]);

  const prev = useCallback(() => {
    const el = decksRef.current[activeRef.current];
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      return;
    }
    if (indexRef.current > 0) jump(indexRef.current - 1);
    else if (el) el.currentTime = 0;
  }, [jump]);

  const seek = useCallback((t: number) => {
    const el = decksRef.current[activeRef.current];
    if (el) {
      el.currentTime = t;
      setCurrentTime(t);
    }
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    setVolumeState(clamped);
    volumeRef.current = clamped;
    // Apply right away to the playing deck. A crossfade in flight
    // keeps its own ramp (it reads volumeRef on every step, so it
    // lands on the new level when it finishes).
    if (!fadingRef.current) {
      const el = decksRef.current[activeRef.current];
      if (el) el.volume = clamped;
    }
  }, []);

  const setSpeechRate = useCallback(
    (v: number) => {
      const clamped = Math.min(3, Math.max(0.5, v));
      stateRef.current.speechRate = clamped;
      setSpeechRateState(clamped);
      // Apply to both decks right away; applyRate keeps SLOWED's own
      // rate winning while SLOWED is on.
      for (const el of decksRef.current) {
        if (el) applyRate(el);
      }
    },
    [applyRate],
  );

  const setCrossfadeOn = useCallback((v: boolean) => setCrossfadeOnState(v), []);
  const setCrossfadeSecs = useCallback((v: number) => setCrossfadeSecsState(v), []);
  const setSlowed = useCallback(
    (v: boolean) => {
      setSlowedState(v);
      stateRef.current.slowed = v;
      try {
        window.localStorage.setItem(SLOWED_STORAGE_KEY, v ? "on" : "off");
      } catch {
        // Storage unavailable — the toggle still holds for this session.
      }
      for (const el of decksRef.current) applyRate(el);
    },
    [applyRate],
  );
  const setSpatial = useCallback(
    (v: boolean) => {
      setSpatialState(v);
      stateRef.current.spatial = v;
      try {
        window.localStorage.setItem(SPATIAL_STORAGE_KEY, v ? "on" : "off");
      } catch {
        // Storage unavailable — the toggle still holds for this session.
      }
      if (deckGraphsRef.current.some((g) => g !== null)) {
        // The graph is already wired into the playing audio: flip the
        // widening and clarity amounts with smooth ramps and nothing
        // else. The song keeps playing straight through, just wider
        // and clearer or back to normal — it is never paused,
        // restarted, or re-routed.
        const ctx = audioCtxRef.current;
        if (ctx && ctx.state === "suspended") {
          void ctx.resume().catch(() => undefined);
        }
        applySpatialAmount();
      } else if (v) {
        // First ever use: build the graph inside this tap. It only
        // connects if the AudioContext is actually running; if not,
        // playback stays on the plain path and the next play builds it.
        void buildSpatialGraph().then((ok) => {
          if (ok) applySpatialAmount();
        });
      }
    },
    [applySpatialAmount, buildSpatialGraph],
  );

  return (
    <PlayerCtx.Provider
      value={{
        queue,
        index,
        startCount,
        current,
        playing,
        loading,
        playbackError,
        currentTime,
        duration,
        crossfadeOn,
        crossfadeSecs,
        slowed,
        spatial,
        volume,
        setVolume,
        speechRate,
        setSpeechRate,
        playQueue,
        toggle,
        pause,
        retry,
        next,
        prev,
        seek,
        setCrossfadeOn,
        setCrossfadeSecs,
        setSlowed,
        setSpatial,
        getCurrentSrc: () =>
          decksRef.current[activeRef.current]?.currentSrc || null,
        setFullSongHandler,
      }}
    >
      {children}
    </PlayerCtx.Provider>
  );
}
