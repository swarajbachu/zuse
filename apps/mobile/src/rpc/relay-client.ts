import { Schema } from "effect";
import {
  RelayAccessToken,
  RelayConnectGrant,
  RelayEnvironmentList,
  RelayEnvironmentStatus,
  RelayPaths,
} from "@zuse/wire";

import { relayBaseUrl } from "../auth/config.ts";
import { devicePublicJwk, signDpopProof } from "../auth/dpop.ts";
import { getAccessToken as getWorkosToken } from "../auth/workos.ts";
import {
  logConnectionDiagnostic,
  logConnectionProblem,
} from "./connection-diagnostics";
import { normalizeRelayError } from "./relay-errors";

/**
 * Client for the account relay's HTTP API. WorkOS-authenticated endpoints
 * (list) take the WorkOS bearer; DPoP-protected endpoints (status/connect/
 * register) take a relay-minted access token + a fresh DPoP proof per request.
 */

let accessToken: { readonly token: string; readonly expiresAtMs: number } | null =
  null;

const decodeList = Schema.decodeUnknownPromise(RelayEnvironmentList);
const decodeStatus = Schema.decodeUnknownPromise(RelayEnvironmentStatus);
const decodeGrant = Schema.decodeUnknownPromise(RelayConnectGrant);
const decodeAccess = Schema.decodeUnknownPromise(RelayAccessToken);

const url = (path: string): string => `${relayBaseUrl()}${path}`;

const relayError = async (
  response: Response,
  prefix: string,
): Promise<Error> => {
  const text = await response.text().catch(() => "");
  return new Error(normalizeRelayError(response.status, text, prefix));
};

const ensureAccessToken = async (): Promise<string> => {
  if (accessToken !== null && accessToken.expiresAtMs - Date.now() > 30_000) {
    logConnectionDiagnostic("relay.dpop_token.cache_hit", {
      expiresAtMs: accessToken.expiresAtMs,
    });
    return accessToken.token;
  }
  logConnectionDiagnostic("relay.dpop_token.refresh.start");
  const workosToken = await getWorkosToken();
  const target = url(RelayPaths.dpopToken);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workosToken}`,
      dpop: await signDpopProof({ method: "POST", url: target }),
    },
  });
  if (!response.ok) {
    const error = await relayError(response, "relay_dpop_token");
    logConnectionProblem("relay.dpop_token.refresh.fail", {
      reason: error.message,
    });
    throw error;
  }
  const grant = await decodeAccess(await response.json());
  accessToken = {
    token: grant.accessToken,
    expiresAtMs: Date.now() + grant.expiresIn,
  };
  logConnectionDiagnostic("relay.dpop_token.refresh.ok", {
    expiresIn: grant.expiresIn,
    expiresAtMs: accessToken.expiresAtMs,
  });
  return grant.accessToken;
};

const dpopFetch = async (path: string, method: string): Promise<Response> => {
  const token = await ensureAccessToken();
  const target = url(path);
  logConnectionDiagnostic("relay.request.start", { method, path });
  return fetch(target, {
    method,
    headers: {
      authorization: `DPoP ${token}`,
      dpop: await signDpopProof({ method, url: target }),
    },
  });
};

export const listEnvironments = async (): Promise<RelayEnvironmentList> => {
  const workosToken = await getWorkosToken();
  logConnectionDiagnostic("relay.list.start");
  const response = await fetch(url(RelayPaths.environments), {
    headers: { authorization: `Bearer ${workosToken}` },
  });
  if (!response.ok) {
    const error = await relayError(response, "relay_list");
    logConnectionProblem("relay.list.fail", { reason: error.message });
    throw error;
  }
  const decoded = await decodeList(await response.json());
  logConnectionDiagnostic("relay.list.ok", {
    environments: decoded.environments.length,
  });
  return decoded;
};

export const getEnvironmentStatus = async (
  environmentId: string,
): Promise<RelayEnvironmentStatus> => {
  const response = await dpopFetch(RelayPaths.status(environmentId), "POST");
  if (!response.ok) {
    const error = await relayError(response, "relay_status");
    logConnectionProblem("relay.status.fail", {
      environmentId,
      reason: error.message,
    });
    throw error;
  }
  const decoded = await decodeStatus(await response.json());
  logConnectionDiagnostic("relay.status.ok", {
    environmentId,
    status: decoded.status,
    wsBaseUrl: decoded.endpoint.wsBaseUrl,
  });
  return decoded;
};

export const connectEnvironment = async (
  environmentId: string,
): Promise<RelayConnectGrant> => {
  const response = await dpopFetch(RelayPaths.connect(environmentId), "POST");
  if (!response.ok) {
    const error = await relayError(response, "relay_connect");
    logConnectionProblem("relay.connect.fail", {
      environmentId,
      reason: error.message,
    });
    throw error;
  }
  const decoded = await decodeGrant(await response.json());
  logConnectionDiagnostic("relay.connect.ok", {
    environmentId,
    wsBaseUrl: decoded.endpoint.wsBaseUrl,
    expiresAt: decoded.expiresAt,
  });
  return decoded;
};

export const registerDevice = async (input: {
  readonly deviceId: string;
  readonly platform: "ios" | "android";
  readonly pushToken?: string;
}): Promise<void> => {
  const token = await ensureAccessToken();
  const target = url(RelayPaths.devices);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `DPoP ${token}`,
      dpop: await signDpopProof({ method: "POST", url: target }),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      deviceId: input.deviceId,
      platform: input.platform,
      pushToken: input.pushToken,
      dpopJwk: await devicePublicJwk(),
    }),
  });
  if (!response.ok) throw await relayError(response, "relay_register");
  logConnectionDiagnostic("relay.register_device.ok", {
    platform: input.platform,
    hasPushToken: input.pushToken !== undefined,
  });
};

export const resetRelayAccessToken = (): void => {
  logConnectionDiagnostic("relay.dpop_token.reset");
  accessToken = null;
};
