import type { CloudAuthMethod, CloudAuthProvider } from "@zuse/contracts";
import { sealCloudAuthSecret } from "@zuse/utils/cloud-auth-crypto";
import { Effect } from "effect";
import { cloudControlClientForWorkspace } from "~/rpc/api-client";
import { cloudCatalogAtom, cloudWorkspaceAdminSnapshot } from "./cloud-catalog";
import { appAtomRegistry } from "./registry";

/** One form owns one workspace epoch, including encryption and device-login polling. */
export const createCloudAuthController = () => {
	const snapshot = cloudWorkspaceAdminSnapshot();
	const scope = snapshot.scope;
	const isCurrent = snapshot.isCurrent;
	const assertCurrent = () => {
		if (!isCurrent())
			throw new Error("Workspace access changed. Reopen Cloud Authentication.");
	};
	assertCurrent();
	const client = cloudControlClientForWorkspace(scope);
	const run = async <A, E>(request: () => Effect.Effect<A, E>) => {
		assertCurrent();
		const result = await Effect.runPromise(request());
		assertCurrent();
		return result;
	};
	return {
		isCurrent,
		poll: (operationId: string) =>
			run(() => client["cloud.auth.login.poll"]({ operationId })),
		cancel: (operationId: string) =>
			run(() => client["cloud.auth.login.cancel"]({ operationId })),
		updateImage: () =>
			run(() =>
				client["cloud.image.build"]({
					mode: "update",
					idempotencyKey: crypto.randomUUID(),
				}),
			),
		configure: async (
			providerId: CloudAuthProvider,
			method: CloudAuthMethod,
			secret: string,
		) => {
			assertCurrent();
			if (
				method === "subscription" &&
				(providerId === "codex" || providerId === "grok")
			)
				return run(() => client["cloud.auth.login.start"]({ providerId }));
			const auth = appAtomRegistry.get(cloudCatalogAtom).auth;
			const status =
				auth?.encryptionPublicJwk === undefined
					? await run(() => client["cloud.auth.provision"]())
					: auth;
			if (
				status.encryptionPublicJwk === undefined ||
				status.encryptionKeyId === undefined
			)
				throw new Error(
					"Cloud Authentication is still preparing. Try again shortly.",
				);
			const ciphertext = await sealCloudAuthSecret(
				status.encryptionPublicJwk,
				secret.trim(),
			);
			const keyId = status.encryptionKeyId;
			await run(() =>
				client["cloud.auth.configure"]({
					providerId,
					method,
					sealedSecret: { keyId, ciphertext },
				}),
			);
			return null;
		},
	};
};
