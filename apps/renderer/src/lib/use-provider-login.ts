import { Effect, Fiber, Stream } from "effect";
import { useEffect, useRef, useState } from "react";

import { type LoginEvent, type ProviderId } from "@memoize/wire";

import { getRpcClient } from "./rpc-client";

export type ProviderLoginState =
  | { readonly kind: "idle" }
  | { readonly kind: "waiting"; readonly url: string | null }
  | { readonly kind: "success" }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Open a URL in the user's OS browser via the preload bridge (Electron's
 * `shell.openExternal`). Falls back to `window.open` for web/dev contexts.
 * We intentionally avoid an in-app webview here: an OAuth flow needs the
 * user's real browser session, password manager, and cookies.
 */
export const openExternal = (url: string): void => {
  const bridge = window.memoize?.app;
  if (bridge !== undefined) {
    bridge.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};

/**
 * Shared one-click provider sign-in state machine. Subscribes to
 * `agent.startLogin`, which spawns the provider's `login` subcommand
 * server-side and streams progress. The first `url` event opens the OAuth page
 * in the OS browser; the terminal `done` event resolves to success/failure.
 * Cancel (or unmount) interrupts the stream, which closes the server-side
 * scope and SIGTERMs the child process.
 *
 * Used by both the provider settings card and the inline auth ErrorBubble so
 * the flow (and its copy) stays identical wherever a user signs in.
 */
export function useProviderLogin(
  providerId: ProviderId,
  opts?: { readonly onSuccess?: () => void },
): {
  readonly state: ProviderLoginState;
  readonly start: () => Promise<void>;
  readonly cancel: () => void;
} {
  const [state, setState] = useState<ProviderLoginState>({ kind: "idle" });
  const fiberRef = useRef<Fiber.RuntimeFiber<unknown, unknown> | null>(null);
  const onSuccessRef = useRef(opts?.onSuccess);
  onSuccessRef.current = opts?.onSuccess;

  useEffect(
    () => () => {
      const fiber = fiberRef.current;
      if (fiber !== null) void Effect.runPromise(Fiber.interrupt(fiber));
    },
    [],
  );

  const cancel = (): void => {
    const fiber = fiberRef.current;
    if (fiber !== null) {
      void Effect.runPromise(Fiber.interrupt(fiber));
      fiberRef.current = null;
    }
    setState({ kind: "idle" });
  };

  const start = async (): Promise<void> => {
    setState({ kind: "waiting", url: null });
    const client = await getRpcClient();
    const fiber = Effect.runFork(
      Stream.runForEach(
        client.agent.startLogin({ providerId }),
        (event: LoginEvent) =>
          Effect.sync(() => {
            if (event._tag === "url") {
              openExternal(event.url);
              setState({ kind: "waiting", url: event.url });
            } else if (event._tag === "done") {
              fiberRef.current = null;
              if (event.ok) {
                setState({ kind: "success" });
                onSuccessRef.current?.();
              } else {
                setState({
                  kind: "failed",
                  reason: event.reason ?? "Sign-in failed.",
                });
              }
            }
            // "log" events are diagnostic-only; ignored in the UI.
          }),
      ).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => {
            fiberRef.current = null;
            setState({
              kind: "failed",
              reason: err instanceof Error ? err.message : String(err),
            });
          }),
        ),
      ),
    );
    fiberRef.current = fiber;
  };

  return { state, start, cancel };
}
