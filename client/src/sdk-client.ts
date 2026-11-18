// Standalone replacement for `@hatch/space-sdk/client` — the only part of
// the platform SDK the client imports (see client/src/api.ts and
// client/src/main.tsx).
//
// Wire protocol (identical to the original, so the server and client agree
// without any change to App.tsx): POST ./actions with JSON
// `{action, args, actionCallId}`; success responds `{data}`; failure
// responds `{error, code?, issues?}` with a non-2xx status.
//
// Differences from the platform client, all deliberate:
// - No viewer/auth-refresh flow (the standalone server uses HTTP Basic auth;
//   the browser handles the prompt and replays credentials automatically).
// - No failure-notice toast (the platform only showed it at platformVersion
//   >= 29; this app shipped at 28, so it never fired).
// - `spaceQueryClient` keeps the platform's conservative defaults
//   (retry via shouldRetryAction, staleTime 30s, no refetch on focus).

import "./sdk-styles.css";
import { MutationCache, QueryClient } from "@tanstack/react-query";
import type { infer as ZodInfer, input as ZodInput, ZodType } from "zod";

export class SpaceActionError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number | undefined;
  readonly retrySafe: boolean;
  readonly code?: string | undefined;
  readonly issues: readonly unknown[];
  readonly detail: string;

  constructor(
    message: string,
    status: number,
    retryAfterMs?: number | undefined,
    retrySafe = false,
    code?: string | undefined,
    issues: readonly unknown[] = [],
    detail: string = message,
  ) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retrySafe = retrySafe;
    this.code = code;
    this.issues = issues;
    this.detail = detail;
    this.name = "SpaceActionError";
  }
}

export const PERMANENT_ACTION_STATUSES = new Set([
  400, 401, 403, 404, 409, 413, 415, 422,
]);

export const MAX_ACTION_RETRIES = 3;

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

export function shouldRetryAction(
  failureCount: number,
  error: unknown,
): boolean {
  if (
    error instanceof SpaceActionError &&
    PERMANENT_ACTION_STATUSES.has(error.status)
  ) {
    return false;
  }
  return (
    error instanceof SpaceActionError &&
    error.retrySafe &&
    failureCount < MAX_ACTION_RETRIES
  );
}

export function actionRetryDelay(
  failureCount: number,
  error: unknown,
): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** failureCount);
  const floor =
    error instanceof SpaceActionError && error.retryAfterMs != null
      ? Math.min(RETRY_CAP_MS, Math.max(0, error.retryAfterMs))
      : 0;
  return floor + Math.random() * ceiling;
}

export const spaceQueryClient = new QueryClient({
  mutationCache: new MutationCache({}),
  defaultOptions: {
    queries: {
      retry: shouldRetryAction,
      retryDelay: actionRetryDelay,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});

export type ApiRequest<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Parameters<C[K]>[0];

export type ApiResponse<
  C extends Record<string, (args: never) => Promise<unknown>>,
  K extends keyof C,
> = Awaited<ReturnType<C[K]>>;

type ClientActionShape = {
  request: ZodType;
  response: ZodType;
};

export type ActionClient<A extends Record<string, ClientActionShape>> = {
  [K in keyof A]: (
    args: ZodInput<A[K]["request"]>,
  ) => Promise<ZodInfer<A[K]["response"]>>;
};

interface ClientOptions {
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
}

function createActionCallId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createActionClient<
  A extends Record<string, ClientActionShape>,
>(options: ClientOptions = {}): ActionClient<A> {
  const endpoint = options.endpoint ?? "./actions";
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const callAction = (action: string, args: unknown, actionCallId: string) =>
    fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": actionCallId,
      },
      body: JSON.stringify({ action, args: args ?? {}, actionCallId }),
    });

  return new Proxy({} as ActionClient<A>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "then" || name === "catch" || name === "finally") {
        return undefined;
      }
      return async (args: unknown) => {
        const actionCallId = createActionCallId();
        let response: Response;
        try {
          response = await callAction(name, args, actionCallId);
        } catch (e) {
          throw new SpaceActionError(
            "Couldn't reach the app server. Check your connection and try again.",
            0,
            undefined,
            true,
            undefined,
            [],
            String(e),
          );
        }
        let body: unknown = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (!response.ok) {
          const err =
            body !== null && typeof body === "object" && "error" in body
              ? (body as { error?: unknown; code?: string; issues?: unknown[] })
              : {};
          const message =
            typeof err.error === "string" && err.error.length > 0
              ? err.error
              : `The ${name} action failed (HTTP ${response.status}). Try again.`;
          throw new SpaceActionError(
            message,
            response.status,
            undefined,
            false,
            typeof err.code === "string" ? err.code : undefined,
            Array.isArray(err.issues) ? err.issues : [],
            JSON.stringify(body ?? null),
          );
        }
        if (
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          (body as { error?: unknown }).error
        ) {
          throw new Error(
            `action ${name} error: ${String((body as { error: unknown }).error)}`,
          );
        }
        return (body as { data?: unknown })?.data;
      };
    },
  });
}

// No viewer context on the standalone copy: the app is single-user and the
// server gates access with HTTP Basic auth instead. These exist only so
// code written against the platform client keeps compiling.
export async function getSpaceViewer(): Promise<null> {
  return null;
}

export function subscribeSpaceViewer(): () => void {
  return () => {};
}

export function useSpaceViewer(): null {
  return null;
}

// Base64 helpers (same behaviour as the platform's file-encoding module;
// App.tsx has its own local fileToBase64 and does not import these, but
// they are part of the client surface).
export function bytesToBase64(bytes: Uint8Array): string {
  const native = bytes as Uint8Array & { toBase64?: () => string };
  if (typeof native.toBase64 === "function") return native.toBase64();
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

export async function fileToBase64(
  file: File | Blob,
): Promise<{ dataBase64: string; mimeType: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { dataBase64: bytesToBase64(bytes), mimeType: file.type || "application/octet-stream" };
}

export function setFailureNoticeText(_text: unknown): void {
  // No-op: the standalone copy shows action errors inline like the
  // original did at platformVersion 28.
}
