import { ApiPaths, CloudApiKeyCreateRequest } from "@zuse/contracts";
import { Clock, Effect } from "effect";
import { requireWorkos } from "./auth.ts";
import { type BetaAccess, requireCloudBetaAccess } from "./beta-access.ts";
import {
	type ApiKeyRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { randomBase62Token, randomToken, sha256Hex } from "./crypto.ts";
import { type ApiError, badRequest, notFound } from "./errors.ts";
import { decodeBody, decodePathSegment, json } from "./http.ts";
import type { WorkosVerifier } from "./workos.ts";

export type ApiKeyRouteContext =
	| CloudWorkspaceStore
	| WorkosVerifier
	| BetaAccess;

/** Number of secret characters echoed back for display (`zk_` + 9). */
const API_KEY_PREFIX_LENGTH = 12;

const publicApiKey = (key: ApiKeyRecord) => ({
	keyId: key.keyId,
	name: key.name,
	prefix: key.prefix,
	createdAt: key.createdAtMs,
	lastUsedAt: key.lastUsedAtMs ?? null,
	revokedAt: key.revokedAtMs ?? null,
});

/**
 * WorkOS-gated management surface for public-API keys. The `zk_` secret is
 * returned exactly once at creation; only its SHA-256 hash is stored.
 */
export const routeApiKeyRequest = (
	request: Request,
): Effect.Effect<Response | null, ApiError, ApiKeyRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		if (!path.startsWith(ApiPaths.cloudApiKeys)) return null;
		const store = yield* CloudWorkspaceStore;
		const nowMs = yield* Clock.currentTimeMillis;
		const principal = yield* requireWorkos(request);

		if (method === "GET" && path === ApiPaths.cloudApiKeys) {
			const keys = yield* store.listApiKeys(principal.accountId);
			return json({ keys: keys.map(publicApiKey) });
		}

		if (method === "POST" && path === ApiPaths.cloudApiKeys) {
			yield* requireCloudBetaAccess(principal.accountId);
			const body = yield* decodeBody(CloudApiKeyCreateRequest, request);
			const name = body.name.trim();
			if (name.length === 0 || name.length > 100)
				return yield* Effect.fail(badRequest("invalid_api_key_name"));
			const secret = yield* randomBase62Token("zk", 32);
			const key: ApiKeyRecord = {
				keyId: yield* randomToken("key", 8),
				accountId: principal.accountId,
				name,
				secretHash: yield* sha256Hex(secret),
				prefix: secret.slice(0, API_KEY_PREFIX_LENGTH),
				createdAtMs: nowMs,
			};
			yield* store.createApiKey(key);
			return json({ key: publicApiKey(key), secret }, 201);
		}

		const keyMatch = /^\/v1\/cloud\/api-keys\/([^/]+)$/u.exec(path);
		if (method === "DELETE" && keyMatch !== null) {
			const keyId = yield* decodePathSegment(keyMatch[1] ?? "");
			const revoked = yield* store.revokeApiKey(
				principal.accountId,
				keyId,
				nowMs,
			);
			if (revoked === null)
				return yield* Effect.fail(notFound("api_key_not_found"));
			return json(publicApiKey(revoked));
		}

		return null;
	});
