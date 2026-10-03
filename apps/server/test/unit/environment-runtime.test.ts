import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthState, FolderId } from "@zuse/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("keytar", () => ({
	default: {
		getPassword: vi.fn(async () => null),
		setPassword: vi.fn(async () => {}),
		deletePassword: vi.fn(async () => true),
		findCredentials: vi.fn(async () => []),
	},
}));

import { AppPaths } from "../../src/app-paths.ts";
import { AuthTokenError } from "../../src/auth/errors.ts";
import { AuthService } from "../../src/auth/services/auth-service.ts";
import {
	EnvironmentRuntime,
	makeEnvironmentRuntimeLayer,
} from "../../src/environment/environment-runtime.ts";
import { CredentialsServiceLive } from "../../src/provider/layers/credentials-service.ts";
import { WorkspaceService } from "../../src/workspace/services/workspace-service.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0)) await dispose();
	vi.unstubAllGlobals();
});
const folderId = FolderId.make("folder-a");
async function harness() {
	const userData = await mkdtemp(join(tmpdir(), "zuse-env-test-"));
	const folder = {
		id: folderId,
		name: "Example",
		path: userData,
		addedAt: new Date(),
	};
	let state: AuthState = {
		_tag: "SignedIn",
		session: {
			user: {
				id: "account-a",
				email: "a@example.test",
				firstName: null,
				lastName: null,
				profilePictureUrl: null,
			},
			organizationId: null,
			expiresAt: Date.now() + 600_000,
		},
	};
	let tokenError: AuthTokenError | null = null;
	const paths = Layer.succeed(AppPaths, { userData });
	const auth = Layer.succeed(AuthService, {
		getSession: () => Effect.succeed(state),
		getAccessToken: () =>
			tokenError ? Effect.fail(tokenError) : Effect.succeed("test-token"),
		signIn: () => Effect.succeed(state),
		signOut: () =>
			Effect.sync(() => {
				state = { _tag: "SignedOut" };
			}),
		sessionChanges: () => Stream.empty,
	});
	const workspaces = Layer.succeed(WorkspaceService, {
		list: () => Effect.succeed([folder]),
		findById: (id) => Effect.succeed(id === folderId ? folder : null),
		add: () => Effect.succeed(folder),
		remove: () => Effect.void,
		getSelected: () => Effect.succeed(folderId),
		setSelected: () => Effect.void,
		streamChanges: () => Stream.empty,
	});
	const runtime = ManagedRuntime.make(
		makeEnvironmentRuntimeLayer(false).pipe(
			Layer.provide(auth),
			Layer.provide(workspaces),
			Layer.provide(paths),
			Layer.provide(CredentialsServiceLive.pipe(Layer.provide(paths))),
		),
	);
	disposers.push(async () => {
		await runtime.dispose();
		await rm(userData, { recursive: true, force: true });
	});
	const service = await runtime.runPromise(EnvironmentRuntime);
	await runtime.runPromise(service.link(folderId, "project-a"));
	return {
		userData,
		runtime,
		service,
		setTokenError: (error: AuthTokenError) => {
			tokenError = error;
		},
		signOut: () => {
			state = { _tag: "SignedOut" };
		},
	};
}
const payload = {
	revision: 3,
	values: { TOKEN: "launch-private-value" },
	secretNames: ["TOKEN"],
	sources: { TOKEN: "entry-a" },
	resolvedAt: 123,
};
describe("personal environment runtime", () => {
	test("preserves legacy offline launches before any managed project is configured", async () => {
		const h = await harness();
		await h.runtime.runPromise(h.service.link(folderId, null));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("offline");
			}),
		);
		expect(
			(await h.runtime.runPromise(h.service.resolve(h.userData, folderId)))
				.values,
		).toEqual({});
	});

	test("invalidates the offline copy after known vault changes", async () => {
		const h = await harness();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(payload)),
		);
		await h.runtime.runPromise(h.service.resolve(h.userData, folderId));
		await h.runtime.runPromise(h.service.invalidate ?? Effect.void);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("offline");
			}),
		);
		await expect(
			h.runtime.runPromise(h.service.resolve(h.userData, folderId)),
		).rejects.toThrow("no encrypted personal cache");
	});

	test("resolves per launch, encrypts the offline copy, and never changes process.env", async () => {
		const h = await harness();
		const fetch = vi.fn(async () => Response.json(payload));
		vi.stubGlobal("fetch", fetch);
		const before = process.env.TOKEN;
		const result = await h.runtime.runPromise(
			h.service.resolve(h.userData, folderId),
		);
		expect(result.values.TOKEN).toBe(payload.values.TOKEN);
		expect(result.offline).toBe(false);
		expect(process.env.TOKEN).toBe(before);
		expect(
			await readFile(join(h.userData, "secure-vault.json"), "utf8"),
		).not.toContain(payload.values.TOKEN);
		fetch.mockRejectedValueOnce(new TypeError("offline"));
		expect(
			await h.runtime.runPromise(h.service.resolve(h.userData, folderId)),
		).toMatchObject({ offline: true, resolvedAt: 123, values: payload.values });
	});
	test("authentication denial clears cache and never uses offline fallback", async () => {
		const h = await harness();
		const fetch = vi.fn(async () => Response.json(payload));
		vi.stubGlobal("fetch", fetch);
		await h.runtime.runPromise(h.service.resolve(h.userData, folderId));
		fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
		await expect(
			h.runtime.runPromise(h.service.resolve(h.userData, folderId)),
		).rejects.toBeDefined();
		fetch.mockRejectedValueOnce(new TypeError("offline"));
		await expect(
			h.runtime.runPromise(h.service.resolve(h.userData, folderId)),
		).rejects.toBeDefined();
	});
	test("network-only token refresh failures allow cache, invalid grants do not", async () => {
		const h = await harness();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(payload)),
		);
		await h.runtime.runPromise(h.service.resolve(h.userData, folderId));
		h.setTokenError(new AuthTokenError({ reason: "network", code: "network" }));
		expect(
			(await h.runtime.runPromise(h.service.resolve(h.userData, folderId)))
				.offline,
		).toBe(true);
		h.setTokenError(
			new AuthTokenError({ reason: "revoked", code: "invalid_grant" }),
		);
		await expect(
			h.runtime.runPromise(h.service.resolve(h.userData, folderId)),
		).rejects.toBeDefined();
	});
	test("signed-out execution cannot read an account's cached values", async () => {
		const h = await harness();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(payload)),
		);
		await h.runtime.runPromise(h.service.resolve(h.userData, folderId));
		h.signOut();
		expect(
			(await h.runtime.runPromise(h.service.resolve(h.userData, folderId)))
				.values,
		).toEqual({});
	});
});
