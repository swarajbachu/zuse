#!/usr/bin/env node
import { resolve } from "node:path";

import { runStdioServer } from "./server.ts";

interface ParsedArgs {
  readonly workspace: string;
  readonly branch: string | undefined;
  readonly reindexOnBoot: boolean;
}

const usage = `Usage: zuse-mcp --workspace <path> [--branch <branch>] [--reindex]

Options:
  --workspace <path>   Absolute or relative path to the repo to index.
  --branch <branch>    Branch name to serve. Defaults to HEAD.
  --reindex            Run a full reindex before serving. Defaults to off.
                       (The server will serve an empty index until the
                       host runs reindex via the index_status tool.)
  -h, --help           Print this help.`;

const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  let workspace = process.cwd();
  let branch: string | undefined;
  let reindex = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(usage + "\n");
        process.exit(0);
      case "--workspace":
        workspace = resolve(argv[++i] ?? process.cwd());
        break;
      case "--branch":
        branch = argv[++i];
        break;
      case "--reindex":
        reindex = true;
        break;
      default:
        if (arg && arg.startsWith("--")) {
          process.stderr.write(`Unknown flag: ${arg}\n${usage}\n`);
          process.exit(2);
        }
    }
  }
  return { workspace, branch, reindexOnBoot: reindex };
};

const main = async () => {
  const { workspace, branch, reindexOnBoot } = parseArgs(process.argv.slice(2));
  process.stderr.write(
    `[zuse-mcp] starting workspace=${workspace} branch=${branch ?? "HEAD"}\n`,
  );
  if (reindexOnBoot) {
    const { startServerHandle } = await import("./handle.ts");
    const handle = await startServerHandle({ workspace, branch });
    process.stderr.write("[zuse-mcp] reindexing …\n");
    const out = await handle.reindex();
    process.stderr.write(
      `[zuse-mcp] reindex done — processed=${out.processed}\n`,
    );
    await handle.close();
  }
  await runStdioServer({ workspace, branch });
};

main().catch((err) => {
  process.stderr.write(
    `[zuse-mcp] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
