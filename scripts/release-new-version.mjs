#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");
const explicitVersion = readArg("--version");
const releaseKind = readArg("--kind");
const yes = process.argv.includes("--yes");

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

function run(command, args) {
  const rendered = [command, ...args].join(" ");
  if (dryRun) {
    console.log(`[dry-run] ${rendered}`);
    return "";
  }
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: "inherit",
  });
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

function inferKind(messages) {
  const breaking = messages.filter((message) =>
    /\b(breaking|rename|remove|drop|migration|major)\b/i.test(message),
  );
  const features = messages.filter((message) =>
    /\b(add|adds|added|support|new|stream|gate|custom|mode|feature)\b/i.test(
      message,
    ),
  );
  const fixes = messages.filter((message) =>
    /\b(fix|fixed|patch|bug|crash|correct)\b/i.test(message),
  );

  if (breaking.length >= 2) return { kind: "minor", confidence: "low" };
  if (features.length >= 2) return { kind: "minor", confidence: "high" };
  if (fixes.length > 0 && features.length === 0) {
    return { kind: "patch", confidence: "high" };
  }
  return { kind: "patch", confidence: "low" };
}

function updateJsonVersion(relativePath, nextVersion) {
  const file = join(root, relativePath);
  const json = JSON.parse(readFileSync(file, "utf8"));
  json.version = nextVersion;
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
}

function replaceInFile(relativePath, before, after) {
  const file = join(root, relativePath);
  const source = readFileSync(file, "utf8");
  if (!source.includes(before)) {
    throw new Error(`${relativePath} did not contain expected text: ${before}`);
  }
  writeFileSync(file, source.replace(before, after));
}

function releaseNotes(version, commits) {
  const lines = commits.map((commit) => `- ${commit}`);
  return `## [${version}]\n\n### Changed\n${lines.join("\n")}\n\n`;
}

const status = git(["status", "--porcelain"]);
if (status) {
  throw new Error("Working tree is dirty. Commit, stash, or discard changes first.");
}

run("git", ["fetch", "--prune", "origin"]);
run("git", ["pull", "--ff-only", "origin", "main"]);

const desktopPkg = JSON.parse(
  readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
);
const currentVersion = desktopPkg.version;
const latestTag = `v${currentVersion}`;
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

if (currentBranch() === "main") {
  run("git", ["checkout", "-b", `release-v${nextVersion}`]);
}

updateJsonVersion("apps/desktop/package.json", nextVersion);
replaceInFile(
  "bun.lock",
  `"apps/desktop": {\n      "name": "desktop",\n      "version": "${currentVersion}",`,
  `"apps/desktop": {\n      "name": "desktop",\n      "version": "${nextVersion}",`,
);

const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${nextVersion}]`)) {
  writeFileSync(
    join(root, "CHANGELOG.md"),
    changelog.replace("## [Unreleased]\n\n", `## [Unreleased]\n\n${releaseNotes(nextVersion, commits)}`),
  );
}

run("node", ["scripts/generate-website-changelog.mjs"]);
run("bun", ["run", "check-types"]);
run("git", ["add", "CHANGELOG.md", "apps/desktop/package.json", "bun.lock", "apps/web", "scripts/release-new-version.mjs", ".codex/skills/release-new-version"]);
run("git", ["commit", "-m", `Release v${nextVersion}`]);
run("git", ["push", "-u", "origin", "HEAD"]);

const prBody = `## Summary
- release Zuse v${nextVersion}
- update CHANGELOG.md and package metadata
- keep the website Change Log page rendering release notes from CHANGELOG.md

## Test
- bun run check-types

Release artifacts are produced by pushing tag v${nextVersion} after this PR lands.`;

run("gh", [
  "pr",
  "create",
  "--base",
  "main",
  "--fill",
  "--title",
  `Release v${nextVersion}`,
  "--body",
  prBody,
]);

console.log(`Prepared release PR for v${nextVersion}.`);
