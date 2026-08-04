#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");
const explicitVersion = readArg("--version");
const releaseKind = readArg("--kind");
const notesFileArg = readArg("--notes-file");
const yes = process.argv.includes("--yes");
const sectionOrder = ["Added", "Changed", "Fixed"];

function readArg(name) {
	const prefix = `${name}=`;
	const inline = process.argv.find((arg) => arg.startsWith(prefix));
	if (inline) return inline.slice(prefix.length);
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args) {
	return execFileSync("git", args, {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function run(command, args, cwd = root) {
	const rendered = [command, ...args].join(" ");
	if (dryRun) {
		console.log(`[dry-run] ${rendered}`);
		return "";
	}
	return execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: "inherit",
	});
}

function write(relativePath, contents) {
	if (dryRun) {
		console.log(`[dry-run] write ${relativePath}`);
		return;
	}
	writeFileSync(join(root, relativePath), contents);
}

function currentBranch() {
	return git(["branch", "--show-current"]);
}

function parseVersion(version) {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) throw new Error(`Expected semver version, got ${version}`);
	return match.slice(1).map(Number);
}

function bumpVersion(version, kind) {
	const [major, minor, patch] = parseVersion(version);
	if (kind === "major") return `${major + 1}.0.0`;
	if (kind === "minor") return `${major}.${minor + 1}.0`;
	if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
	throw new Error(`Unknown release kind: ${kind}`);
}

function compareVersions(left, right) {
	const leftParts = parseVersion(left);
	const rightParts = parseVersion(right);
	for (let index = 0; index < leftParts.length; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function inferKind(messages) {
	const breaking = messages.filter((message) =>
		/\b(breaking|rename|remove|drop|migration|major)\b/i.test(message),
	);
	const features = messages.filter((message) =>
		/\b(add|adds|added|introduce|launch|support|new|enable|feature)\b/i.test(
			message,
		),
	);
	const fixes = messages.filter((message) =>
		/\b(fix|fixed|patch|bug|crash|correct|restore|prevent)\b/i.test(message),
	);

	if (breaking.length > 0) return { kind: "major", confidence: "low" };
	if (features.length > 0) return { kind: "minor", confidence: "high" };
	if (fixes.length > 0) return { kind: "patch", confidence: "high" };
	return { kind: "patch", confidence: "low" };
}

function updateJsonVersion(relativePath, nextVersion) {
	const json = JSON.parse(readFileSync(join(root, relativePath), "utf8"));
	json.version = nextVersion;
	write(relativePath, `${JSON.stringify(json, null, "\t")}\n`);
}

function replaceInFile(relativePath, before, after) {
	const source = readFileSync(join(root, relativePath), "utf8");
	if (!source.includes(before)) {
		throw new Error(`${relativePath} did not contain expected text: ${before}`);
	}
	write(relativePath, source.replace(before, after));
}

function cleanSummary(summary) {
	const withoutPrefix = summary.replace(
		/^(feat|fix|docs|perf|refactor|chore|build|ci|test)(\([^)]*\))?!?:\s*/i,
		"",
	);
	const withoutPr = withoutPrefix.replace(/\s*\(#\d+\)\s*$/, "").trim();
	if (!withoutPr) return "";
	return `${withoutPr[0]?.toUpperCase()}${withoutPr.slice(1)}`.replace(
		/[.;]$/,
		"",
	);
}

function categoryFor(summary) {
	if (
		/^(fix|fixed|restore|prevent|avoid|correct|resolve|repair)\b/i.test(summary)
	) {
		return "Fixed";
	}
	if (
		/^(add|adds|added|introduce|launch|support|enable|ship|create)\b/i.test(
			summary,
		)
	) {
		return "Added";
	}
	return "Changed";
}

function emptySections() {
	return new Map(sectionOrder.map((section) => [section, []]));
}

function addUnique(sections, section, item) {
	const cleaned = cleanSummary(item);
	if (!cleaned) return;
	const normalized = cleaned
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
	const existing = [...sections.values()].flat();
	const duplicate = existing.some(
		(candidate) =>
			candidate
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, " ")
				.trim() === normalized,
	);
	if (!duplicate) sections.get(section)?.push(cleaned);
}

function parseSections(source, label, strict = false) {
	const sections = emptySections();
	let currentSection;

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const heading = line.match(/^###\s+(.+)$/);
		if (heading) {
			const title = heading[1];
			if (!sectionOrder.includes(title)) {
				throw new Error(
					`${label} contains unsupported section "${title}". Use Added, Changed, or Fixed.`,
				);
			}
			currentSection = title;
			continue;
		}
		if (!currentSection || !line.startsWith("- ")) {
			if (strict) {
				throw new Error(
					`${label} must contain only ### section headings and release-note bullets.`,
				);
			}
			continue;
		}
		addUnique(sections, currentSection, line.slice(2));
	}

	if (strict && [...sections.values()].every((items) => items.length === 0)) {
		throw new Error(`${label} does not contain any release-note bullets.`);
	}
	return sections;
}

function mergeFallbackNotes(changelog, commits) {
	const marker = "## [Unreleased]";
	const markerStart = changelog.indexOf(marker);
	if (markerStart < 0) throw new Error("CHANGELOG.md is missing [Unreleased].");
	const contentStart = markerStart + marker.length;
	const nextRelease = changelog.indexOf("\n## [", contentStart);
	const unreleased = changelog.slice(
		contentStart,
		nextRelease < 0 ? changelog.length : nextRelease,
	);
	const sections = parseSections(unreleased, "CHANGELOG.md [Unreleased]");
	for (const commit of commits) {
		addUnique(sections, categoryFor(commit), commit);
	}
	return sections;
}

function formatSections(sections) {
	return sectionOrder
		.filter((section) => (sections.get(section)?.length ?? 0) > 0)
		.map(
			(section) =>
				`### ${section}\n${sections
					.get(section)
					?.map((item) => `- ${item}`)
					.join("\n")}`,
		)
		.join("\n\n");
}

function replaceUnreleased(changelog, version, formattedNotes) {
	const marker = "## [Unreleased]";
	const markerStart = changelog.indexOf(marker);
	if (markerStart < 0) throw new Error("CHANGELOG.md is missing [Unreleased].");
	const contentStart = markerStart + marker.length;
	const nextRelease = changelog.indexOf("\n## [", contentStart);
	const suffix = nextRelease < 0 ? "" : changelog.slice(nextRelease);
	const prefix = changelog.slice(0, contentStart);
	return `${prefix}\n\n## [${version}]\n\n${formattedNotes}${suffix.replace(/^\n*/, "\n\n")}`;
}

function notesFilePath(value) {
	if (!value) return undefined;
	return isAbsolute(value) ? value : resolve(root, value);
}

const status = git(["status", "--porcelain"]);
if (status) {
	throw new Error(
		"Working tree is dirty. Commit, stash, or discard changes first.",
	);
}

run("git", ["fetch", "--prune", "origin"]);
run("git", ["pull", "--ff-only", "origin", "main"]);

const desktopPkg = JSON.parse(
	readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
);
const currentVersion = desktopPkg.version;
const latestTag = `v${currentVersion}`;
git(["rev-parse", "--verify", `refs/tags/${latestTag}`]);
const log = git(["log", "--pretty=format:%s", `${latestTag}..HEAD`]);
const commits = log.split("\n").filter(Boolean);

if (commits.length === 0 && !explicitVersion) {
	throw new Error(`No commits found after ${latestTag}.`);
}

const inferred = inferKind(commits);
if (!explicitVersion && inferred.confidence === "low" && !releaseKind && !yes) {
	throw new Error(
		`Release kind is ambiguous. Re-run with --kind=major, --kind=minor, --kind=patch, or --version=x.y.z.\n` +
			`Inferred ${inferred.kind} from ${commits.length} commits.`,
	);
}

const nextVersion =
	explicitVersion ?? bumpVersion(currentVersion, releaseKind ?? inferred.kind);
parseVersion(nextVersion);
if (compareVersions(nextVersion, currentVersion) <= 0) {
	throw new Error(
		`Next version must be greater than current version ${currentVersion}.`,
	);
}

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const notesPath = notesFilePath(notesFileArg);
const sections = notesPath
	? parseSections(readFileSync(notesPath, "utf8"), notesPath, true)
	: mergeFallbackNotes(changelog, commits);
const formattedNotes = formatSections(sections);
if (!formattedNotes) throw new Error("No release notes were produced.");

console.log(`\nRelease v${nextVersion}\n\n${formattedNotes}\n`);

if (currentBranch() === "main" || currentBranch() === "") {
	run("git", ["checkout", "-b", `codex/release-v${nextVersion}`]);
}

updateJsonVersion("apps/desktop/package.json", nextVersion);
replaceInFile(
	"bun.lock",
	`"apps/desktop": {\n      "name": "desktop",\n      "version": "${currentVersion}",`,
	`"apps/desktop": {\n      "name": "desktop",\n      "version": "${nextVersion}",`,
);
write(
	"CHANGELOG.md",
	replaceUnreleased(changelog, nextVersion, formattedNotes),
);

run("node", ["scripts/generate-website-changelog.mjs"]);
run("bun", ["run", "content:generate"], join(root, "apps/web"));
run("bun", ["run", "check-types"]);
run("git", [
	"add",
	"CHANGELOG.md",
	"apps/desktop/package.json",
	"bun.lock",
	"apps/web",
	"scripts/release-new-version.mjs",
	".codex/skills/release-new-version",
	".claude/skills/release-new-version",
	".codex/commands/release-new-version.md",
	".claude/commands/release-new-version.md",
]);
run("git", ["commit", "-m", `Release v${nextVersion}`]);
run("git", ["push", "-u", "origin", "HEAD"]);

const prBody = `## Summary

Prepare Zuse v${nextVersion} with release notes grouped by user-visible outcome.

${formattedNotes}

## Validation

- \`bun run check-types\`

Release artifacts are produced by pushing tag v${nextVersion} after this PR lands.`;

run("gh", [
	"pr",
	"create",
	"--base",
	"main",
	"--title",
	`Release v${nextVersion}`,
	"--body",
	prBody,
]);

console.log(`Prepared release PR for v${nextVersion}.`);
