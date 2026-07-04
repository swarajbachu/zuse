#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const changelogPath = join(root, "CHANGELOG.md");
const outputPath = join(root, "apps/web/content/changelog.json");

function parseChangelog(source) {
  const releases = [];
  let currentRelease = null;
  let currentSection = null;

  for (const line of source.split(/\r?\n/)) {
    const releaseMatch = line.match(/^## \[([^\]]+)\]/);
    if (releaseMatch) {
      if (currentRelease) releases.push(currentRelease);
      currentRelease = { version: releaseMatch[1] ?? "", sections: [] };
      currentSection = null;
      continue;
    }

    const sectionMatch = line.match(/^### (.+)$/);
    if (sectionMatch && currentRelease) {
      currentSection = { title: sectionMatch[1] ?? "", items: [] };
      currentRelease.sections.push(currentSection);
      continue;
    }

    if (line.startsWith("- ") && currentSection) {
      currentSection.items.push(line.slice(2));
    }
  }

  if (currentRelease) releases.push(currentRelease);

  return releases.filter((release) =>
    release.sections.some((section) => section.items.length > 0),
  );
}

const releases = parseChangelog(readFileSync(changelogPath, "utf8"));
writeFileSync(outputPath, `${JSON.stringify(releases, null, 2)}\n`);
console.log(`Wrote ${releases.length} changelog releases to ${outputPath}`);
