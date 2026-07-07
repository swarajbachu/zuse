import type { AgentAvailability, ProviderId } from "@zuse/wire";

/**
 * Visual treatment per server-reported provider status. Centralized so the
 * onboarding card, settings card, and any future provider chip share one
 * language.
 */
export const PROVIDER_STATUS_STYLES = {
  ready: { dot: "bg-emerald-400" },
  warning: { dot: "bg-amber-400" },
  error: { dot: "bg-rose-400" },
  disabled: { dot: "bg-muted-foreground/40" },
  loading: { dot: "bg-muted-foreground/40 animate-pulse" },
  // Subscription-gated providers (Grok → SuperGrok or X Premium+) — distinct from
  // amber "sign in required" because the user already signed in; their
  // plan is what's missing.
  subscription: { dot: "bg-violet-400" },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

export interface ProviderSummary {
  readonly statusKey: ProviderStatusKey;
  readonly headline: string;
  readonly detail: string | null;
  /**
   * Email rendered alongside the headline when known. Surfaced separately
   * from `headline` so the renderer can blur it for screen-record privacy
   * and reveal on click.
   */
  readonly authEmail: string | null;
  /** When true, the headline is a CTA — render with stronger emphasis. */
  readonly actionable: boolean;
}

export function isInitialProviderAvailabilityLoading(
  loading: boolean,
  availabilityLoaded: boolean,
): boolean {
  return loading && !availabilityLoaded;
}

const PROVIDER_DISPLAY: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  gemini: "Gemini",
  cursor: "Cursor",
  opencode: "OpenCode",
};

/**
 * Roll an `AgentAvailability` row + the user's enable toggle into the strings
 * the renderer paints under a provider card. Precedence intentionally matches
 * `computeHealthStatus` on the server so client-only fallback (when the
 * server didn't ship `status`) agrees with the live status when it does.
 */
export function getProviderSummary(
  a: AgentAvailability | undefined,
  enabled: boolean,
  loading: boolean,
): ProviderSummary {
  if (a === undefined) {
    return loading
      ? {
          statusKey: "loading",
          headline: "Checking…",
          detail: null,
          authEmail: null,
          actionable: false,
        }
      : {
          statusKey: "warning",
          headline: "Checking provider status",
          detail: "Waiting for the server to report install + auth state.",
          authEmail: null,
          actionable: false,
        };
  }
  const name = PROVIDER_DISPLAY[a.providerId];
  if (!enabled) {
    return {
      statusKey: "disabled",
      headline: "Disabled",
      detail: null,
      authEmail: null,
      actionable: false,
    };
  }
  if (!a.cliInstalled) {
    return {
      statusKey: "error",
      headline: "Not installed",
      detail: a.statusMessage ?? `${name} CLI not detected on PATH.`,
      authEmail: null,
      actionable: true,
    };
  }
  if (a.cliVersionStatus === "outdated") {
    return {
      statusKey: "warning",
      headline: "Update required",
      detail:
        a.statusMessage ??
        `${name} ${a.cliVersion ?? ""} below ${a.cliVersionMinRequired ?? "minimum"}.`,
      authEmail: null,
      actionable: true,
    };
  }
  if (a.authStatus === "authenticated") {
    const subscription = a.authLabel ?? null;
    return {
      statusKey: "ready",
      headline: a.authEmail
        ? "Authenticated as"
        : subscription
          ? `Authenticated · ${subscription}`
          : "Authenticated",
      detail: a.authEmail ? subscription : null,
      authEmail: a.authEmail ?? null,
      actionable: false,
    };
  }
  if (a.authStatus === "unauthenticated") {
    return {
      statusKey: "warning",
      headline: "Sign in required",
      detail: a.statusMessage ?? `Run the ${name} login command to continue.`,
      authEmail: null,
      actionable: true,
    };
  }
  if (a.cliLoggedIn || a.hasApiKey) {
    return {
      statusKey: "warning",
      headline: "Available",
      detail:
        a.statusMessage ??
        (a.hasApiKey ? "API key set." : "Credentials found — not yet verified."),
      authEmail: null,
      actionable: false,
    };
  }
  return {
    statusKey: "warning",
    headline: "Needs attention",
    detail:
      a.statusMessage ?? "Installed, but the server could not verify auth.",
    authEmail: null,
    actionable: true,
  };
}

/**
 * Format a CLI version string for display. Prefixes a bare `1.2.3` with `v`
 * so cards render consistently regardless of which CLI is reporting.
 */
export function formatVersionLabel(
  version: string | null | undefined,
): string | null {
  if (!version) return null;
  const trimmed = version.trim();
  if (trimmed.length === 0) return null;
  if (/^v\d/.test(trimmed)) return trimmed;
  if (/^\d/.test(trimmed)) return `v${trimmed}`;
  return trimmed;
}
