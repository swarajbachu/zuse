import { Context, Effect, Layer, Redacted } from "effect";

import { RelayConfiguration, type ManagedTunnelConfig } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { badRequest, forbidden, type RelayError } from "./errors.ts";

/**
 * Provisions a per-environment Cloudflare **named tunnel** so the phone can
 * reach a laptop from anywhere. On link we: create-or-find a named tunnel,
 * push its ingress config (hostname → the desktop's loopback WS origin), point
 * a DNS CNAME at it, and hand the desktop a connector token to run `cloudflared`
 * with. The relay only sets up the route; **no chat bytes ever traverse it** —
 * the data path is phone ↔ Cloudflare edge ↔ the desktop connector.
 *
 * Disabled when {@link ManagedTunnelConfig} is absent (`enabled === false`); the
 * relay then falls back to the LAN endpoint the desktop advertises.
 */
export interface TunnelProvisionResult {
  readonly tunnelHostname: string;
  readonly tunnelId: string;
  readonly dnsRecordId?: string;
  readonly connectorToken: string;
}

export interface ManagedTunnelProviderApi {
  readonly enabled: boolean;
  readonly provision: (input: {
    readonly accountId: string;
    readonly environmentId: string;
    readonly origin: { readonly localHttpHost: string; readonly localHttpPort: number };
  }) => Effect.Effect<TunnelProvisionResult, RelayError>;
  readonly deprovision: (input: {
    readonly tunnelId: string;
    readonly dnsRecordId?: string;
  }) => Effect.Effect<void, RelayError>;
}

export class ManagedTunnelProvider extends Context.Tag(
  "@zuse/relay/ManagedTunnelProvider",
)<ManagedTunnelProvider, ManagedTunnelProviderApi>() {}

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<A> {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<{ readonly code: number; readonly message: string }>;
  readonly result: A;
}

const cf = <A>(
  config: ManagedTunnelConfig,
  method: string,
  path: string,
  body?: unknown,
): Effect.Effect<A, RelayError> =>
  Effect.tryPromise({
    try: async (): Promise<A> => {
      const response = await fetch(`${CF_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${Redacted.value(config.cfApiToken)}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = (await response.json()) as CfEnvelope<A>;
      if (!response.ok || payload.success !== true) {
        const detail =
          payload.errors?.map((error) => `${error.code}:${error.message}`).join(", ") ??
          `http_${response.status}`;
        throw new Error(detail);
      }
      return payload.result;
    },
    catch: (cause) =>
      forbidden(
        "tunnel_provision_failed",
        cause instanceof Error ? cause.message : String(cause),
      ),
  });

/** Deterministic per-(account,environment) tunnel name so re-links are idempotent. */
const deriveNames = (
  config: ManagedTunnelConfig,
  accountId: string,
  environmentId: string,
): Effect.Effect<{ readonly tunnelName: string; readonly hostname: string }> =>
  sha256Hex(`${config.namespace}:${accountId}:${environmentId}`).pipe(
    Effect.map((digest) => {
      const hash = digest.slice(0, 32);
      const tunnelName = `${config.namespace}-${hash}`;
      return { tunnelName, hostname: `${tunnelName}.${config.baseDomain}` };
    }),
  );

interface CfTunnel {
  readonly id: string;
  readonly name: string;
}

interface CfDnsRecord {
  readonly id: string;
  readonly name: string;
}

export const ManagedTunnelProviderLive: Layer.Layer<
  ManagedTunnelProvider,
  never,
  RelayConfiguration
> = Layer.effect(
  ManagedTunnelProvider,
  Effect.gen(function* () {
    const { managedTunnel } = yield* RelayConfiguration;

    if (managedTunnel === undefined) {
      return ManagedTunnelProvider.of({
        enabled: false,
        provision: () =>
          Effect.fail(badRequest("managed_tunnel_disabled")),
        deprovision: () => Effect.void,
      });
    }

    const config = managedTunnel;

    const ensureTunnel = (tunnelName: string): Effect.Effect<CfTunnel, RelayError> =>
      Effect.gen(function* () {
        const existing = yield* cf<ReadonlyArray<CfTunnel>>(
          config,
          "GET",
          `/accounts/${config.cfAccountId}/cfd_tunnel?name=${encodeURIComponent(tunnelName)}&is_deleted=false`,
        );
        const found = existing.find((tunnel) => tunnel.name === tunnelName);
        if (found !== undefined) return found;
        return yield* cf<CfTunnel>(
          config,
          "POST",
          `/accounts/${config.cfAccountId}/cfd_tunnel`,
          { name: tunnelName, config_src: "cloudflare" },
        );
      });

    const configureIngress = (
      tunnelId: string,
      hostname: string,
      origin: { readonly localHttpHost: string; readonly localHttpPort: number },
    ): Effect.Effect<void, RelayError> =>
      cf<unknown>(
        config,
        "PUT",
        `/accounts/${config.cfAccountId}/cfd_tunnel/${tunnelId}/configurations`,
        {
          config: {
            ingress: [
              {
                hostname,
                service: `http://${origin.localHttpHost}:${origin.localHttpPort}`,
              },
              { service: "http_status:404" },
            ],
          },
        },
      ).pipe(Effect.asVoid);

    const ensureDns = (
      hostname: string,
      tunnelId: string,
    ): Effect.Effect<string, RelayError> =>
      Effect.gen(function* () {
        const content = `${tunnelId}.cfargotunnel.com`;
        const existing = yield* cf<ReadonlyArray<CfDnsRecord>>(
          config,
          "GET",
          `/zones/${config.cfZoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`,
        );
        const found = existing.find((record) => record.name === hostname);
        if (found !== undefined) {
          yield* cf<unknown>(
            config,
            "PUT",
            `/zones/${config.cfZoneId}/dns_records/${found.id}`,
            { type: "CNAME", name: hostname, content, proxied: true },
          );
          return found.id;
        }
        const created = yield* cf<CfDnsRecord>(
          config,
          "POST",
          `/zones/${config.cfZoneId}/dns_records`,
          { type: "CNAME", name: hostname, content, proxied: true },
        );
        return created.id;
      });

    const fetchConnectorToken = (tunnelId: string): Effect.Effect<string, RelayError> =>
      cf<string>(
        config,
        "GET",
        `/accounts/${config.cfAccountId}/cfd_tunnel/${tunnelId}/token`,
      );

    return ManagedTunnelProvider.of({
      enabled: true,
      provision: ({ accountId, environmentId, origin }) =>
        Effect.gen(function* () {
          const { tunnelName, hostname } = yield* deriveNames(
            config,
            accountId,
            environmentId,
          );
          const tunnel = yield* ensureTunnel(tunnelName);
          yield* configureIngress(tunnel.id, hostname, origin);
          const dnsRecordId = yield* ensureDns(hostname, tunnel.id);
          const connectorToken = yield* fetchConnectorToken(tunnel.id);
          return {
            tunnelHostname: hostname,
            tunnelId: tunnel.id,
            dnsRecordId,
            connectorToken,
          } satisfies TunnelProvisionResult;
        }),
      deprovision: ({ tunnelId, dnsRecordId }) =>
        Effect.gen(function* () {
          if (dnsRecordId !== undefined) {
            yield* cf<unknown>(
              config,
              "DELETE",
              `/zones/${config.cfZoneId}/dns_records/${dnsRecordId}`,
            ).pipe(Effect.ignore);
          }
          // `cascade` cleans up any lingering connections so the delete succeeds
          // even if a connector is still registered.
          yield* cf<unknown>(
            config,
            "DELETE",
            `/accounts/${config.cfAccountId}/cfd_tunnel/${tunnelId}?cascade=true`,
          ).pipe(Effect.ignore);
        }),
    });
  }),
);
