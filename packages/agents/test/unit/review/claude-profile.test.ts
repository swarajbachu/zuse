import {
	chmod,
	mkdir,
	mkdtemp,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	nativeReviewOptions,
	validateNativeReviewProfile,
} from "../../../src/review/claude-profile.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function profile() {
	const root = await mkdtemp(join(tmpdir(), "review-profile-"));
	roots.push(root);
	const value = {
		authHome: join(root, "auth"),
		trustedCwd: join(root, "cwd"),
		executablePath: join(root, "claude"),
		model: "claude-test",
	};
	await mkdir(value.authHome, { mode: 0o700 });
	await mkdir(value.trustedCwd, { mode: 0o700 });
	await writeFile(value.executablePath, "fake pinned executable");
	await writeFile(
		join(value.authHome, ".credentials.json"),
		"fixture-never-read",
		{ mode: 0o600 },
	);
	return value;
}
describe("dedicated native review profile", () => {
	it("accepts existing private native auth without reading credentials", async () => {
		await expect(
			validateNativeReviewProfile(await profile()),
		).resolves.toBeUndefined();
	});
	it("rejects shared-readable auth", async () => {
		const value = await profile();
		await chmod(value.authHome, 0o755);
		await expect(validateNativeReviewProfile(value)).rejects.toThrow("private");
	});
	it("rejects credential symlinks", async () => {
		const value = await profile();
		await rm(join(value.authHome, ".credentials.json"));
		await symlink(
			value.executablePath,
			join(value.authHome, ".credentials.json"),
		);
		await expect(validateNativeReviewProfile(value)).rejects.toThrow(
			"unavailable",
		);
	});
	it("does not initialize missing native credentials", async () => {
		const value = await profile();
		await rm(join(value.authHome, ".credentials.json"));
		await expect(validateNativeReviewProfile(value)).rejects.toThrow();
	});
	it("removes native capabilities and inherited control credentials", async () => {
		const value = await profile();
		const controller = new AbortController();
		const options = nativeReviewOptions(value, controller);
		expect(options.tools).toEqual([]);
		expect(options.settingSources).toEqual([]);
		expect(options.strictMcpConfig).toBe(true);
		expect(options.plugins).toEqual([]);
		expect(options.skills).toEqual([]);
		expect(options.persistSession).toBe(false);
		expect(Object.keys(options.env ?? {}).sort()).toEqual([
			"CLAUDE_AGENT_SDK_CLIENT_APP",
			"CLAUDE_CONFIG_DIR",
			"HOME",
			"LANG",
			"PATH",
		]);
		expect(options.settings).toMatchObject({
			disableAllHooks: true,
			disableCommandPluginSources: true,
		});
		await expect(
			options.canUseTool?.(
				"Bash",
				{ command: "cat credentials" },
				{ signal: controller.signal, toolUseID: "tool", requestId: "request" },
			),
		).resolves.toMatchObject({ behavior: "deny" });
	});
});
