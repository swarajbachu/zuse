import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
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

afterEach(async () => {
	if (previousAuthorizedKeys === undefined) {
		delete process.env.ZUSE_AUTHORIZED_KEYS_FILE;
	} else {
		process.env.ZUSE_AUTHORIZED_KEYS_FILE = previousAuthorizedKeys;
	}
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("machine host SSH keys", () => {
	test("adds and removes keys by fingerprint with owner-only permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-machine-host-"));
		temporaryDirectories.push(directory);
		const authorizedKeys = join(directory, ".ssh", "authorized_keys");
		process.env.ZUSE_AUTHORIZED_KEYS_FILE = authorizedKeys;
		const layer = MachineHostServiceLive.pipe(
			Layer.provide(Layer.succeed(AppPaths, { userData: directory })),
			Layer.provide(
				Layer.succeed(
					MachinePrivateEndpointPublisher,
					MachinePrivateEndpointPublisher.of({
						publish: () => Effect.void,
					}),
				),
			),
			Layer.provide(Layer.succeed(MachineRuntimeRole, "cloud-environment")),
		);
		const publicKey = `ssh-ed25519 ${Buffer.from("test-public-key").toString("base64")} laptop`;

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const host = yield* MachineHostService;
				const added = yield* host.addSshKey(publicKey);
				yield* host.addSshKey(publicKey);
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
		expect(result.listed).toHaveLength(1);
		expect(result.afterRemove).toEqual([]);
		expect((await stat(authorizedKeys)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, ".ssh"))).mode & 0o777).toBe(0o700);
	});
});
