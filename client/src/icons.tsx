// Clean stroke icons (Lucide-style, 24x24 grid) used across the app instead
// of emoji, so controls read as professional UI rather than cartoon glyphs.
// Every icon inherits currentColor and takes a Tailwind size class.

import type { ReactNode } from "react";

type IconProps = { className?: string };

function Stroke({
  className = "h-5 w-5",
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function Filled({
  className = "h-5 w-5",
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function IconHome({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="m3 9.5 9-7 9 7V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22v-8h6v8" />
    </Stroke>
  );
}

export function IconSearch({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </Stroke>
  );
}

export function IconLibrary({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M21 15V6" />
      <path d="M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
      <path d="M12 12H3" />
      <path d="M16 6H3" />
      <path d="M12 18H3" />
    </Stroke>
  );
}

export function IconMic({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </Stroke>
  );
}

export function IconPlay({ className }: IconProps) {
  return (
    <Filled className={className}>
      <path d="M7 4.8c0-.9.98-1.46 1.74-.99l11 6.7a1.14 1.14 0 0 1 0 1.98l-11 6.7A1.14 1.14 0 0 1 7 19.2z" />
    </Filled>
  );
}

export function IconPause({ className }: IconProps) {
  return (
    <Filled className={className}>
      <rect x="5.5" y="4" width="4.6" height="16" rx="1.4" />
      <rect x="13.9" y="4" width="4.6" height="16" rx="1.4" />
    </Filled>
  );
}

export function IconPrev({ className }: IconProps) {
  return (
    <Filled className={className}>
      <path d="M19.5 5.3v13.4c0 .9-.98 1.46-1.74.99L8.9 13.99a1.14 1.14 0 0 1 0-1.98l8.86-5.7a1.14 1.14 0 0 1 1.74.99Z" />
      <rect x="3.4" y="4" width="2.8" height="16" rx="1.2" />
    </Filled>
  );
}

export function IconNext({ className }: IconProps) {
  return (
    <Filled className={className}>
      <path d="M4.5 5.3v13.4c0 .9.98 1.46 1.74.99l8.86-5.7a1.14 1.14 0 0 0 0-1.98L6.24 6.31A1.14 1.14 0 0 0 4.5 5.3Z" />
      <rect x="17.8" y="4" width="2.8" height="16" rx="1.2" />
    </Filled>
  );
}

export function IconDownload({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </Stroke>
  );
}

export function IconUpload({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m17 8-5-5-5 5" />
      <path d="M12 3v12" />
    </Stroke>
  );
}

export function IconX({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Stroke>
  );
}

export function IconCheck({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M20 6 9 17l-5-5" />
    </Stroke>
  );
}

export function IconPlus({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Stroke>
  );
}

export function IconArrowLeft({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </Stroke>
  );
}

export function IconArrowRight({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Stroke>
  );
}

export function IconArrowUpRight({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </Stroke>
  );
}

export function IconShuffle({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="m16 3 5 0 0 5" />
      <path d="M4 20 21 3" />
      <path d="m21 16 0 5-5 0" />
      <path d="m15 15 6 6" />
      <path d="M4 4l5 5" />
    </Stroke>
  );
}

export function IconGauge({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="m12 14 3.5-3.5" />
      <path d="M20.2 16.2A9 9 0 1 0 3.8 16.2" />
    </Stroke>
  );
}

export function IconSparkles({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M11 4.5 12.6 9 17 10.6 12.6 12.2 11 16.7 9.4 12.2 5 10.6 9.4 9z" />
      <path d="M18.5 3.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
      <path d="M5.5 16.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z" />
    </Stroke>
  );
}

export function IconImage({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </Stroke>
  );
}

export function IconPencil({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
      <path d="m15 5 4 4" />
    </Stroke>
  );
}

export function IconMusicNote({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </Stroke>
  );
}

export function IconCast({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M2 16.1A5 5 0 0 1 7.9 20" />
      <path d="M2 12.05A9 9 0 0 1 9.95 20" />
      <path d="M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <path d="M2 20h.01" />
    </Stroke>
  );
}

export function IconSun({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.9 4.9 1.4 1.4" />
      <path d="m17.7 17.7 1.4 1.4" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.3 17.7-1.4 1.4" />
      <path d="m19.1 4.9-1.4 1.4" />
    </Stroke>
  );
}

export function IconMoon({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Stroke>
  );
}

export function IconSpatial({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.4 5.6a9 9 0 0 1 0 12.8" />
    </Stroke>
  );
}

export function IconHeadphones({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M4 15v-2a8 8 0 0 1 16 0v2" />
      <path d="M3 15a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M21 15a1 1 0 0 0-1-1h-1a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1z" />
    </Stroke>
  );
}

export function IconChevronUp({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="m18 15-6-6-6 6" />
    </Stroke>
  );
}

export function IconChevronDown({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="m6 9 6 6 6-6" />
    </Stroke>
  );
}

export function IconLyrics({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M4 6h13" />
      <path d="M4 10h10" />
      <path d="M4 14h13" />
      <path d="M18.5 13.5v5" />
      <circle cx="16" cy="18.5" r="2" />
    </Stroke>
  );
}

export function IconExpand({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="M21 3l-7 7" />
      <path d="M3 21l7-7" />
    </Stroke>
  );
}

export function IconShrink({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M8 3v5H3" />
      <path d="M16 21v-5h5" />
      <path d="M3 8l5-5" />
      <path d="M21 16l-5 5" />
    </Stroke>
  );
}

export function IconVideo({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <rect x="2.5" y="5.5" width="13" height="13" rx="2.5" />
      <path d="m15.5 10.8 6-3.6v9.6l-6-3.6" />
    </Stroke>
  );
}

export function IconSpeaker({ className }: IconProps) {
  return (
    <Stroke className={className}>
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.6 5.4a9 9 0 0 1 0 13.2" />
    </Stroke>
  );
}
