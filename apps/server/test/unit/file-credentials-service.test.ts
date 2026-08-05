import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
});
