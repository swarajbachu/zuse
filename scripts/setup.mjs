import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

const workspaceRoot = process.cwd();
const commonDir = execFileSync(
  "git",
  ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  { cwd: workspaceRoot, encoding: "utf8" },
).trim();
const repoRoot = join(commonDir, "..");

const lockfiles = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const left = readFileSync(a);
  const right = readFileSync(b);
  return left.length === right.length && left.equals(right);
}

function lockfilesMatch() {
  for (const lockfile of lockfiles) {
    const source = join(repoRoot, lockfile);
    const target = join(workspaceRoot, lockfile);
    if (existsSync(source) || existsSync(target))
      return sameFile(source, target);
  }
  return false;
}

function isEmptyDir(path) {
  try {
    return lstatSync(path).isDirectory() && readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

const sourceNodeModules = join(repoRoot, "node_modules");
const targetNodeModules = join(workspaceRoot, "node_modules");

if (existsSync(sourceNodeModules) && lockfilesMatch()) {
  let canLink = false;
  if (!existsSync(targetNodeModules)) {
    canLink = true;
  } else if (lstatSync(targetNodeModules).isSymbolicLink()) {
    console.log("node_modules already symlinked");
  } else if (isEmptyDir(targetNodeModules)) {
    rmSync(targetNodeModules, { recursive: false });
    canLink = true;
  } else {
    console.log("node_modules exists; leaving it untouched");
  }

  if (canLink) {
    symlinkSync(sourceNodeModules, targetNodeModules, "dir");
    console.log(`linked node_modules -> ${sourceNodeModules}`);
  }
} else {
  console.log("node_modules not linked; running bun install");
  execFileSync("bun", ["install"], { cwd: workspaceRoot, stdio: "inherit" });
}
