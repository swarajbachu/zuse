import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { makeFileCredentialsService } from "../../src/provider/layers/file-credentials-service.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("file credentials service", () => {
	test("atomically persists secrets with owner-only permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-credentials-"));
		temporaryDirectories.push(directory);
		const layer = makeFileCredentialsService(directory);

		const configured = await Effect.runPromise(
			Effect.gen(function* () {
				const credentials = yield* CredentialsService;
				yield* Effect.all(
					[
						credentials.set("claude", "secret-claude"),
						credentials.set("codex", "secret-codex"),
					],
					{ concurrency: "unbounded" },
				);
				return yield* credentials.listConfigured();
			}).pipe(Effect.provide(layer)),
		);

		expect(configured).toEqual(["claude", "codex"]);
		const filePath = join(directory, "secrets", "credentials.json");
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, "secrets"))).mode & 0o777).toBe(0o700);
		const contents = await readFile(filePath, "utf8");
		expect(contents).toContain("secret-claude");
		expect(contents).toContain("secret-codex");
	});

	test("decodes legacy API keys and migrates provider credentials on write", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-credentials-"));
		temporaryDirectories.push(directory);
		const secretsDirectory = join(directory, "secrets");
		await mkdir(secretsDirectory, { recursive: true });
		const filePath = join(secretsDirectory, "credentials.json");
		await writeFile(
			filePath,
			JSON.stringify({ "apiKey:claude": "legacy-api-key" }),
		);
		const layer = makeFileCredentialsService(directory);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const credentials = yield* CredentialsService;
				const legacy = yield* credentials.getProviderCredential("claude");
				yield* credentials.setProviderCredential("claude", {
					kind: "oauth-token",
					secret: "remote-oauth-token",
				});
				return {
					legacy,
					current: yield* credentials.getProviderCredential("claude"),
				};
			}).pipe(Effect.provide(layer)),
		);

		expect(result.legacy).toEqual({
			kind: "api-key",
			secret: "legacy-api-key",
			updatedAt: 0,
		});
		expect(result.current).toMatchObject({
			kind: "oauth-token",
			secret: "remote-oauth-token",
		});
		const stored = JSON.parse(await readFile(filePath, "utf8")) as {
			readonly version: number;
			readonly providers: Record<string, unknown>;
		};
		expect(stored.version).toBe(2);
		expect(stored.providers.claude).toMatchObject({
			kind: "oauth-token",
			secret: "remote-oauth-token",
		});
	});
});
