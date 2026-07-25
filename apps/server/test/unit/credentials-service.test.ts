import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

const keytar = vi.hoisted(() => ({
	deletePassword: vi.fn(async () => false),
	findCredentials: vi.fn(async () => []),
	getPassword: vi.fn(async () => null),
	setPassword: vi.fn(async () => undefined),
}));

vi.mock("keytar", () => ({ default: keytar }));

import { AppPaths } from "../../src/app-paths.ts";
import { CredentialsServiceLive } from "../../src/provider/layers/credentials-service.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	vi.clearAllMocks();
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("CredentialsService", () => {
	it("stores credentials in an encrypted vault behind one cached keychain key", async () => {
		const userData = await mkdtemp(join(tmpdir(), "zuse-vault-test-"));
		temporaryDirectories.push(userData);
		keytar.findCredentials.mockRejectedValue(
			new Error("would prompt for an unrelated integration credential"),
		);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const credentials = yield* CredentialsService;
				yield* credentials.set("codex", "provider-secret");
				yield* credentials.setIntegration(
					"linear",
					"workspace-1",
					"integration-secret",
				);
				return {
					configured: yield* credentials.listConfigured(),
					provider: yield* credentials.get("codex"),
					integration: yield* credentials.getIntegration(
						"linear",
						"workspace-1",
					),
				};
			}).pipe(
				Effect.provide(
					CredentialsServiceLive.pipe(
						Layer.provide(Layer.succeed(AppPaths, AppPaths.of({ userData }))),
					),
				),
			),
		);

		expect(result).toEqual({
			configured: ["codex"],
			provider: "provider-secret",
			integration: "integration-secret",
		});
		expect(keytar.findCredentials).not.toHaveBeenCalled();
		expect(keytar.getPassword).toHaveBeenCalledTimes(1);
		expect(keytar.getPassword).toHaveBeenCalledWith(
			"zuse-secure-storage",
			"vault-master-key-v1",
		);
		expect(keytar.setPassword).toHaveBeenCalledTimes(1);

		const vault = await readFile(join(userData, "secure-vault.json"), "utf8");
		expect(vault).not.toContain("provider-secret");
		expect(vault).not.toContain("integration-secret");
	});
});
