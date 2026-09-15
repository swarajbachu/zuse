import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readCurrentCredential } from "../credentials.ts";

it("reads the current Codex login from its configured home without Keychain access", async () => {
	const home = await mkdtemp(join(tmpdir(), "quota-current-"));
	const keychain = vi.fn(async () => null);
	try {
		const directory = join(home, "codex-work");
		await mkdir(directory);
		await writeFile(
			join(directory, "auth.json"),
			'{"tokens":{"account_id":"work","access_token":"private"}}',
		);
		expect(
			await readCurrentCredential("codex", new AbortController().signal, {
				home,
				platform: "darwin",
				env: { CODEX_HOME: directory },
				keychain,
			}),
		).toMatchObject({ tokens: { account_id: "work" } });
		expect(keychain).not.toHaveBeenCalled();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

it("reads only the selected provider's Keychain entry and bounds it to the current Codex home", async () => {
	const signal = new AbortController().signal;
	const keychain = vi.fn(async () => ({
		claudeAiOauth: { accessToken: "private" },
	}));
	await readCurrentCredential("claude", signal, {
		home: "/fixture",
		platform: "darwin",
		env: {},
		keychain,
	});
	expect(keychain).toHaveBeenCalledExactlyOnceWith(
		"Claude Code-credentials",
		undefined,
		signal,
	);
	keychain.mockClear();
	await readCurrentCredential("codex", signal, {
		home: "/fixture-missing",
		platform: "darwin",
		env: {},
		keychain,
	});
	const hash = createHash("sha256")
		.update("/fixture-missing/.codex")
		.digest("hex")
		.slice(0, 16);
	expect(keychain).toHaveBeenCalledExactlyOnceWith(
		"Codex Auth",
		`cli|${hash}`,
		signal,
	);
});

it("keeps denied access and cancellation visible without trying another credential store", async () => {
	const keychain = vi.fn(async () => {
		throw new Error("Keychain access denied");
	});
	await expect(
		readCurrentCredential("claude", new AbortController().signal, {
			platform: "darwin",
			env: {},
			keychain,
		}),
	).rejects.toThrow("Keychain access denied");
	const controller = new AbortController();
	controller.abort();
	keychain.mockClear();
	await expect(
		readCurrentCredential("claude", controller.signal, {
			platform: "darwin",
			env: {},
			keychain,
		}),
	).rejects.toThrow();
	expect(keychain).not.toHaveBeenCalled();
	await expect(
		readCurrentCredential("codex", new AbortController().signal, {
			home: "/fixture-missing",
			platform: "linux",
			env: {},
			keychain,
		}),
	).rejects.toThrow("codex login");
	expect(keychain).not.toHaveBeenCalled();
});
