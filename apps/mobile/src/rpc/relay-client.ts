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
  const fallback = `${prefix}_${response.status}`;
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) return new Error(fallback);
  try {
    const body = JSON.parse(text) as { readonly error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) {
      return new Error(`${fallback}:${body.error}`);
    }
  } catch {
    // Non-JSON relay errors still get surfaced in truncated form.
  }
  return new Error(`${fallback}:${text.slice(0, 120)}`);
};

const ensureAccessToken = async (): Promise<string> => {
  if (accessToken !== null && accessToken.expiresAtMs - Date.now() > 30_000) {
    return accessToken.token;
  }
  const workosToken = await getWorkosToken();
  const target = url(RelayPaths.dpopToken);
  const response = await fetch(target, {
    method: "POST",
    headers: {
      authorization: `Bearer ${workosToken}`,
      dpop: await signDpopProof({ method: "POST", url: target }),
    },
  });
  if (!response.ok) throw await relayError(response, "relay_dpop_token");
  const grant = await decodeAccess(await response.json());
  accessToken = {
    token: grant.accessToken,
    expiresAtMs: Date.now() + grant.expiresIn,
  };
  return grant.accessToken;
};

const dpopFetch = async (path: string, method: string): Promise<Response> => {
  const token = await ensureAccessToken();
  const target = url(path);
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
  const response = await fetch(url(RelayPaths.environments), {
    headers: { authorization: `Bearer ${workosToken}` },
  });
  if (!response.ok) throw await relayError(response, "relay_list");
  return decodeList(await response.json());
};

export const getEnvironmentStatus = async (
  environmentId: string,
): Promise<RelayEnvironmentStatus> => {
  const response = await dpopFetch(RelayPaths.status(environmentId), "POST");
  if (!response.ok) throw await relayError(response, "relay_status");
  return decodeStatus(await response.json());
};

export const connectEnvironment = async (
  environmentId: string,
): Promise<RelayConnectGrant> => {
  const response = await dpopFetch(RelayPaths.connect(environmentId), "POST");
  if (!response.ok) throw await relayError(response, "relay_connect");
  return decodeGrant(await response.json());
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
};

export const resetRelayAccessToken = (): void => {
  accessToken = null;
};
