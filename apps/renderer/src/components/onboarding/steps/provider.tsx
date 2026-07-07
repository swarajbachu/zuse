import { HugeiconsIcon } from "@hugeicons/react";
import {
  LinkSquare01Icon,
  Tick01Icon,
  ViewIcon,
  ViewOffIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import { useState } from "react";

import type { AgentAvailability, ProviderId } from "@zuse/wire";

import { ProviderIcon } from "~/components/provider-icons";
import { PROVIDER_LABEL } from "~/components/settings-page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { isInitialProviderAvailabilityLoading } from "~/lib/provider-status";
import { cn } from "~/lib/utils";
import { useProvidersStore } from "../../../store/providers.ts";
import { useSettingsStore } from "../../../store/settings.ts";
import { StepHeader } from "./shared.tsx";

// Subscription-gated providers — same set surfaced as violet notices on the
// settings ProviderCard and filtered out of the composer's provider picker.
// We can't verify the plan from the CLI, so the onboarding card flags the
// requirement before the user picks the provider and discovers it the
// hard way mid-session.
const SUBSCRIPTION_INFO: Partial<
  Record<ProviderId, { readonly plan: string; readonly url: string }>
> = {
  grok: { plan: "SuperGrok or X Premium+", url: "https://x.ai/cli" },
  cursor: { plan: "Cursor Pro", url: "https://cursor.com/pricing" },
};

const openExternal = (url: string): void => {
  if (typeof window === "undefined") return;
  const bridge = window as unknown as {
    zuse?: { app?: { openExternal?: (u: string) => void } };
    memoize?: { app?: { openExternal?: (u: string) => void } };
  };
  const open =
    bridge.zuse?.app?.openExternal ?? bridge.memoize?.app?.openExternal;
  if (typeof open === "function") {
    open(url);
    return;
  }
  window.open(url, "_blank", "noopener");
};

const LOGIN_HINT: Record<ProviderId, string> = {
  claude: "claude /login",
  codex: "codex login",
  grok: "grok",
  cursor: "cursor-agent login",
  gemini: "gemini",
  opencode: "opencode auth login",
};

const INSTALL_HINT: Record<ProviderId, string> = {
  claude: "npm i -g @anthropic-ai/claude-code",
  codex: "npm i -g @openai/codex",
  grok: "curl -fsSL https://x.ai/cli/install.sh | bash",
  cursor: "curl https://cursor.com/install -fsS | bash",
  gemini: "npm i -g @google/gemini-cli",
  opencode: "curl -fsSL https://opencode.ai/install | bash",
};

type ProviderState =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" } // CLI not installed
  | {
      readonly kind: "outdated";
      readonly current: string;
      readonly required: string;
      readonly command: string | null;
    } // installed but below SDK floor
  | { readonly kind: "signed-out" } // CLI installed, not logged in, no API key
  | { readonly kind: "subscription"; readonly plan: string } // logged in but missing required paid plan (e.g. SuperGrok or X Premium+)
  | { readonly kind: "ready"; readonly via: "cli" | "key" };

function deriveState(
  providerId: ProviderId,
  availability: ReadonlyArray<AgentAvailability>,
  loading: boolean,
): ProviderState {
  const a = availability.find((x) => x.providerId === providerId);
  if (a === undefined) {
    return loading ? { kind: "loading" } : { kind: "missing" };
  }
  if (!a.cliInstalled) return { kind: "missing" };
  // Outdated trumps logged-in / ready: a stale CLI will reject the SDK's
  // probe flags regardless of auth state, so showing "Connected" here would
  // be misleading.
  if (a.cliVersionStatus === "outdated") {
    return {
      kind: "outdated",
      current: a.cliVersion ?? "unknown version",
      required: a.cliVersionMinRequired ?? "a newer version",
      command: a.cliUpgradeCommand ?? null,
    };
  }

  // For subscription-gated providers (grok, cursor), the server-side probe
  // (parseGrokAuthJson etc.) sets authLabel to "Requires SuperGrok or X Premium+"
  // (or equivalent) when the JWT tier is insufficient, even if cliLoggedIn
  // is true. We surface this as a distinct state so onboarding no longer
  // lies to paying users who already have the plan.
  if (a.cliLoggedIn) {
    const subInfo = SUBSCRIPTION_INFO[providerId];
    const unmet =
      subInfo !== undefined &&
      (a.authLabel ?? "").toLowerCase().includes("require");
    if (unmet) {
      return { kind: "subscription", plan: subInfo.plan };
    }
    return { kind: "ready", via: "cli" };
  }

  if (a.hasApiKey) return { kind: "ready", via: "key" };
  return { kind: "signed-out" };
}

export function ProviderStep() {
  const defaultProviderId = useSettingsStore((s) => s.defaultProviderId);
  const setDefaultProvider = useSettingsStore((s) => s.setDefaultProvider);
  const availability = useProvidersStore((s) => s.availability);
  const loading = useProvidersStore((s) => s.loading);
  const availabilityLoaded = useProvidersStore((s) => s.availabilityLoaded);

  const providers: ReadonlyArray<ProviderId> = [
    "claude",
    "codex",
    "grok",
    "gemini",
    "cursor",
    "opencode",
  ];

  const initialLoading = isInitialProviderAvailabilityLoading(
    loading,
    availabilityLoaded,
  );
  const selectedState = deriveState(
    defaultProviderId,
    availability,
    initialLoading,
  );

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        title="Pick your default agent"
        // Welcome step already established "we reuse your CLI auth, no new
        // logins" — so here we just nudge them to pick and continue. Short
        // subtitle keeps the cards above the fold.
        subtitle="Whichever CLI you use most. You can change it anytime."
      />

      <div className="grid grid-cols-2 gap-2.5">
        {providers.map((pid) => (
          <ProviderCard
            key={pid}
            providerId={pid}
            state={deriveState(pid, availability, initialLoading)}
            active={pid === defaultProviderId}
            onClick={() => setDefaultProvider(pid)}
          />
        ))}
      </div>

      <ProviderStatus providerId={defaultProviderId} state={selectedState} />
    </div>
  );
}

function ProviderCard({
  providerId,
  state,
  active,
  onClick,
}: {
  providerId: ProviderId;
  state: ProviderState;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        // Tighter card: row layout (icon + text + state) instead of stacked
        // tiles. Removes ~30% of vertical height while keeping the same
        // information density.
        "group relative flex items-center gap-3 overflow-hidden rounded-xl p-2.5 text-left transition-all",
        active
          ? "bg-accent text-accent-foreground"
          : "bg-muted/60 hover:bg-muted",
      )}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/70 text-foreground">
        <ProviderIcon providerId={providerId} className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium leading-none text-foreground">
            {PROVIDER_LABEL[providerId]}
          </span>
          {/* Only show the violet "Sub" chip when the probe actually detected
              an unmet plan requirement. Users with a valid tier see a clean
              card with no chip. */}
          {state.kind === "subscription" && (
            <span className="rounded-full bg-violet-500/[0.12] px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-violet-300">
              Sub
            </span>
          )}
        </span>
        <StateLine state={state} />
      </span>
      {active ? (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
          <HugeiconsIcon
            icon={Tick01Icon}
            className="size-2.5"
            strokeWidth={3.5}
          />
        </span>
      ) : (
        <StateDot state={state} />
      )}
    </button>
  );
}

function StateDot({ state }: { state: ProviderState }) {
  const styles: Record<ProviderState["kind"], string> = {
    loading: "bg-muted-foreground/40 animate-pulse",
    missing: "bg-rose-400/80",
    outdated: "bg-amber-400",
    "signed-out": "bg-amber-400",
    subscription: "bg-amber-400",
    ready: "bg-emerald-400",
  };
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", styles[state.kind])}
      aria-hidden
    />
  );
}

function StateLine({ state }: { state: ProviderState }) {
  const text =
    state.kind === "loading"
      ? "Checking…"
      : state.kind === "missing"
        ? "Not installed"
        : state.kind === "outdated"
          ? "Update required"
          : state.kind === "signed-out"
            ? "Sign in required"
            : state.kind === "subscription"
              ? "Subscription required"
              : state.via === "cli"
                ? "CLI logged in"
                : "API key set";
  const tone =
    state.kind === "ready"
      ? "text-emerald-300/90"
      : state.kind === "signed-out" ||
          state.kind === "outdated" ||
          state.kind === "subscription"
        ? "text-amber-300/90"
        : state.kind === "missing"
          ? "text-rose-300/90"
          : "text-muted-foreground";
  return (
    <span className={cn("text-[10px] font-medium tracking-wide", tone)}>
      {text.toUpperCase()}
    </span>
  );
}

function ProviderStatus({
  providerId,
  state,
}: {
  providerId: ProviderId;
  state: ProviderState;
}) {
  const refresh = useProvidersStore((s) => s.refresh);
  const subscriptionInfo = SUBSCRIPTION_INFO[providerId];

  // Ready state has nothing for the user to do — the heavy card was reading
  // as a homework assignment ("did I miss a step?"). Collapse it to a slim
  // confirmation row and hide the API-key disclosure unless they ask for it.
  if (state.kind === "ready") {
    const label =
      state.via === "cli"
        ? `${PROVIDER_LABEL[providerId]} CLI is logged in. You're all set.`
        : `${PROVIDER_LABEL[providerId]} API key saved. You're all set.`;
    return (
      <div className="flex items-center gap-2 rounded-full bg-alert-success-bg px-3 py-2 text-[12px] text-success">
        <HugeiconsIcon icon={Tick01Icon} className="size-3.5" strokeWidth={3} />
        <span className="leading-none">{label}</span>
      </div>
    );
  }

  // Loading: a single quiet line, no big card.
  if (state.kind === "loading") {
    return (
      <div className="flex items-center gap-2 rounded-full bg-muted/60 px-3 py-2 text-[12px] text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
        Checking {PROVIDER_LABEL[providerId]}…
      </div>
    );
  }

  // Everything below requires the user to do something — keep the full card.
  const headline =
    state.kind === "signed-out"
      ? "Sign in to the CLI"
      : state.kind === "subscription"
        ? "Subscription required"
        : state.kind === "outdated"
          ? "Update the CLI"
          : "Install the CLI";

  const subline =
    state.kind === "signed-out"
      ? "Already installed. Just run the login command below."
      : state.kind === "subscription"
        ? "Your CLI login was detected, but the required paid plan was not confirmed."
        : state.kind === "outdated"
          ? `${PROVIDER_LABEL[providerId]} ${state.current} is too old; Zuse Alpha needs ${state.required}.`
          : `${PROVIDER_LABEL[providerId]}'s CLI isn't on your PATH yet.`;

  const command =
    state.kind === "signed-out"
      ? LOGIN_HINT[providerId]
      : state.kind === "outdated"
        ? (state.command ?? INSTALL_HINT[providerId])
        : state.kind === "missing"
          ? INSTALL_HINT[providerId]
          : null;

  return (
    <div className="flex flex-col gap-3 rounded-lg bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-foreground">
            {headline}
          </span>
          <span className="text-[11px] leading-snug text-muted-foreground">
            {subline}
          </span>
        </div>
        <StatusPill state={state} />
      </div>

      {state.kind === "subscription" && subscriptionInfo !== undefined && (
        <SubscriptionNotice
          providerId={providerId}
          plan={subscriptionInfo.plan}
          url={subscriptionInfo.url}
        />
      )}

      {command !== null && (
        <CodeRow command={command} onRecheck={() => void refresh()} />
      )}

      <details className="group/keys">
        <summary className="cursor-pointer select-none list-none text-[11px] text-muted-foreground hover:text-foreground">
          or paste an API key instead
        </summary>
        <div className="pt-3">
          <ApiKeyRow providerId={providerId} />
        </div>
      </details>
    </div>
  );
}

function SubscriptionNotice({
  providerId,
  plan,
  url,
}: {
  providerId: ProviderId;
  plan: string;
  url: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-violet-500/25 bg-violet-500/[0.08] px-3 py-2.5">
      <span className="text-[11px] font-medium text-violet-700 dark:text-violet-200">
        Requires {plan} subscription
      </span>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Sessions will fail if your plan doesn&apos;t include {plan}. Subscribe
        (or confirm your existing plan) before using{" "}
        {PROVIDER_LABEL[providerId]}.
      </p>
      <div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => openExternal(url)}
          className="gap-1.5 rounded-full bg-violet-500/15 px-2.5 text-[11px] text-violet-700 hover:bg-violet-500/25 hover:text-violet-800 dark:text-violet-200 dark:hover:text-violet-100"
        >
          <HugeiconsIcon icon={LinkSquare01Icon} className="size-3" />
          Subscribe to {plan}
        </Button>
      </div>
    </div>
  );
}

function CodeRow({
  command,
  onRecheck,
}: {
  command: string;
  onRecheck: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-muted px-3 py-2 font-mono text-[12px]">
      <code className="truncate text-foreground/90">$ {command}</code>
      <Button
        size="xs"
        variant="ghost"
        onClick={onRecheck}
        className="h-6 shrink-0 rounded-full px-2.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        Recheck
      </Button>
    </div>
  );
}

function StatusPill({ state }: { state: ProviderState }) {
  const map: Record<
    ProviderState["kind"],
    { label: string; dot: string; bg: string; text: string }
  > = {
    loading: {
      label: "Checking",
      dot: "bg-muted-foreground/50",
      bg: "bg-muted/70",
      text: "text-muted-foreground",
    },
    missing: {
      label: "Not installed",
      dot: "bg-rose-400",
      bg: "bg-rose-400/12",
      text: "text-rose-700 dark:text-rose-300",
    },
    outdated: {
      label: "Update",
      dot: "bg-amber-400",
      bg: "bg-amber-400/12",
      text: "text-amber-700 dark:text-amber-300",
    },
    "signed-out": {
      label: "Sign in",
      dot: "bg-amber-400",
      bg: "bg-amber-400/12",
      text: "text-amber-700 dark:text-amber-300",
    },
    subscription: {
      label: "Subscribe",
      dot: "bg-amber-400",
      bg: "bg-amber-400/12",
      text: "text-amber-700 dark:text-amber-300",
    },
    ready: {
      label: "Connected",
      dot: "bg-emerald-400",
      bg: "bg-emerald-400/12",
      text: "text-emerald-700 dark:text-emerald-300",
    },
  };
  const s = map[state.kind];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
        s.bg,
        s.text,
      )}
    >
      <span className={cn("size-1.5 rounded-full", s.dot)} />
      {s.label}
    </span>
  );
}

function ApiKeyRow({ providerId }: { providerId: ProviderId }) {
  const setCredential = useProvidersStore((s) => s.setCredential);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const onSave = async () => {
    if (value.trim().length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      await setCredential(providerId, value.trim());
      setValue("");
      setStatus("Saved.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Input
            type={reveal ? "text" : "password"}
            placeholder="paste API key"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            className="h-9 rounded-xl border-0 bg-muted/70"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="absolute end-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={reveal ? "Hide key" : "Reveal key"}
            tabIndex={-1}
          >
            {reveal ? (
              <HugeiconsIcon icon={ViewOffIcon} className="size-3.5" />
            ) : (
              <HugeiconsIcon icon={ViewIcon} className="size-3.5" />
            )}
          </button>
        </div>
        <Button
          size="sm"
          onClick={() => void onSave()}
          disabled={busy || value.trim().length === 0}
          className="rounded-full px-4"
        >
          Save
        </Button>
      </div>
      {status !== null && (
        <p className="text-[11px] text-muted-foreground">{status}</p>
      )}
    </div>
  );
}
