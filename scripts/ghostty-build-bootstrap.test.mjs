import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
	assertMatchingExternalZig,
	assertMatchingZigDistribution,
	createGhosttyBuildBootstrap,
} from "./lib/ghostty-build-bootstrap.mjs";

const repository = path.resolve(import.meta.dirname, "..");

test("one bootstrap owns pinned Ghostty source and Zig provenance", async () => {
	const bootstrap = createGhosttyBuildBootstrap({
		cacheRoot: "/tmp/zuse-ghostty-bootstrap-contract",
		revision: "0123456789abcdef",
		zigVersion: "0.15.2",
		tempLabel: "contract",
	});
	assert.equal(
		bootstrap.sourceRoot,
		"/tmp/zuse-ghostty-bootstrap-contract/source-0123456789ab",
	);
	assert.match(
		bootstrap.zigDistribution,
		/^zig-(aarch64|x86_64)-(linux|macos)-0\.15\.2\.tar\.xz$/,
	);
	assert.match(bootstrap.zigArchiveSha256, /^[a-f0-9]{64}$/);

	const builders = await Promise.all([
		readFile(path.join(repository, "scripts/build-ghostty-wasm.mjs"), "utf8"),
		readFile(path.join(repository, "scripts/build-ghostty-ios.mjs"), "utf8"),
		readFile(
			path.join(
				repository,
				"apps/mobile/modules/mobile-terminal/android/scripts/build-ghostty-android.mjs",
			),
			"utf8",
		),
	]);
	for (const builder of builders) {
		assert.match(builder, /createGhosttyBuildBootstrap/);
		assert.match(builder, /releaseBootstrap\s*=\s*bootstrap\.prepare\(\)/);
		assert.match(builder, /finally[\s\S]*releaseBootstrap(?:\?\.)?\(\)/);
		assert.doesNotMatch(builder, /function ensure(?:Zig|Source)\(/);
		assert.doesNotMatch(
			builder,
			/(?:zigDistributions|zigArchiveSha256) = new Map/,
		);
	}
});

test("a same-version external Zig must match the verified binary", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "zuse-zig-trust-test-"));
	try {
		const cachedZig = path.join(directory, "cached-zig");
		const externalZig = path.join(directory, "external-zig");
		writeFileSync(cachedZig, "#!/bin/sh\necho 0.15.2\n");
		writeFileSync(
			externalZig,
			"#!/bin/sh\n# same version, different bytes\necho 0.15.2\n",
		);
		chmodSync(cachedZig, 0o755);
		chmodSync(externalZig, 0o755);

		assert.throws(
			() =>
				assertMatchingExternalZig({
					cachedZig,
					externalZig,
					zigDistribution: "zig-test.tar.xz",
					zigVersion: "0.15.2",
				}),
			/does not match verified/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a genuine Zig binary cannot hide a tampered cached standard library", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "zuse-zig-tree-test-"));
	try {
		const verifiedRoot = path.join(directory, "verified");
		const cachedRoot = path.join(directory, "cached");
		for (const root of [verifiedRoot, cachedRoot]) {
			mkdirSync(path.join(root, "lib", "std"), { recursive: true });
			writeFileSync(path.join(root, "zig"), "verified zig binary\n");
			writeFileSync(
				path.join(root, "lib", "std", "std.zig"),
				"pub const trusted = true;\n",
			);
		}
		assert.doesNotThrow(() =>
			assertMatchingZigDistribution({ cachedRoot, verifiedRoot }),
		);

		writeFileSync(
			path.join(cachedRoot, "lib", "std", "std.zig"),
			"pub const trusted = false;\n",
		);
		assert.throws(
			() => assertMatchingZigDistribution({ cachedRoot, verifiedRoot }),
			/complete verified distribution/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a live bootstrap owner excludes a concurrent prepare", () => {
	const cacheRoot = mkdtempSync(
		path.join(tmpdir(), "zuse-ghostty-lock-contract-"),
	);
	try {
		const bootstrap = createGhosttyBuildBootstrap({
			cacheRoot,
			revision: "0123456789abcdef",
			zigVersion: "0.15.2",
			tempLabel: "lock-contract",
		});
		mkdirSync(path.dirname(bootstrap.lockPath), { recursive: true });
		writeFileSync(
			bootstrap.lockPath,
			`${JSON.stringify({
				hostname: hostname(),
				pid: process.pid,
				startedAt: Date.now(),
				token: "active-owner",
			})}\n`,
		);
		assert.throws(() => bootstrap.prepare(), /already running/);
	} finally {
		rmSync(cacheRoot, { recursive: true, force: true });
	}
});
