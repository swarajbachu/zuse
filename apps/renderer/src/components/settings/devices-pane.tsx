import { Effect } from "effect";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { AdvertisedEndpoint, RelayLinkStatus } from "@zuse/wire";

import {
  readEndpointOverride,
  selectAdvertisedEndpoint,
  writeEndpointOverride,
} from "../../lib/advertised-endpoints.ts";
import { formatError } from "../../lib/format-error.ts";
import { getRpcClient } from "../../lib/rpc-client.ts";
import { Button } from "../ui/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible.tsx";
import {
  Frame,
  FrameDescription,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "../ui/frame.tsx";
import { Input } from "../ui/input.tsx";
import { Spinner } from "../ui/spinner.tsx";
import { toastManager } from "../ui/toast.tsx";

const DEFAULT_RELAY_URL =
  (import.meta.env.VITE_ZUSE_RELAY_URL as string | undefined) ??
  "https://relay.stuff.md";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const relayErrorMessage = (cause: unknown): string => {
  const formatted = formatError(cause);
  if (formatted.includes("not_signed_in")) {
    return "Sign in before linking this Mac to your account.";
  }
  if (
    formatted.includes("relay_auth_rejected") ||
    formatted.includes("invalid_workos_token") ||
    formatted.includes("relay_401")
  ) {
    return "We couldn't verify your sign-in. Sign out, sign in again, and try connecting this Mac once more.";
  }
  if (
    formatted.includes("Failed to fetch") ||
    formatted.includes("NetworkError") ||
    formatted.includes("relay_502") ||
    formatted.includes("relay_503") ||
    formatted.includes("relay_504")
  ) {
    return "We couldn't reach the device relay. Check your internet connection and try again.";
  }
  return "Something went wrong while updating this Mac. Try again.";
};

const showRelayErrorToast = (title: string, cause: unknown): void => {
  toastManager.add({
    type: "error",
    title,
    description: relayErrorMessage(cause),
  });
};

const isStatusLoadError = (cause: unknown): boolean =>
  isRecord(cause) &&
  (cause.reason === "not_signed_in" ||
    (typeof cause.message === "string" &&
      cause.message.includes("not_signed_in")));

/**
 * "Devices" settings pane. Links this Mac to the account relay so it appears on
 * the phone with live presence. The server does the whole flow (Ed25519 proof +
 * link + heartbeat); this pane just drives the relay.* RPCs and shows status.
 */
export function DevicesPane() {
  const [status, setStatus] = useState<RelayLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const [endpointOverrideId, setEndpointOverrideId] = useState<string | null>(
    () => readEndpointOverride(),
  );
  const [endpointsOpen, setEndpointsOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const client = await getRpcClient();
      const next = await Effect.runPromise(client.relay.status());
      setStatus(next);
    } catch (cause) {
      if (!isStatusLoadError(cause)) {
        showRelayErrorToast("Could not load device status", cause);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onConnect = useCallback(async () => {
    setBusy(true);
    try {
      const client = await getRpcClient();
      const next = await Effect.runPromise(
        client.relay.link({
          relayUrl: DEFAULT_RELAY_URL.trim().replace(/\/$/, ""),
          label: label.trim().length > 0 ? label.trim() : undefined,
        }),
      );
      setStatus(next);
    } catch (cause) {
      showRelayErrorToast("Could not connect this Mac", cause);
    } finally {
      setBusy(false);
    }
  }, [label]);

  const onUnlink = useCallback(async () => {
    setBusy(true);
    try {
      const client = await getRpcClient();
      await Effect.runPromise(client.relay.unlink());
      await refresh();
    } catch (cause) {
      showRelayErrorToast("Could not unlink this Mac", cause);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const onSelectEndpoint = useCallback((endpointId: string) => {
    setEndpointOverrideId(endpointId);
    writeEndpointOverride(endpointId);
  }, []);

  if (loading) {
    return (
      <section className="flex flex-1 items-center justify-center p-6">
        <Spinner />
      </section>
    );
  }

  const linked = status?.linked === true;
  const advertisedEndpoints = status?.advertisedEndpoints ?? [];
  const selectedEndpoint = selectAdvertisedEndpoint(
    advertisedEndpoints,
    endpointOverrideId,
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      {linked ? (
        <Frame>
          <FrameHeader className="flex-row items-start justify-between gap-3 px-3 py-2.5">
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
                <FrameTitle className="truncate">
                  {status?.label ?? "This Mac"}
                </FrameTitle>
              </div>
              <FrameDescription className="mt-1 truncate text-xs">
                {status?.heartbeatActive === true ? "Online" : "Idle"} · Linked
                to your account
              </FrameDescription>
            </div>
          </FrameHeader>
          {selectedEndpoint !== null && (
            <FramePanel className="p-3">
              <EndpointSummary endpoint={selectedEndpoint} />
            </FramePanel>
          )}
          <FrameFooter className="flex items-center justify-between gap-3 px-3 py-2.5">
            <p className="min-w-0 text-xs text-muted-foreground">
              This Mac is reachable from your phone after you sign in to the
              same account there.
            </p>
            <Button
              variant="destructive"
              className="min-w-20"
              onClick={() => void onUnlink()}
              disabled={busy}
            >
              Unlink
            </Button>
          </FrameFooter>
        </Frame>
      ) : (
        <Frame>
          <FrameHeader className="px-3 py-2.5">
            <FrameTitle>This Mac</FrameTitle>
            <FrameDescription className="mt-1">
              Link this Mac to your account so it shows up on your phone.
            </FrameDescription>
          </FrameHeader>
          <FramePanel className="p-3">
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-foreground">
                Name (optional)
              </label>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="This Mac"
              />
            </div>
          </FramePanel>
          <FrameFooter className="flex justify-end px-3 py-2.5">
            <Button onClick={() => void onConnect()} disabled={busy}>
              {busy ? "Connecting…" : "Connect this Mac"}
            </Button>
          </FrameFooter>
        </Frame>
      )}

      {advertisedEndpoints.length > 0 && (
        <Collapsible open={endpointsOpen} onOpenChange={setEndpointsOpen}>
          <Frame>
            <FrameHeader className="px-3 py-2.5">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left">
                <div>
                  <FrameTitle>All endpoints</FrameTitle>
                  <FrameDescription className="mt-1 text-xs">
                    {advertisedEndpoints.length} advertised route
                    {advertisedEndpoints.length === 1 ? "" : "s"}
                  </FrameDescription>
                </div>
                <ChevronDown
                  className={
                    endpointsOpen
                      ? "size-4 rotate-180 text-muted-foreground transition-transform"
                      : "size-4 text-muted-foreground transition-transform"
                  }
                  aria-hidden
                />
              </CollapsibleTrigger>
            </FrameHeader>
            <CollapsibleContent>
              <FramePanel className="p-3">
                <div className="flex flex-col gap-2">
                  {advertisedEndpoints.map((endpoint) => {
                    const selected = selectedEndpoint?.id === endpoint.id;
                    return (
                      <button
                        key={endpoint.id}
                        type="button"
                        className="flex min-w-0 items-start gap-3 rounded-lg border border-border/50 bg-muted/20 p-3 text-left hover:bg-muted/40"
                        onClick={() => onSelectEndpoint(endpoint.id)}
                      >
                        <span
                          className={
                            selected
                              ? "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                              : "mt-0.5 size-5 shrink-0 rounded-full border border-border"
                          }
                          aria-hidden
                        >
                          {selected ? <Check className="size-3" /> : null}
                        </span>
                        <EndpointDetails endpoint={endpoint} />
                      </button>
                    );
                  })}
                </div>
              </FramePanel>
            </CollapsibleContent>
          </Frame>
        </Collapsible>
      )}
    </section>
  );
}

function EndpointSummary({ endpoint }: { endpoint: AdvertisedEndpoint }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-xs font-medium text-foreground">
          Default endpoint
        </span>
        <EndpointBadge endpoint={endpoint} />
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {endpoint.label} · {endpoint.status}
      </p>
    </div>
  );
}

function EndpointDetails({ endpoint }: { endpoint: AdvertisedEndpoint }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="truncate text-sm font-medium text-foreground">
          {endpoint.label}
        </div>
        <EndpointBadge endpoint={endpoint} />
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        <span>{endpoint.providerKind}</span>
        <span>·</span>
        <span>{endpoint.reachability}</span>
        <span>·</span>
        <span>{endpoint.compatibility.hostedHttpsApp}</span>
        <span>·</span>
        <span>{endpoint.status}</span>
      </div>
    </div>
  );
}

function EndpointBadge({ endpoint }: { endpoint: AdvertisedEndpoint }) {
  return (
    <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
      {endpoint.reachability}
    </span>
  );
}
