import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, vi } from "vitest";
import { installSnapshot } from "../src/snapshot.ts";

async function bundle(corrupt = false) {
	const directory = await mkdtemp(join(tmpdir(), "snapshot-fixture-"));
	try {
		const files = [
			"install-snapshot.sh",
			"runtime-updater.mjs",
			"snapshot-release.json",
			"sshd_config",
		];
		const hashes = [];
		for (const name of files) {
			await writeFile(join(directory, name), "test fixture");
			hashes.push(
				`${createHash("sha256").update("test fixture").digest("hex")}  ${name}`,
			);
		}
		await writeFile(
			join(directory, "SHA256SUMS"),
			corrupt ? "invalid" : hashes.join("\n"),
		);
		execFileSync("tar", [
			"-czf",
			join(directory, "bundle.tgz"),
			"-C",
			directory,
			...files,
			"SHA256SUMS",
		]);
		return await readFile(join(directory, "bundle.tgz"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function dependencies(bytes = Buffer.from("unused"), failInstall = false) {
	const fetcher = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(new Uint8Array(bytes)));
	const run = vi.fn(async (command: string, args: string[]) => {
		if (command === "tar") execFileSync(command, args);
		if (command === "bash" && failInstall)
			throw new Error("installation failed");
	});
	return {
		fetch: fetcher,
		run,
		platform: "linux" as const,
		arch: "x64" as const,
	};
}

test.each([
	{ args: [] },
	{ args: ["--user", "developer"] },
])("installs the official bundle with arguments %j and removes temporary files", async ({
	args,
}) => {
	const deps = dependencies(await bundle());
	await installSnapshot(args, deps);
	expect(deps.fetch.mock.calls[0]?.[0]).toBe(
		"https://github.com/swarajbachu/zuse/releases/download/cloud-runtime-production/zuse-snapshot-installer.tar.gz",
	);
	const invocation = deps.run.mock.calls.find(
		([command]) => command === "bash",
	);
	expect(invocation?.[1].slice(1)).toEqual(args);
	await expect(access(dirname(invocation?.[1][0] ?? ""))).rejects.toThrow();
});

test("rejects corrupted downloads before invoking setup", async () => {
	const deps = dependencies(await bundle(true));
	await expect(installSnapshot([], deps)).rejects.toThrow("checksum mismatch");
	expect(deps.run.mock.calls.some(([command]) => command === "bash")).toBe(
		false,
	);
});

test.each([
	["--channel", "staging", "--user", "developer"],
	["--user", "developer", "--channel", "staging"],
])("selects staging without forwarding channel options: %j", async (...args) => {
	const deps = dependencies(await bundle());
	await installSnapshot(args, deps);
	expect(deps.fetch.mock.calls[0]?.[0]).toContain("/cloud-runtime-staging/");
	expect(
		deps.run.mock.calls.find(([command]) => command === "bash")?.[1].slice(1),
	).toEqual(["--user", "developer"]);
});

test("reports failed setup and cleans temporary files", async () => {
	const deps = dependencies(await bundle(), true);
	await expect(installSnapshot([], deps)).rejects.toThrow(
		"installation failed",
	);
	const invocation = deps.run.mock.calls.find(
		([command]) => command === "bash",
	);
	await expect(access(dirname(invocation?.[1][0] ?? ""))).rejects.toThrow();
});

test.each(
	[
		["--repo", "/repo"],
		["--user", "root"],
		["--user"],
		["--user", "dev;echo hi"],
		["--channel", "unknown"],
		["--channel"],
		["--channel", "staging", "--channel", "production"],
	].map((args) => ({ args })),
)("rejects invalid options %j without downloading", async ({ args }) => {
	const deps = dependencies();
	await expect(installSnapshot(args, deps)).rejects.toThrow("Usage:");
	expect(deps.fetch).not.toHaveBeenCalled();
});

test("help works without downloading on unsupported hosts", async () => {
	const deps = { ...dependencies(), platform: "darwin" as const };
	await installSnapshot(["--help"], deps);
	expect(deps.fetch).not.toHaveBeenCalled();
	await expect(installSnapshot([], deps)).rejects.toThrow("inside your Linux");
});

test("reports unpublished artifacts without invoking commands", async () => {
	const deps = dependencies();
	deps.fetch.mockResolvedValue(new Response(null, { status: 404 }));
	await expect(installSnapshot([], deps)).rejects.toThrow("published");
	expect(deps.run).not.toHaveBeenCalled();
});
