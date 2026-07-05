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
 */
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
