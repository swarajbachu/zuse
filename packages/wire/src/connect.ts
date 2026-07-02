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
  }),
  success: Schema.Void,
  error: ConnectAuthError,
});
