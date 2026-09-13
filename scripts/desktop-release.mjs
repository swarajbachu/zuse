#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
	compareReleaseVersions,
	nextPreviewVersion,
	parseReleaseVersion,
	releaseMetadata,
} from "../packages/utils/src/release-version.mjs";

const command = (bin, args) =>
	execFileSync(bin, args, {
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	}).trim();
const git = (...args) => command("git", args);
const gh = (...args) => command("gh", args);

export function validateNotes(notes) {
	if (!/^### (Added|Changed|Fixed)$/m.test(notes) || !/^[-*] \S/m.test(notes)) {
		throw new Error(
			"Curated notes must contain Added, Changed, or Fixed sections and product-facing bullets",
		);
	}
	return notes.trim();
}

function sha512File(path) {
	const fd = openSync(path, "r");
	const chunk = Buffer.alloc(1024 * 1024);
	const hash = createHash("sha512");
	try {
		while (true) {
			const length = readSync(fd, chunk, 0, chunk.length, null);
			if (length === 0) break;
			hash.update(chunk.subarray(0, length));
		}
		return hash.digest("base64");
	} finally {
		closeSync(fd);
	}
}

function releaseManifestFiles(directory, metadata, platform) {
	const manifest = `${metadata.updateChannel}${platform}.yml`;
	const info = parse(readFileSync(join(directory, manifest), "utf8"));
	if (
		info.version !== metadata.version ||
		!Array.isArray(info.files) ||
		info.files.length === 0
	)
		throw new Error(`Invalid ${manifest}`);
	const extension = platform === "-mac" ? ".zip" : ".AppImage";
	if (!info.files.some((file) => file.url.endsWith(extension)))
		throw new Error(`${manifest} has no ${extension}`);
	return info.files.map((file) => {
		const name = decodeURIComponent(file.url);
		if (basename(name) !== name)
			throw new Error(`Non-local release asset: ${name}`);
		return { ...file, name };
	});
}

// electron-builder uses GitHub-safe names in updater manifests while keeping
// display names on local macOS archives. Match content before adopting those
// names; never infer an archive from its position or filename alone.
export function prepareReleaseAssets(directory, metadata) {
	for (const platform of ["-mac", "-linux"]) {
		for (const file of releaseManifestFiles(directory, metadata, platform)) {
			const { name } = file;
			const destination = join(directory, name);
			if (existsSync(destination)) continue;
			const matches = readdirSync(directory).filter((candidate) => {
				const path = join(directory, candidate);
				return (
					candidate.includes(metadata.version) &&
					extname(candidate) === extname(name) &&
					statSync(path).isFile() &&
					statSync(path).size === file.size &&
					sha512File(path) === file.sha512
				);
			});
			if (matches.length !== 1)
				throw new Error(
					`Expected one verified local archive for ${name}, found ${matches.length}`,
				);
			const source = join(directory, matches[0]);
			if (existsSync(`${destination}.blockmap`))
				throw new Error(`Conflicting blockmap for ${name}`);
			renameSync(source, destination);
			if (existsSync(`${source}.blockmap`))
				renameSync(`${source}.blockmap`, `${destination}.blockmap`);
		}
	}
}

export function verifyReleaseAssets(directory, metadata) {
	const names = readdirSync(directory);
	for (const suffix of [".dmg", ".zip", ".AppImage", ".deb"]) {
		if (
			!names.some(
				(name) => name.endsWith(suffix) && name.includes(metadata.version),
			)
		)
			throw new Error(`Missing ${suffix} for ${metadata.version}`);
	}
	for (const platform of ["-mac", "-linux"]) {
		for (const file of releaseManifestFiles(directory, metadata, platform)) {
			const { name } = file;
			const path = join(directory, name);
			if (statSync(path).size !== file.size || sha512File(path) !== file.sha512)
				throw new Error(`Integrity mismatch: ${name}`);
		}
	}
	return names.filter((name) =>
		/\.(dmg|zip|AppImage|deb|yml|blockmap)$/.test(name),
	);
}

function resolveRelease() {
	const event = process.env.GITHUB_EVENT_NAME;
	const releases = [];
	for (let page = 1; ; page++) {
		const batch = JSON.parse(
			gh(
				"api",
				`repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=100&page=${page}`,
				"--jq",
				"map({tag_name, draft, prerelease})",
			),
		);
		releases.push(...batch);
		if (batch.length < 100) break;
	}
	const stable = JSON.parse(
		gh("api", `repos/${process.env.GITHUB_REPOSITORY}/releases/latest`),
	);
	const stableVersion = stable.tag_name.replace(/^v/, "");
	if (parseReleaseVersion(stableVersion).preview !== null)
		throw new Error("Latest release must be Stable");
	const stableSha = git("rev-parse", `${stable.tag_name}^{commit}`);
	let metadata;
	let sha;
	let previewTag = null;
	let notes = process.env.RELEASE_NOTES ?? "";
	if (event === "push") {
		const version = process.env.GITHUB_REF_NAME?.replace(/^v/, "");
		metadata = releaseMetadata(version);
		if (metadata.prerelease) throw new Error("Use manual Preview publishing");
		sha = git("rev-parse", "HEAD");
		const changelog = readFileSync("CHANGELOG.md", "utf8");
		const heading = `## [${version}]`;
		if (!changelog.includes(heading))
			throw new Error(`Missing notes for ${version}`);
		notes = changelog.split(heading)[1].split(/\n## /)[0];
	} else if (process.env.RELEASE_CHANNEL === "preview") {
		const ref = process.env.RELEASE_REF || "origin/main";
		sha = git("rev-parse", "--verify", `${ref}^{commit}`);
		git("merge-base", "--is-ancestor", sha, "origin/main");
		git("merge-base", "--is-ancestor", stableSha, sha);
		const tags = [
			...git("tag", "--list").split("\n"),
			...releases.map((release) => release.tag_name),
		];
		metadata = releaseMetadata(
			nextPreviewVersion(process.env.RELEASE_VERSION, tags),
		);
		for (const release of releases.filter((release) => !release.draft)) {
			let version;
			try {
				version = parseReleaseVersion(release.tag_name.replace(/^v/, ""));
			} catch {
				continue;
			}
			if (
				version.preview !== null &&
				compareReleaseVersions(metadata.version, release.tag_name.slice(1)) <= 0
			)
				throw new Error(
					"Preview version must advance the published Preview channel",
				);
		}
	} else {
		previewTag = process.env.RELEASE_PREVIEW_TAG;
		if (
			!previewTag ||
			!releaseMetadata(previewTag.replace(/^v/, "")).prerelease
		)
			throw new Error("Stable promotion requires a Preview tag");
		const preview = releases.find(
			(release) =>
				release.tag_name === previewTag && release.prerelease && !release.draft,
		);
		if (!preview)
			throw new Error("Preview tag must have a published prerelease");
		sha = git("rev-parse", `${previewTag}^{commit}`);
		const { major, minor, patch } = parseReleaseVersion(previewTag.slice(1));
		metadata = releaseMetadata(`${major}.${minor}.${patch}`);
		git("merge-base", "--is-ancestor", stableSha, sha);
	}
	if (compareReleaseVersions(metadata.version, stableVersion) <= 0)
		throw new Error("Release must advance current Stable");
	if (
		releases.some(
			(release) => release.tag_name === metadata.tag && !release.draft,
		)
	)
		throw new Error("Release is already published");
	if (event !== "push" && git("tag", "--list", metadata.tag))
		throw new Error(
			"Release tag already exists; use a new Preview number or inspect the failed promotion",
		);
	metadata = {
		...metadata,
		sha,
		stableTag: stable.tag_name,
		stableSha,
		previewTag,
		notes: validateNotes(notes),
	};
	writeFileSync(
		process.env.RELEASE_METADATA,
		`${JSON.stringify(metadata, null, 2)}\n`,
	);
	for (const [key, value] of Object.entries(metadata)) {
		if (key !== "notes")
			appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value ?? ""}\n`);
	}
}

export function publishRelease(directory, metadata, github = gh) {
	prepareReleaseAssets(directory, metadata);
	const assets = verifyReleaseAssets(directory, metadata);
	const notesFile = join(directory, "release-notes.md");
	writeFileSync(notesFile, validateNotes(metadata.notes));
	// Create a draft only after all platform artifacts pass validation. Failed
	// uploads stay invisible to updaters; retrying never publishes half a build.
	let existing;
	try {
		existing = JSON.parse(
			github("release", "view", metadata.tag, "--json", "isDraft"),
		);
	} catch {
		/* first attempt */
	}
	if (existing && !existing.isDraft)
		throw new Error("Refusing to overwrite a published release");
	if (!existing)
		github(
			"release",
			"create",
			metadata.tag,
			"--target",
			metadata.sha,
			"--draft",
			"--title",
			metadata.name,
			"--notes-file",
			notesFile,
			...(metadata.prerelease ? ["--prerelease"] : []),
		);
	github(
		"release",
		"upload",
		metadata.tag,
		...assets.map((name) => join(directory, name)),
		"--clobber",
	);
	const uploaded = JSON.parse(
		github("release", "view", metadata.tag, "--json", "assets"),
	).assets;
	if (
		!assets.every((name) =>
			uploaded.some(
				(asset) =>
					asset.name === name &&
					asset.size === statSync(join(directory, name)).size,
			),
		)
	)
		throw new Error("Published asset verification failed");
	github(
		"release",
		"edit",
		metadata.tag,
		"--draft=false",
		`--prerelease=${metadata.prerelease}`,
		`--latest=${!metadata.prerelease}`,
		"--title",
		metadata.name,
		"--notes-file",
		notesFile,
	);
}

function main() {
	if (process.argv[2] === "resolve") return resolveRelease();
	const metadata = JSON.parse(
		readFileSync(process.env.RELEASE_METADATA, "utf8"),
	);
	if (process.argv[2] === "version") {
		const path = "apps/desktop/package.json";
		const pkg = JSON.parse(readFileSync(path, "utf8"));
		pkg.version = metadata.version;
		writeFileSync(path, `${JSON.stringify(pkg, null, "\t")}\n`);
		const configPath = "apps/desktop/electron-builder.yml";
		const config = parse(readFileSync(configPath, "utf8"));
		config.publish.channel = metadata.updateChannel;
		config.releaseInfo = {
			releaseNotes: metadata.notes,
			releaseName: metadata.name,
		};
		writeFileSync(configPath, stringify(config));
		return;
	}
	if (process.argv[2] === "publish")
		return publishRelease(resolve(process.argv[3]), metadata);
	throw new Error("Expected resolve, version, or publish");
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	main();
