import * as fs from "node:fs/promises";
import * as path from "node:path";

const CONTEXT_IGNORE_ENTRY = ".context";
const SQLITE_SUFFIXES = [".sqlite", ".sqlite-shm", ".sqlite-wal"] as const;

const hasContextIgnore = (content: string): boolean =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === CONTEXT_IGNORE_ENTRY);

const ensureContextGitignore = async (root: string): Promise<void> => {
  const gitignorePath = path.join(root, ".gitignore");
  let content = "";
  try {
    content = await fs.readFile(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (hasContextIgnore(content)) return;

  const prefix =
    content.length === 0
      ? ""
      : content.endsWith("\n")
        ? content
        : `${content}\n`;
  await fs.writeFile(
    gitignorePath,
    `${prefix}${CONTEXT_IGNORE_ENTRY}\n`,
    "utf8",
  );
};

const isSqliteArtifact = (filePath: string): boolean =>
  SQLITE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));

const removeSqliteArtifacts = async (dir: string): Promise<void> => {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await removeSqliteArtifacts(child);
        return;
      }
      if (!entry.isFile() || !isSqliteArtifact(child)) return;
      await fs.rm(child, { force: true }).catch(() => {});
    }),
  );
};

export const prepareProjectRegistration = async (
  root: string,
): Promise<void> => {
  await ensureContextGitignore(root);
  await Promise.all([
    removeSqliteArtifacts(path.join(root, ".zuse")),
    removeSqliteArtifacts(path.join(root, ".memoize")),
  ]);
};

export const projectRegistrationTestHelpers = {
  hasContextIgnore,
  isSqliteArtifact,
};
