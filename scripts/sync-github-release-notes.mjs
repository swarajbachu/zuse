#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dryRun = process.argv.includes("--dry-run");
const all = process.argv.includes("--all");
const explicitTag = readArg("--tag") ?? process.env.GITHUB_REF_NAME;
const explicitRepo = readArg("--repo") ?? process.env.GITHUB_REPOSITORY;

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

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
}

function normalizeTag(tag) {
  if (!tag) return undefined;
  return tag.startsWith("refs/tags/") ? tag.slice("refs/tags/".length) : tag;
}

function versionFromTag(tag) {
  const normalized = normalizeTag(tag);
  const match = normalized?.match(/^v?(\d+\.\d+\.\d+)$/);
  if (!match) {
    throw new Error(`Expected a semver tag like v0.7.0, got ${tag}`);
  }
  return match[1];
}

function changelogVersions(source) {
  return [...source.matchAll(/^## \[([^\]]+)\]/gm)]
    .map((match) => match[1])
    .filter((version) => version && version !== "Unreleased");
}

function extractChangelogSection(source, version) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `## [${version}]`);
  if (start < 0) {
    throw new Error(`CHANGELOG.md does not contain release notes for ${version}`);
  }

  const end = lines.findIndex(
    (line, index) => index > start && line.startsWith("## ["),
  );
  const section = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
  if (!section) {
    throw new Error(`CHANGELOG.md does not contain release notes for ${version}`);
  }
  return section;
}

function repoSlug() {
  if (explicitRepo) return explicitRepo;

  const remote = git(["config", "--get", "remote.origin.url"]);
  const match =
    remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/) ??
    remote.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match?.[1]) {
    throw new Error(
      "Could not infer GitHub repository. Pass --repo=owner/name or set GITHUB_REPOSITORY.",
    );
  }
  return match[1];
}

function versionTags() {
  return git(["tag", "--list", "v*", "--sort=version:refname"])
    .split("\n")
    .filter(Boolean);
}

function previousTagFor(tag) {
  const tags = versionTags();
  const index = tags.indexOf(tag);
  if (index <= 0) return undefined;
  return tags[index - 1];
}

function renderReleaseBody({ repo, tag, version, section }) {
  const previousTag = previousTagFor(tag);
  const lines = [`## What's new in ${version}`, "", section];

  if (previousTag) {
    lines.push(
      "",
      "---",
      `**Full Changelog:** https://github.com/${repo}/compare/${previousTag}...${tag}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function releaseBodyForTag(tag, source, repo) {
  const version = versionFromTag(tag);
  return renderReleaseBody({
    repo,
    tag,
    version,
    section: extractChangelogSection(source, version),
  });
}

function updateRelease({ tag, body }) {
  if (dryRun) {
    console.log(`\n=== ${tag} ===\n${body}`);
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "zuse-release-notes-"));
  const notesFile = join(dir, `${tag}.md`);
  try {
    writeFileSync(notesFile, body);
    run("gh", ["release", "edit", tag, "--notes-file", notesFile], {
      stdio: "inherit",
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

const tag = normalizeTag(explicitTag);
if (!all && !tag) {
  throw new Error("Pass --tag=vX.Y.Z, set GITHUB_REF_NAME, or use --all.");
}

const source = await readFile(join(root, "CHANGELOG.md"), "utf8");
const repo = repoSlug();
const tags = all
  ? changelogVersions(source)
      .map((version) => `v${version}`)
      .reverse()
  : [tag];

for (const releaseTag of tags) {
  const body = await releaseBodyForTag(releaseTag, source, repo);
  updateRelease({ tag: releaseTag, body });
}
