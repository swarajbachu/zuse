import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";

const workspaceRoot = process.cwd();
const dryRun = process.argv.includes("--dry-run");

const removableDirNames = new Set([
  "node_modules",
  ".turbo",
  ".next",
  ".vercel",
  ".vite",
  ".cache",
  ".parcel-cache",
  ".nuxt",
  ".output",
  ".svelte-kit",
  "coverage",
  "build",
  "dist",
  "dist-electron",
  "out",
  "playwright-report",
  "test-results",
]);

const explicitRelativeDirs = [
  ".context/user-data",
  ".electron-runtime",
  "apps/renderer/hugeicons-migrate-backup-*",
  "apps/renderer/hugeicons-migration-report-*.html",
];

const runGit = (args) =>
  execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

const root = runGit(["rev-parse", "--show-toplevel"]);
if (resolve(root) !== resolve(workspaceRoot)) {
  throw new Error(
    `Archive cleanup must run from the workspace root. Expected ${root}, got ${workspaceRoot}.`,
  );
}

const isInsideRoot = (path) => {
  const resolved = resolve(path);
  return (
    resolved === resolve(workspaceRoot) ||
    resolved.startsWith(`${resolve(workspaceRoot)}/`)
  );
};

const toRelative = (path) => relative(workspaceRoot, path);

const hasTrackedContent = (path) => {
  try {
    const tracked = execFileSync("git", ["ls-files", "--", toRelative(path)], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return tracked.trim().length > 0;
  } catch {
    return false;
  }
};

const shouldRemove = (path) => {
  if (!isInsideRoot(path)) return false;
  if (!existsSync(path)) return false;
  return !hasTrackedContent(path);
};

const removePath = (path, removed) => {
  if (!shouldRemove(path)) return;
  removed.push(toRelative(path) || ".");
  if (dryRun) return;
  rmSync(path, { recursive: true, force: true });
};

const walk = (dir, removed) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.name === ".git") continue;

    if (entry.isDirectory()) {
      if (removableDirNames.has(entry.name)) {
        removePath(path, removed);
        continue;
      }
      walk(path, removed);
      continue;
    }

    if (
      entry.isFile() &&
      (entry.name === ".DS_Store" ||
        entry.name.startsWith("npm-debug.log") ||
        entry.name.startsWith("yarn-debug.log") ||
        entry.name.startsWith("yarn-error.log"))
    ) {
      removePath(path, removed);
    }
  }
};

const expandGlob = (pattern) => {
  try {
    const output = execFileSync(
      "bash",
      ["-lc", `compgen -G ${JSON.stringify(pattern)}`],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return output.length === 0
      ? []
      : output.split("\n").map((path) => resolve(workspaceRoot, path));
  } catch {
    return [];
  }
};

const removed = [];
for (const relativePath of explicitRelativeDirs) {
  if (relativePath.includes("*")) {
    for (const path of expandGlob(relativePath)) removePath(path, removed);
  } else {
    removePath(resolve(workspaceRoot, relativePath), removed);
  }
}
walk(workspaceRoot, removed);

if (removed.length === 0) {
  console.log("archive cleanup: nothing to remove");
} else {
  for (const path of removed.sort()) {
    console.log(`${dryRun ? "would remove" : "removed"} ${path}`);
  }
}
