// Casting: hand the currently playing song or video to a TV or device
// on the same network, using the real discovery mechanisms the browser
// offers:
//  - Google Cast — Chromecast, Cast-enabled smart TVs, and Fire TV /
//    Fire Stick receivers that accept Cast/DIAL on this network. The
//    framework reports whether any device is actually discoverable
//    (CAST_STATE_CHANGED); the device itself is chosen in Google's own
//    picker, which is the only list the web platform exposes.
//  - AirPlay — Apple TV and AirPlay TVs, via Safari's playback-target
//    picker on a media element loaded with the same URL.
// Nothing here pretends: when no device is discoverable, or the browser
// view can't run Cast at all, the panel says so.

export type CastMedia = {
  url: string;
  title: string;
  subtitle?: string;
  artworkUrl?: string | null;
  isVideo?: boolean;
};

export type CastReadiness = {
  /** The Google Cast framework loaded and is usable in this view. */
  googleCast: boolean;
  /** The framework reports at least one Cast device on this network. */
  castDeviceFound: boolean;
  /** Safari's AirPlay picker exists in this browser. */
  airplay: boolean;
  /** A Cast session is live right now. */
  sessionActive: boolean;
};

// The Cast SDK ships no types here; it is loaded at runtime from
// Google's own host (the same script every Cast sender page uses).
type CastGlobal = {
  cast?: {
    framework?: {
      CastContext: {
        getInstance: () => {
          setOptions: (o: unknown) => void;
          requestSession: () => Promise<unknown>;
          getCurrentSession: () => {
            loadMedia: (req: unknown) => Promise<unknown>;
            getSessionState?: () => string;
          } | null;
          getCastState: () => string;
          addEventListener: (type: string, fn: () => void) => void;
        };
      };
      CastContextEventType: { CAST_STATE_CHANGED: string };
      SessionState: { SESSION_STARTED: string };
    };
  };
  chrome?: {
    cast?: {
      media: {
        MediaInfo: new (url: string, contentType: string) => {
          metadata?: unknown;
        };
        GenericMediaMetadata: new () => {
          title?: string;
          subtitle?: string;
          images?: unknown[];
        };
        Image: new (url: string) => unknown;
        LoadRequest: new (mediaInfo: unknown) => unknown;
      };
      AutoJoinPolicy: { ORIGIN_SCOPED: string };
    };
  };
  __onGCastApiAvailable?: (available: boolean) => void;
};

const g = () => window as unknown as CastGlobal;

let sdkPromise: Promise<boolean> | null = null;
const listeners = new Set<() => void>();
function emit() {
  for (const fn of listeners) fn();
}
export function onCastChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function castContext() {
  try {
    return g().cast?.framework?.CastContext.getInstance() ?? null;
  } catch {
    return null;
  }
}

/** Load the Google Cast sender SDK once; resolves false when this
 *  browser view can't run it (blocked script, no framework). */
export function loadCastSdk(): Promise<boolean> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<boolean>((resolve) => {
    if (g().cast?.framework) {
      initContext();
      resolve(true);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) initContext();
      emit();
      resolve(ok);
    };
    g().__onGCastApiAvailable = (available) => done(available);
    const script = document.createElement("script");
    script.src =
      "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    script.async = true;
    script.onerror = () => done(false);
    document.head.appendChild(script);
    // The framework callback normally fires in well under this; if the
    // view blocks the script outright, don't hang the panel forever.
    window.setTimeout(() => done(Boolean(g().cast?.framework)), 6000);
  });
  return sdkPromise;
}

let contextInited = false;
function initContext() {
  if (contextInited) return;
  const ctx = castContext();
  const chromeCast = g().chrome?.cast;
  if (!ctx || !chromeCast) return;
  contextInited = true;
  try {
    ctx.setOptions({
      receiverApplicationId: "CC1AD845", // Default Media Receiver
      autoJoinPolicy: chromeCast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    const type = g().cast?.framework?.CastContextEventType.CAST_STATE_CHANGED;
    if (type) ctx.addEventListener(type, () => emit());
  } catch {
    // Options failed — readiness reads below still report honestly.
  }
}

export function airplaySupported(): boolean {
  try {
    const v = document.createElement("video") as HTMLVideoElement & {
      webkitShowPlaybackTargetPicker?: unknown;
    };
    return typeof v.webkitShowPlaybackTargetPicker === "function";
  } catch {
    return false;
  }
}

export function castReadiness(): CastReadiness {
  const ctx = castContext();
  let castDeviceFound = false;
  let sessionActive = false;
  if (ctx) {
    try {
      // "NO_DEVICES_AVAILABLE" is the framework's own verdict that
      // nothing castable is on this network right now.
      castDeviceFound = ctx.getCastState() !== "NO_DEVICES_AVAILABLE";
      sessionActive = ctx.getCurrentSession() != null;
    } catch {
      castDeviceFound = false;
    }
  }
  return {
    googleCast: Boolean(ctx),
    castDeviceFound,
    airplay: airplaySupported(),
    sessionActive,
  };
}

function contentTypeFor(media: CastMedia): string {
  const u = media.url.toLowerCase();
  if (media.isVideo) return "video/mp4";
  if (u.includes(".mp3")) return "audio/mpeg";
  if (u.includes(".wav")) return "audio/wav";
  if (u.includes(".m4a") || u.includes(".aac")) return "audio/mp4";
  return "audio/mpeg";
}

/** Open Google's device picker (Chromecast, smart TVs, Fire TV / Fire
 *  Stick receivers on this network) and, once the user picks one, load
 *  the current song/video on it. Resolves a plain-language outcome. */
export async function castViaGoogleCast(
  media: CastMedia,
): Promise<{ ok: boolean; message: string }> {
  const loaded = await loadCastSdk();
  const ctx = castContext();
  const chromeCast = g().chrome?.cast;
  if (!loaded || !ctx || !chromeCast) {
    return {
      ok: false,
      message:
        "Google Cast isn't available in this browser view, so no TV or Fire Stick can be reached from here. Casting works from Chrome or Android.",
    };
  }
  if (ctx.getCastState() === "NO_DEVICES_AVAILABLE") {
    return {
      ok: false,
      message:
        "No castable device was found on this network — no Chromecast, smart TV, or Fire TV / Fire Stick is reachable right now. Check the TV is on and on the same Wi-Fi.",
    };
  }
  try {
    await ctx.requestSession();
  } catch {
    return {
      ok: false,
      message: "No device was picked, so nothing was cast.",
    };
  }
  const session = ctx.getCurrentSession();
  if (!session) {
    return { ok: false, message: "The cast session didn't start." };
  }
  try {
    const info = new chromeCast.media.MediaInfo(
      media.url,
      contentTypeFor(media),
    );
    const meta = new chromeCast.media.GenericMediaMetadata();
    meta.title = media.title;
    if (media.subtitle) meta.subtitle = media.subtitle;
    if (media.artworkUrl) {
      meta.images = [new chromeCast.media.Image(media.artworkUrl)];
    }
    info.metadata = meta;
    await session.loadMedia(new chromeCast.media.LoadRequest(info));
    return {
      ok: true,
      message: `Casting “${media.title}” to your TV — it should start playing there now.`,
    };
  } catch {
    return {
      ok: false,
      message:
        "The device was picked but the song couldn't be handed over — it may not accept this stream. Your uploads cast best; catalog previews can be refused by some TVs.",
    };
  }
}

/** AirPlay: load the same media URL into a picker element and open
 *  Safari's own AirPlay target list (Apple TV / AirPlay TVs). */
export function castViaAirplay(media: CastMedia): { ok: boolean; message: string } {
  const v = document.createElement("video") as HTMLVideoElement & {
    webkitShowPlaybackTargetPicker?: () => void;
  };
  if (typeof v.webkitShowPlaybackTargetPicker !== "function") {
    return {
      ok: false,
      message:
        "AirPlay isn't offered by this browser — it works in Safari on iPhone, iPad, and Mac.",
    };
  }
  v.src = media.url;
  v.preload = "auto";
  try {
    v.webkitShowPlaybackTargetPicker();
    return {
      ok: true,
      message:
        "Pick your Apple TV or AirPlay TV in the list — the song hands over to it there.",
    };
  } catch {
    return {
      ok: false,
      message: "The AirPlay picker couldn't open in this view.",
    };
  }
}
