import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	SessionStoreLive,
	sessionBundleMatchesClient,
	sessionLockIsStale,
} from "../../src/auth/layers/session-store.ts";
import { SessionStore } from "../../src/auth/services/session-store.ts";

const fakeJwt = (clientId: string): string => {
	const payload = Buffer.from(
		JSON.stringify({
			iss: "https://api.workos.com/",
			client_id: clientId,
		}),
	).toString("base64url");
	return `header.${payload}.signature`;
};

const bundleFor = (clientId: string) => ({
	accessToken: fakeJwt(clientId),
	refreshToken: "refresh-token",
	expiresAt: Date.now() + 300_000,
	refreshedAt: Date.now(),
	organizationId: null,
	user: {
		id: "user-1",
		email: "user@example.test",
		firstName: null,
		lastName: null,
		profilePictureUrl: null,
	},
});

const withStore = <A>(
	run: (store: SessionStore["Service"]) => Effect.Effect<A, unknown>,
): Promise<A> =>
	Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* SessionStore;
			return yield* run(store);
		}).pipe(Effect.provide(SessionStoreLive)) as Effect.Effect<A>,
	);

describe("session store client partitioning", () => {
	let authDir: string;
	const previousAuthDir = process.env.ZUSE_AUTH_DIR;
	const previousClientId = process.env.WORKOS_CLIENT_ID;

	beforeEach(async () => {
		authDir = await mkdtemp(join(tmpdir(), "zuse-session-store-"));
		process.env.ZUSE_AUTH_DIR = authDir;
		process.env.WORKOS_CLIENT_ID = "client_test_staging";
	});

	afterEach(async () => {
		if (previousAuthDir === undefined) delete process.env.ZUSE_AUTH_DIR;
		else process.env.ZUSE_AUTH_DIR = previousAuthDir;
		if (previousClientId === undefined) delete process.env.WORKOS_CLIENT_ID;
		else process.env.WORKOS_CLIENT_ID = previousClientId;
		await rm(authDir, { recursive: true, force: true });
	});

	it("identifies which WorkOS client minted an access token", () => {
		expect(
			sessionBundleMatchesClient(
				fakeJwt("client_test_staging"),
				"client_test_staging",
			),
		).toBe(true);
		expect(
			sessionBundleMatchesClient(
				fakeJwt("client_test_production"),
				"client_test_staging",
			),
		).toBe(false);
		expect(sessionBundleMatchesClient("not-a-jwt", "client_test_staging")).toBe(
			false,
		);
		const legacyIssuerToken = `header.${Buffer.from(
			JSON.stringify({
				iss: "https://api.workos.com/user_management/client_test_staging",
			}),
		).toString("base64url")}.signature`;
		expect(
			sessionBundleMatchesClient(legacyIssuerToken, "client_test_staging"),
		).toBe(true);
	});

	it("does not steal an old lock from a still-running refresh owner", () => {
		expect(
			sessionLockIsStale(
				JSON.stringify({
					pid: process.pid,
					createdAt: Date.now() - 600_000,
				}),
			),
		).toBe(false);
		expect(
			sessionLockIsStale(
				JSON.stringify({
					pid: 99_999_999,
					createdAt: Date.now(),
				}),
			),
		).toBe(true);
	});

	it("stores each client's session in its own file", async () => {
		const bundle = bundleFor("client_test_staging");
		await withStore((store) => store.write(bundle));
		const raw = JSON.parse(
			await readFile(join(authDir, "auth-client_test_staging.json"), "utf8"),
		) as { readonly refreshToken?: string };
		expect(raw.refreshToken).toBe("refresh-token");
		const read = await withStore((store) => store.read());
		expect(read?.user.id).toBe("user-1");
	});

	it("adopts a legacy shared session minted by its own client and retires the file", async () => {
		await writeFile(
			join(authDir, "auth.json"),
			JSON.stringify(bundleFor("client_test_staging")),
		);
		const read = await withStore((store) => store.read());
		expect(read?.user.id).toBe("user-1");
		await expect(
			readFile(join(authDir, "auth.json"), "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
		const migrated = await readFile(
			join(authDir, "auth-client_test_staging.json"),
			"utf8",
		);
		expect(JSON.parse(migrated)).toMatchObject({
			refreshToken: "refresh-token",
		});
	});

	it("leaves a legacy session from another identity environment untouched", async () => {
		await writeFile(
			join(authDir, "auth.json"),
			JSON.stringify(bundleFor("client_test_production")),
		);
		const read = await withStore((store) => store.read());
		expect(read).toBeNull();
		const legacy = await readFile(join(authDir, "auth.json"), "utf8");
		expect(JSON.parse(legacy)).toMatchObject({ refreshToken: "refresh-token" });
	});

	it("clearing one client's session never touches another environment's file", async () => {
		await writeFile(
			join(authDir, "auth.json"),
			JSON.stringify(bundleFor("client_test_production")),
		);
		await withStore((store) => store.write(bundleFor("client_test_staging")));
		await withStore((store) => store.clear());
		expect(await withStore((store) => store.read())).toBeNull();
		const legacy = await readFile(join(authDir, "auth.json"), "utf8");
		expect(JSON.parse(legacy)).toMatchObject({ refreshToken: "refresh-token" });
	});
});
