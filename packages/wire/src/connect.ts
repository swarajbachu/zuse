import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { EnvironmentId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Environment abstraction
// ---------------------------------------------------------------------------
//
// An *environment* is a host running `@zuse/server`. The same headless server
// binary runs on the laptop, on an SSH dev-box, or on a cloud container — only
// `providerKind` and the endpoint differ. Clients (desktop renderer, mobile,
// browser) pick an environment without caring where it physically runs, which
// is the seam that lets cloud-hosted worktrees drop in later with no client or
// server-core refactor.
//
// These types + RPC definitions lock that contract now. The local-pairing and
// cloud-link handlers (and registration into the RPC group) land with the
// auth/pairing and relay PRs; until then these are exported definitions only.

/**
 * Where an environment physically runs.
 * - `desktop`: on the user's machine (IPC in-process, or WS + tunnel for reach)
 * - `ssh`: on a remote dev-box, launched by the desktop and tunneled back
 * - `cloud`: on a cloud container/microVM, provisioned by the control plane
 */
export const ProviderKind = Schema.Literal("desktop", "ssh", "cloud");
export type ProviderKind = typeof ProviderKind.Type;

/** The reachable URLs for an environment's RPC surface. */
export class EnvironmentEndpoint extends Schema.Class<EnvironmentEndpoint>(
  "EnvironmentEndpoint",
)({
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
}) {}

export const AdvertisedEndpointProviderKind = Schema.Literal(
  "core",
  "tunnel",
  "manual",
  "private-network",
);
export type AdvertisedEndpointProviderKind =
  typeof AdvertisedEndpointProviderKind.Type;

export const AdvertisedEndpointReachability = Schema.Literal(
  "loopback",
  "lan",
  "public",
  "tunnel",
  "private-network",
);
export type AdvertisedEndpointReachability =
  typeof AdvertisedEndpointReachability.Type;

export const AdvertisedEndpointHostedHttpsCompatibility = Schema.Literal(
  "compatible",
  "mixed-content-blocked",
  "unknown",
);
export type AdvertisedEndpointHostedHttpsCompatibility =
  typeof AdvertisedEndpointHostedHttpsCompatibility.Type;

export const AdvertisedEndpointStatus = Schema.Literal(
  "available",
  "unavailable",
  "unknown",
);
export type AdvertisedEndpointStatus = typeof AdvertisedEndpointStatus.Type;

export const AdvertisedEndpointCompatibility = Schema.Struct({
  hostedHttpsApp: AdvertisedEndpointHostedHttpsCompatibility,
});
export type AdvertisedEndpointCompatibility =
  typeof AdvertisedEndpointCompatibility.Type;

export class AdvertisedEndpoint extends Schema.Class<AdvertisedEndpoint>(
  "AdvertisedEndpoint",
)({
  id: Schema.String,
  label: Schema.String,
  providerKind: AdvertisedEndpointProviderKind,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  reachability: AdvertisedEndpointReachability,
  compatibility: AdvertisedEndpointCompatibility,
  status: AdvertisedEndpointStatus,
  isDefault: Schema.Boolean,
}) {}

/**
 * Everything a client needs to identify and reach an environment. Keyed by
 * `environmentId` (never by "this laptop"), so the relay and clients treat
 * desktop / ssh / cloud uniformly.
 */
export class EnvironmentDescriptor extends Schema.Class<EnvironmentDescriptor>(
  "EnvironmentDescriptor",
)({
  environmentId: EnvironmentId,
  providerKind: ProviderKind,
  endpoint: EnvironmentEndpoint,
  advertisedEndpoints: Schema.optional(Schema.Array(AdvertisedEndpoint)),
  label: Schema.optional(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConnectAuthError extends Schema.TaggedError<ConnectAuthError>()(
  "ConnectAuthError",
  { reason: Schema.String },
) {}

// ---------------------------------------------------------------------------
// Connect / link RPC definitions (not yet registered in the RPC group)
// ---------------------------------------------------------------------------

/**
 * Describe this environment to a client that has already authenticated to it
 * (local bearer token over WS). Returns the descriptor the client stores in its
 * connection catalog.
 */
export const ConnectDescribeRpc = Rpc.make("connect.describe", {
  payload: Schema.Void,
  success: EnvironmentDescriptor,
  error: ConnectAuthError,
});

/**
 * Cloud-link step 1: the environment signs a relay-issued challenge with its
 * local bearer credential, proving control of the host. The signed proof is
 * submitted to the relay by the client to complete linking.
 */
export const ConnectLinkProofRpc = Rpc.make("connect.linkProof", {
  payload: Schema.Struct({
    challenge: Schema.String,
    relayIssuer: Schema.String,
    endpoint: EnvironmentEndpoint,
  }),
  success: Schema.Struct({ proof: Schema.String }),
  error: ConnectAuthError,
});

/**
 * Cloud-link step 2: persist relay-issued credentials on the environment so
 * future connections route through the managed endpoint without re-pairing.
 */
export const ConnectRelayConfigRpc = Rpc.make("connect.relayConfig", {
  payload: Schema.Struct({
    relayUrl: Schema.String,
    relayIssuer: Schema.String,
    environmentId: EnvironmentId,
    environmentCredential: Schema.String,
    mintPublicKey: Schema.optional(Schema.String),
  }),
  success: Schema.Void,
  error: ConnectAuthError,
});

// ---------------------------------------------------------------------------
// Relay link orchestration (renderer ↔ server)
// ---------------------------------------------------------------------------
//
// The desktop self-registers with the relay: because it is already
// WorkOS-signed-in and holds its Ed25519 identity, the server runs the whole
// link flow (challenge → sign → submit → persist → heartbeat). The renderer's
// "Devices" pane drives it with these RPCs.

/** Whether this environment is linked to a relay, plus how to describe it. */
export class RelayLinkStatus extends Schema.Class<RelayLinkStatus>(
  "RelayLinkStatus",
)({
  linked: Schema.Boolean,
  relayUrl: Schema.optional(Schema.String),
  environmentId: Schema.optional(EnvironmentId),
  label: Schema.optional(Schema.String),
  heartbeatActive: Schema.Boolean,
  advertisedEndpoints: Schema.optional(Schema.Array(AdvertisedEndpoint)),
}) {}

/** Link this environment to a relay under the signed-in WorkOS account. */
export const RelayLinkRpc = Rpc.make("relay.link", {
  payload: Schema.Struct({
    relayUrl: Schema.String,
    label: Schema.optional(Schema.String),
  }),
  success: RelayLinkStatus,
  error: ConnectAuthError,
});

/** Current relay link status. */
export const RelayStatusRpc = Rpc.make("relay.status", {
  payload: Schema.Void,
  success: RelayLinkStatus,
  error: ConnectAuthError,
});

/** Remove this environment's relay link. */
export const RelayUnlinkRpc = Rpc.make("relay.unlink", {
  payload: Schema.Void,
  success: Schema.Void,
  error: ConnectAuthError,
});
