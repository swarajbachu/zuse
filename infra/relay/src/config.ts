import { Context, Layer, Redacted } from "effect";

/**
 * Relay configuration, provided once at Worker start from the environment
 * bindings (see worker.ts). Kept as a service so tests can supply fakes.
 *
 * - `relayIssuer` — this relay's canonical URL; goes into tokens/challenges as
 *   `iss`/`aud` and is echoed to clients.
 * - `workosJwksUrl` / `workosIssuer` — used to verify the WorkOS access tokens
 *   presented by signed-in clients (desktop + mobile).
 * - `mintPrivateKey` / `mintPublicKey` — Ed25519 keypair the relay uses to sign
 *   short-lived DPoP-bound access tokens and connect tokens. The public key is
 *   handed to environments so they can verify relay-minted tokens.
 * - `connectTokenTtlMs` / `accessTokenTtlMs` — lifetimes for minted tokens.
 * - `presenceStaleMs` — an environment with no heartbeat within this window is
 *   reported offline.
 * - `managedTunnel` — Cloudflare credentials for provisioning a per-environment
 *   named tunnel. Absent (all creds unset) → managed tunnels are disabled and
 *   the relay falls back to the LAN endpoint the desktop advertises.
 */
export interface ManagedTunnelConfig {
  readonly cfApiToken: Redacted.Redacted<string>;
  readonly cfAccountId: string;
  readonly cfZoneId: string;
  /** Apex/base domain the tunnel hostnames live under, e.g. `t.stuff.md`. */
  readonly baseDomain: string;
  /** Prefix that namespaces tunnel/hostnames per deployment, e.g. `zenv`. */
  readonly namespace: string;
}

export interface RelayConfig {
  readonly relayIssuer: string;
  readonly workosJwksUrl: string;
  readonly workosIssuer: string;
  readonly mintPrivateKey: Redacted.Redacted<string>;
  readonly mintPublicKey: string;
  readonly challengeTtlMs: number;
  readonly connectTokenTtlMs: number;
  readonly accessTokenTtlMs: number;
  readonly presenceStaleMs: number;
  readonly managedTunnel?: ManagedTunnelConfig;
}

export class RelayConfiguration extends Context.Tag(
  "@zuse/relay/RelayConfiguration",
)<RelayConfiguration, RelayConfig>() {}

const DEFAULTS = {
  challengeTtlMs: 5 * 60 * 1000,
  connectTokenTtlMs: 60 * 1000,
  accessTokenTtlMs: 30 * 60 * 1000,
  presenceStaleMs: 90 * 1000,
} as const;

export const layer = (
  config: Omit<RelayConfig, keyof typeof DEFAULTS> &
    Partial<Pick<RelayConfig, keyof typeof DEFAULTS>>,
): Layer.Layer<RelayConfiguration> =>
  Layer.succeed(RelayConfiguration, { ...DEFAULTS, ...config });
