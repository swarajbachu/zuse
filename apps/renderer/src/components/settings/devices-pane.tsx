import { Effect } from "effect";
import { useCallback, useEffect, useState } from "react";

import type { RelayLinkStatus } from "@zuse/wire";

import { getRpcClient } from "../../lib/rpc-client.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Spinner } from "../ui/spinner.tsx";

const DEFAULT_RELAY_URL =
  (import.meta.env.VITE_ZUSE_RELAY_URL as string | undefined) ??
  "https://relay.stuff.md";

/**
 * "Devices" settings pane. Links this Mac to the account relay so it appears on
 * the phone with live presence. The server does the whole flow (Ed25519 proof +
 * link + heartbeat); this pane just drives the relay.* RPCs and shows status.
 */
export function DevicesPane() {
  const [status, setStatus] = useState<RelayLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [label, setLabel] = useState("");

  const refresh = useCallback(async () => {
    try {
      const client = await getRpcClient();
      const next = await Effect.runPromise(client.relay.status());
      setStatus(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onConnect = useCallback(async () => {
    if (relayUrl.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const client = await getRpcClient();
      const next = await Effect.runPromise(
        client.relay.link({
          relayUrl: relayUrl.trim().replace(/\/$/, ""),
          label: label.trim().length > 0 ? label.trim() : undefined,
        }),
      );
      setStatus(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [relayUrl, label]);

  const onUnlink = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.relay.unlink());
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (loading) {
    return (
      <section className="flex flex-1 items-center justify-center p-6">
        <Spinner />
      </section>
    );
  }

  const linked = status?.linked === true;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      {linked ? (
        <div className="rounded-xl border border-border/50 bg-background p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={
                    status?.heartbeatActive === true
                      ? "size-2 rounded-full bg-emerald-500"
                      : "size-2 rounded-full bg-muted-foreground/40"
                  }
                  aria-hidden
                />
                <span className="truncate text-sm font-medium text-foreground">
                  {status?.label ?? "This Mac"}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {status?.heartbeatActive === true ? "Online · " : "Idle · "}
                linked to {status?.relayUrl}
              </p>
            </div>
            <Button
              variant="destructive-outline"
              onClick={() => void onUnlink()}
              disabled={busy}
            >
              Unlink
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            This Mac is reachable from your phone after you sign in to the same
            account there.
          </p>
        </div>
      ) : (
        <div className="rounded-xl border border-border/50 bg-background p-4">
          <p className="text-sm text-muted-foreground">
            Link this Mac to your account so it shows up on your phone. You must
            be signed in.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            <label className="text-sm font-medium text-foreground">
              Relay URL
            </label>
            <Input
              value={relayUrl}
              onChange={(event) => setRelayUrl(event.target.value)}
              placeholder="https://relay.stuff.md"
            />
            <label className="mt-1 text-sm font-medium text-foreground">
              Name (optional)
            </label>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="This Mac"
            />
            <Button
              className="mt-2 self-start"
              onClick={() => void onConnect()}
              disabled={busy || relayUrl.trim().length === 0}
            >
              {busy ? "Connecting…" : "Connect this Mac"}
            </Button>
          </div>
        </div>
      )}

      {error !== null && (
        <p className="text-xs text-destructive">{error}</p>
      )}
    </section>
  );
}
