import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { Agent, Cursor } from "@cursor/sdk";

if (typeof Agent.create !== "function" || typeof Cursor.models.list !== "function") {
  throw new Error("Bundled provider SDK did not expose its local runtime API.");
}

if (process.platform === "darwin") {
  const require = createRequire(import.meta.url);
  const packageName = `@cursor/sdk-darwin-${process.arch}`;
  const packageJson = require.resolve(`${packageName}/package.json`);
  const bin = join(dirname(packageJson), "bin");
  await Promise.all([access(join(bin, "cursorsandbox")), access(join(bin, "rg"))]);
}

console.log("Bundled provider SDK runtime smoke passed.");
