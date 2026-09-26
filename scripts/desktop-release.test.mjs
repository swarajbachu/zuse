import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import {
	compareReleaseVersions,
	nextPreviewVersion,
	parseReleaseVersion,
	releaseMetadata,
} from "../packages/utils/src/release-version.mjs";
import {
	prepareReleaseAssets,
	publishRelease,
	validateNotes,
	verifyReleaseAssets,
} from "./desktop-release.mjs";

test("Linux desktop packaging selects each bundled file once", async () => {
	if (process.platform !== "linux") return;
	const require = createRequire(import.meta.url);
	const { getConfig } = require("app-builder-lib/out/util/config/config.js");
	const config = await getConfig(join(import.meta.dirname, "../apps/desktop"));
	const patterns = config.files.flatMap((fileSet) => fileSet.filter ?? []);
	assert.equal(
		patterns.filter((pattern) => pattern === "dist-electron/**/*").length,
		1,
	);
	assert.equal(config.linux.files, undefined);
});

test("orders Preview numerically and promotes to Stable", () => {
	const versions = [
		"0.21.0",
		"0.22.0-preview.1",
		"0.22.0-preview.2",
		"0.22.0-preview.10",
		"0.22.0",
		"0.23.0-preview.1",
	];
	assert.deepEqual(
		[...versions].reverse().sort(compareReleaseVersions),
		versions,
	);
	assert.equal(compareReleaseVersions("0.22.0", "0.22.0"), 0);
	for (const value of [
		"v0.22.0",
		"0.22.0-alpha.1",
		"0.22.0-preview.0",
		"0.22.0-preview.01",
		"01.22.0",
		"0.22.0+build",
		"9007199254740992.0.0",
	])
		assert.throws(() => parseReleaseVersion(value));
});
test("allocates Preview numbers from all reserved tags", () => {
	assert.equal(
		nextPreviewVersion("0.22.0", [
			"v0.22.0-preview.2",
			"v0.22.0-preview.10",
			"v0.21.0",
		]),
		"0.22.0-preview.11",
	);
	assert.throws(() => nextPreviewVersion("0.22.0", ["v0.22.0"]));
	assert.throws(() => nextPreviewVersion("0.22.0-preview.1", []));
	assert.equal(releaseMetadata("0.22.0-preview.1").prerelease, true);
	assert.equal(releaseMetadata("0.22.0").updateChannel, "latest");
});
test("requires curated release notes", () => {
	assert.throws(() => validateNotes(""));
	assert.throws(() => validateNotes("commit 1234"));
	assert.equal(
		validateNotes("### Added\n\n- Choose Preview updates.\n"),
		"### Added\n\n- Choose Preview updates.",
	);
});
test("publication requires both platforms and verifies manifest hashes", () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-release-test-"));
	const metadata = releaseMetadata("0.22.0-preview.1");
	try {
		assert.throws(() => verifyReleaseAssets(directory, metadata), /Missing/);
		const files = ["dmg", "zip", "AppImage", "deb"].map((extension) => {
			const url = `Zuse-${metadata.version}.${extension}`;
			writeFileSync(join(directory, url), extension);
			return {
				url,
				size: Buffer.byteLength(extension),
				sha512: createHash("sha512").update(extension).digest("base64"),
			};
		});
		writeFileSync(
			join(directory, "preview-mac.yml"),
			stringify({ version: metadata.version, files: files.slice(0, 2) }),
		);
		writeFileSync(
			join(directory, "preview-linux.yml"),
			stringify({ version: metadata.version, files: files.slice(2) }),
		);
		assert.equal(verifyReleaseAssets(directory, metadata).length, 6);
		writeFileSync(join(directory, files[1].url), "corrupted");
		assert.throws(
			() => verifyReleaseAssets(directory, metadata),
			/Integrity mismatch/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("adopts GitHub manifest names only for matching archive contents and blockmaps", () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-safe-artifact-names-"));
	const metadata = releaseMetadata("0.22.0-preview.1");
	try {
		const files = ["dmg", "zip", "AppImage", "deb"].map((extension) => {
			const local = `Zuse (Beta)-${metadata.version}.${extension}`;
			const url = `desktop-${metadata.version}.${extension}`;
			writeFileSync(join(directory, local), extension);
			writeFileSync(
				join(directory, `${local}.blockmap`),
				`blockmap-${extension}`,
			);
			return {
				url,
				size: extension.length,
				sha512: createHash("sha512").update(extension).digest("base64"),
				local,
			};
		});
		for (const [index, platform] of ["-mac", "-linux"].entries())
			writeFileSync(
				join(directory, `preview${platform}.yml`),
				stringify({
					version: metadata.version,
					files: files.slice(index * 2, index * 2 + 2),
				}),
			);
		const zip = files[1];
		writeFileSync(join(directory, zip.local), "bad");
		assert.throws(
			() => prepareReleaseAssets(directory, metadata),
			/Expected one verified/,
		);
		writeFileSync(join(directory, zip.local), "zip");
		prepareReleaseAssets(directory, metadata);
		assert.equal(verifyReleaseAssets(directory, metadata).length, 10);
		for (const file of files)
			assert.equal(
				readFileSync(join(directory, `${file.url}.blockmap`), "utf8"),
				`blockmap-${file.url.split(".").at(-1)}`,
			);
		// Preparation remains safe when publication is retried after an upload failure.
		prepareReleaseAssets(directory, metadata);
		// An interruption after moving the archive must not publish its old-named blockmap.
		renameSync(
			join(directory, `${zip.url}.blockmap`),
			join(directory, `${zip.local}.blockmap`),
		);
		prepareReleaseAssets(directory, metadata);
		assert.throws(
			() => verifyReleaseAssets(directory, metadata),
			/Orphaned blockmap/,
		);
		renameSync(
			join(directory, `${zip.local}.blockmap`),
			join(directory, `${zip.url}.blockmap`),
		);
		renameSync(join(directory, zip.url), join(directory, zip.local));
		assert.throws(
			() => prepareReleaseAssets(directory, metadata),
			/Conflicting blockmap/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("a failed upload leaves a draft and never publishes; a verified retry keeps Preview off latest", () => {
	const directory = mkdtempSync(join(tmpdir(), "zuse-release-publish-"));
	const metadata = {
		...releaseMetadata("0.22.0-preview.1"),
		sha: "abc123",
		notes: "### Added\n\n- Choose Preview updates.",
	};
	try {
		const files = ["dmg", "zip", "AppImage", "deb"].map((extension) => {
			const url = `Zuse-${metadata.version}.${extension}`;
			writeFileSync(join(directory, url), extension);
			return {
				url,
				size: Buffer.byteLength(extension),
				sha512: createHash("sha512").update(extension).digest("base64"),
			};
		});
		const manifests = ["preview-mac.yml", "preview-linux.yml"];
		for (const [index, name] of manifests.entries())
			writeFileSync(
				join(directory, name),
				stringify({
					version: metadata.version,
					files: files.slice(index * 2, index * 2 + 2),
				}),
			);
		const calls = [];
		const failedUpload = (...args) => {
			calls.push(args);
			if (args[1] === "view") return JSON.stringify({ isDraft: true });
			if (args[1] === "upload") throw new Error("Upload interrupted");
			throw new Error("Unexpected publish attempt");
		};
		assert.throws(
			() => publishRelease(directory, metadata, failedUpload),
			/Upload interrupted/,
		);
		assert.equal(
			calls.some((args) => args[1] === "edit"),
			false,
		);
		const successfulUpload = (...args) => {
			calls.push(args);
			if (args[1] === "view" && args.at(-1) === "isDraft")
				return JSON.stringify({ isDraft: true });
			if (args[1] === "view")
				return JSON.stringify({
					assets: [...files.map((file) => file.url), ...manifests].map(
						(name) => ({
							name,
							size: readFileSync(join(directory, name)).length,
						}),
					),
				});
			return "";
		};
		publishRelease(directory, metadata, successfulUpload);
		const publish = calls.find((args) => args[1] === "edit");
		assert(publish.includes("--latest=false"));
		assert(publish.includes("--prerelease=true"));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

function withReleaseRepository(run) {
	const directory = mkdtempSync(join(tmpdir(), "zuse-release-resolve-"));
	const git = (...args) =>
		execFileSync("git", args, {
			cwd: directory,
			encoding: "utf8",
			stdio: "pipe",
		}).trim();
	try {
		git("init", "-b", "main");
		git("config", "user.email", "release-test@example.com");
		git("config", "user.name", "Release test");
		mkdirSync(join(directory, "packages/contracts/src"), { recursive: true });
		writeFileSync(
			join(directory, "packages/contracts/src/update.ts"),
			"export const UPDATE_CHANNEL_SET = 'channel';\n",
		);
		git("add", ".");
		git("commit", "-m", "Stable with channels");
		git("tag", "v0.21.0");
		writeFileSync(join(directory, "feature.txt"), "tested Preview");
		git("add", ".");
		git("commit", "-m", "Preview source");
		const previewSha = git("rev-parse", "HEAD");
		git("tag", "v0.22.0-preview.2");
		git("tag", "v0.22.0-preview.10");
		writeFileSync(join(directory, "feature.txt"), "later untested change");
		git("add", ".");
		git("commit", "-m", "Later main change");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		mkdirSync(join(directory, "bin"));
		writeFileSync(
			join(directory, "bin/gh"),
			`#!${process.execPath}\nif(process.argv.includes('--slurp') && process.argv.includes('--jq')) process.exit(2);\nconst stable = {tag_name:'v0.21.0',prerelease:false,draft:false};\nconst releases = process.argv.some(a=>a.endsWith('&page=1')) ? Array(100).fill(stable) : [{tag_name:'v0.22.0-preview.2',prerelease:true,draft:false}];\nconsole.log(JSON.stringify(process.argv.some(a=>a.endsWith('/latest')) ? stable : releases));\n`,
			{ mode: 0o755 },
		);
		const resolveRelease = (overrides) => {
			execFileSync(
				process.execPath,
				[
					fileURLToPath(new URL("./desktop-release.mjs", import.meta.url)),
					"resolve",
				],
				{
					cwd: directory,
					stdio: "pipe",
					env: {
						...process.env,
						PATH: `${join(directory, "bin")}:${process.env.PATH}`,
						GITHUB_EVENT_NAME: "workflow_dispatch",
						GITHUB_REPOSITORY: "example/zuse",
						RELEASE_CHANNEL: "preview",
						RELEASE_REF: previewSha,
						RELEASE_VERSION: "0.22.0",
						RELEASE_METADATA: join(directory, "metadata.json"),
						GITHUB_OUTPUT: join(directory, "output"),
						RELEASE_NOTES: "### Added\n\n- Preview updates.",
						...overrides,
					},
				},
			);
			return JSON.parse(readFileSync(join(directory, "metadata.json"), "utf8"));
		};
		run({ directory, git, previewSha, resolveRelease });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("manual Preview uses the chosen main commit and advances reserved tags", () => {
	withReleaseRepository(({ previewSha, resolveRelease }) => {
		const metadata = resolveRelease({});
		assert.equal(metadata.sha, previewSha);
		assert.equal(metadata.version, "0.22.0-preview.11");
		assert.equal(metadata.prerelease, true);
	});
});

test("Stable promotion builds the published Preview commit, not current main", () => {
	withReleaseRepository(({ git, previewSha, resolveRelease }) => {
		const metadata = resolveRelease({
			RELEASE_CHANNEL: "stable",
			RELEASE_PREVIEW_TAG: "v0.22.0-preview.2",
		});
		assert.equal(metadata.sha, previewSha);
		assert.notEqual(metadata.sha, git("rev-parse", "HEAD"));
		assert.equal(metadata.version, "0.22.0");
		assert.equal(metadata.prerelease, false);
	});
});

test("Preview resolution leaves data compatibility to the cross-version behavior gate", () => {
	withReleaseRepository(({ directory, git, resolveRelease }) => {
		mkdirSync(join(directory, "apps/server/src/persistence"), {
			recursive: true,
		});
		writeFileSync(
			join(directory, "apps/server/src/persistence/migrations.ts"),
			"changed schema",
		);
		git("add", "apps");
		git("commit", "-m", "Additive data change");
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		assert.equal(
			resolveRelease({ RELEASE_REF: "HEAD" }).sha,
			git("rev-parse", "HEAD"),
		);
	});
});
