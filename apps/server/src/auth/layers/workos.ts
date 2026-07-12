import { createHash, randomBytes } from "node:crypto";

import { Effect } from "effect";

import { AuthTokenError } from "../errors.ts";

/**
 * Thin WorkOS User Management REST client for the PKCE public-client flow.
 * Deliberately uses raw `fetch` rather than `@workos-inc/node`: the SDK's
 * `authenticateWithCode` is oriented around confidential clients with an API
 * key, whereas a desktop app is a PUBLIC client — it proves possession with a
 * `code_verifier` and ships no secret (the binary is decompilable). The REST
 * endpoint accepts exactly that: `code_verifier` is required when
 * `client_secret` is absent. Keeping it dependency-free also avoids bundling
 * concerns in the Electron main bundle.
 */

const WORKOS_API = "https://api.workos.com";

const base64url = (buf: Buffer): string => buf.toString("base64url");

/** RFC 7636 PKCE pair + an anti-CSRF `state` nonce. */
export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly state: string;
}

export const makePkce = (): PkcePair => {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  return { verifier, challenge, state };
};

/**
 * Build the hosted-AuthKit authorization URL the system browser opens. The
 * `redirectUri` is supplied by the host shell (Electron uses a localhost
 * loopback in dev/prod; a future mobile shell uses its own scheme) and must
 * exactly match an entry in the WorkOS dashboard.
 */
export const authorizationUrl = (
  clientId: string,
  challenge: string,
  state: string,
  redirectUri: string,
): string => {
  const url = new URL(`${WORKOS_API}/user_management/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("provider", "authkit");
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
};

/** Raw REST shape (snake_case) returned by `/user_management/authenticate`. */
interface WorkosAuthenticateResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly organization_id?: string | null;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly first_name?: string | null;
    readonly last_name?: string | null;
    readonly profile_picture_url?: string | null;
  };
}

interface WorkosErrorResponse {
  readonly error?: string;
  readonly error_description?: string;
  readonly code?: string;
}

const parseWorkosErrorCode = (raw: string): "invalid_grant" | undefined => {
  try {
    const parsed = JSON.parse(raw) as WorkosErrorResponse;
    const code = parsed.error ?? parsed.code;
    return code === "invalid_grant" ? "invalid_grant" : undefined;
  } catch {
    return raw.includes("invalid_grant") ? "invalid_grant" : undefined;
  }
};

const parseAuthenticateResponse = (
  value: unknown,
): WorkosAuthenticateResponse => {
  if (typeof value !== "object" || value === null) {
    throw new Error("WorkOS authenticate response was not an object.");
  }
  const obj = value as Partial<WorkosAuthenticateResponse>;
  const user = obj.user;
  if (typeof obj.access_token !== "string" || obj.access_token === "") {
    throw new Error("WorkOS authenticate response was missing access_token.");
  }
  if (typeof obj.refresh_token !== "string" || obj.refresh_token === "") {
    throw new Error("WorkOS authenticate response was missing refresh_token.");
  }
  if (typeof user !== "object" || user === null) {
    throw new Error("WorkOS authenticate response was missing user.");
  }
  if (typeof user.id !== "string" || user.id === "") {
    throw new Error("WorkOS authenticate response was missing user.id.");
  }
  if (typeof user.email !== "string" || user.email === "") {
    throw new Error("WorkOS authenticate response was missing user.email.");
  }
  return {
    access_token: obj.access_token,
    refresh_token: obj.refresh_token,
    organization_id: obj.organization_id ?? null,
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      profile_picture_url: user.profile_picture_url ?? null,
    },
  };
};

/** The normalized bundle we persist (keychain) and reason about internally. */
export interface SessionBundle {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly refreshedAt: number;
  readonly organizationId: string | null;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly firstName: string | null;
    readonly lastName: string | null;
    readonly profilePictureUrl: string | null;
  };
}

export const parseSessionBundle = (value: unknown): SessionBundle | null => {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Partial<SessionBundle>;
  const user = obj.user;
  if (
    typeof obj.accessToken !== "string" ||
    typeof obj.refreshToken !== "string" ||
    typeof obj.expiresAt !== "number" ||
    typeof user !== "object" ||
    user === null ||
    typeof user.id !== "string"
  ) {
    return null;
  }
  return {
    accessToken: obj.accessToken,
    refreshToken: obj.refreshToken,
    expiresAt: obj.expiresAt,
    refreshedAt:
      typeof obj.refreshedAt === "number" && Number.isFinite(obj.refreshedAt)
        ? obj.refreshedAt
        : 0,
    organizationId:
      typeof obj.organizationId === "string" ? obj.organizationId : null,
    user: {
      id: user.id,
      email: typeof user.email === "string" ? user.email : "",
      firstName: typeof user.firstName === "string" ? user.firstName : null,
      lastName: typeof user.lastName === "string" ? user.lastName : null,
      profilePictureUrl:
        typeof user.profilePictureUrl === "string"
          ? user.profilePictureUrl
          : null,
    },
  };
};

/**
 * Read `exp` from a JWT access token without verifying the signature — we only
 * need it to schedule refresh-on-demand; the token's authority is enforced
 * server-side wherever it's later presented as a bearer. Falls back to a short
 * 5-minute window if the token can't be parsed.
 */
const expiryFromJwt = (jwt: string): number => {
  const fallback = Date.now() + 5 * 60_000;
  const parts = jwt.split(".");
  if (parts.length < 2 || parts[1] === undefined) return fallback;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : fallback;
  } catch {
    return fallback;
  }
};

const toBundle = (res: WorkosAuthenticateResponse): SessionBundle => ({
  accessToken: res.access_token,
  refreshToken: res.refresh_token,
  expiresAt: expiryFromJwt(res.access_token),
  refreshedAt: Date.now(),
  organizationId: res.organization_id ?? null,
  user: {
    id: res.user.id,
    email: res.user.email,
    firstName: res.user.first_name ?? null,
    lastName: res.user.last_name ?? null,
    profilePictureUrl: res.user.profile_picture_url ?? null,
  },
});

const authenticate = (
  body: Record<string, string>,
): Effect.Effect<SessionBundle, AuthTokenError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${WORKOS_API}/user_management/authenticate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err = new Error(`WorkOS ${res.status}: ${text.slice(0, 500)}`);
        Object.assign(err, { workosCode: parseWorkosErrorCode(text) });
        throw err;
      }
      return parseAuthenticateResponse(await res.json());
    },
    catch: (cause) =>
      new AuthTokenError({
        reason:
          cause instanceof Error && cause.name === "TimeoutError"
            ? "WorkOS request timed out."
            : cause instanceof Error
              ? cause.message
              : String(cause),
        code:
          cause instanceof Error &&
          (cause as { workosCode?: unknown }).workosCode === "invalid_grant"
            ? "invalid_grant"
            : undefined,
        cause,
      }),
  }).pipe(Effect.map(toBundle));

/** Exchange an authorization `code` + PKCE `verifier` for a session. */
export const exchangeCode = (
  clientId: string,
  code: string,
  verifier: string,
): Effect.Effect<SessionBundle, AuthTokenError> =>
  authenticate({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
  });

/** Mint a fresh session from a refresh token. */
export const refreshSession = (
  clientId: string,
  refreshToken: string,
): Effect.Effect<SessionBundle, AuthTokenError> =>
  authenticate({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

/** Parse the `code`/`state`/`error` out of a `zuse://auth/callback` URL. */
export const parseCallbackUrl = (
  raw: string,
): { code: string | null; state: string | null; error: string | null } => {
  try {
    const url = new URL(raw);
    const params = url.searchParams;
    const error = params.get("error_description") ?? params.get("error");
    return {
      code: params.get("code"),
      state: params.get("state"),
      error: error,
    };
  } catch {
    return { code: null, state: null, error: "Malformed callback URL." };
  }
};
