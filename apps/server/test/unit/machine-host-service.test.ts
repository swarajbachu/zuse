import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MachineRuntimeStatus, MachineSshKey } from "@zuse/contracts";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { AppPaths } from "../../src/app-paths.ts";
import {
	MachineHostService,
	MachineHostServiceLive,
	MachinePrivateEndpointPublisher,
} from "../../src/machine/machine-host-service.ts";
import { MachineRuntimeRole } from "../../src/machine/machine-runtime-role.ts";

const temporaryDirectories: string[] = [];
const previousAuthorizedKeys = process.env.ZUSE_AUTHORIZED_KEYS_FILE;
const previousRuntimeUpdaterPath = process.env.ZUSE_RUNTIME_UPDATER_PATH;
const previousAppVersion = process.env.ZUSE_APP_VERSION;

afterEach(async () => {
	if (previousAuthorizedKeys === undefined) {
		delete process.env.ZUSE_AUTHORIZED_KEYS_FILE;
	} else {
		process.env.ZUSE_AUTHORIZED_KEYS_FILE = previousAuthorizedKeys;
	}
	if (previousRuntimeUpdaterPath === undefined)
		delete process.env.ZUSE_RUNTIME_UPDATER_PATH;
	else process.env.ZUSE_RUNTIME_UPDATER_PATH = previousRuntimeUpdaterPath;
	if (previousAppVersion === undefined) delete process.env.ZUSE_APP_VERSION;
	else process.env.ZUSE_APP_VERSION = previousAppVersion;
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

const hostLayer = (
	userData: string,
	role: "cloud-environment" | "control-plane",
) =>
	MachineHostServiceLive.pipe(
		Layer.provide(Layer.succeed(AppPaths, { userData })),
		Layer.provide(
			Layer.succeed(
				MachinePrivateEndpointPublisher,
				MachinePrivateEndpointPublisher.of({ publish: () => Effect.void }),
			),
		),
		Layer.provide(Layer.succeed(MachineRuntimeRole, role)),
	);

describe("machine host SSH keys", () => {
	test("adds and removes keys by fingerprint with owner-only permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-machine-host-"));
		temporaryDirectories.push(directory);
		const authorizedKeys = join(directory, ".ssh", "authorized_keys");
		process.env.ZUSE_AUTHORIZED_KEYS_FILE = authorizedKeys;
		const layer = hostLayer(directory, "cloud-environment");
		const publicKey = `ssh-ed25519 ${Buffer.from("test-public-key").toString("base64")} laptop`;

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const host = yield* MachineHostService;
				const added = yield* host.addSshKey(publicKey, "zuse-desktop");
				yield* host.addSshKey(publicKey, "zuse-desktop");
				const listed = yield* host.listSshKeys();
				yield* host.removeSshKey(added.fingerprint);
				return {
					added,
					listed,
					afterRemove: yield* host.listSshKeys(),
				};
			}).pipe(Effect.provide(layer)),
		);

		expect(result.added.fingerprint).toMatch(/^SHA256:/u);
		expect(result.added.label).toBe("zuse-desktop");
		expect(() => Schema.encodeSync(MachineSshKey)(result.added)).not.toThrow();
		expect(result.listed).toHaveLength(1);
		expect(result.afterRemove).toEqual([]);
		expect((await stat(authorizedKeys)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, ".ssh"))).mode & 0o777).toBe(0o700);
	});
});

describe("machine runtime updates", () => {
	test("reports the desktop target and queues a version-bound update request", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-runtime-update-"));
		temporaryDirectories.push(directory);
		const updater = join(directory, "runtime-updater.mjs");
		await writeFile(
			updater,
			`console.log(JSON.stringify({state:"update-available",phase:"idle",progressPercent:0,targetAppVersion:process.env.ZUSE_RUNTIME_DESIRED_APP_VERSION,installedAppVersion:"0.16.0",installedRuntimeVersion:"old-runtime",targetRuntimeVersion:"new-runtime",updatedAt:Date.now()}));\n`,
			{ mode: 0o700 },
		);
		process.env.ZUSE_RUNTIME_UPDATER_PATH = updater;
		process.env.ZUSE_APP_VERSION = "0.17.1";

		const target = await Effect.runPromise(
			Effect.gen(function* () {
				const host = yield* MachineHostService;
				return yield* host.runtimeTarget();
			}).pipe(Effect.provide(hostLayer(directory, "control-plane"))),
		);
		const queued = await Effect.runPromise(
			Effect.gen(function* () {
				const host = yield* MachineHostService;
				return yield* host.requestRuntimeUpdate(target.appVersion);
			}).pipe(Effect.provide(hostLayer(directory, "cloud-environment"))),
		);

		expect(target).toEqual({ appVersion: "0.17.1" });
		expect(queued).toMatchObject({
			state: "updating",
			phase: "queued",
			targetAppVersion: "0.17.1",
			targetRuntimeVersion: "new-runtime",
		});
		expect(() => Schema.encodeSync(MachineRuntimeStatus)(queued)).not.toThrow();
		expect(
			JSON.parse(
				await readFile(
					join(directory, "runtime-update", "request.json"),
					"utf8",
				),
			),
		).toEqual({ targetAppVersion: "0.17.1" });
		expect(
			(await stat(join(directory, "runtime-update", "request.json"))).mode &
				0o777,
		).toBe(0o600);
	});
});
