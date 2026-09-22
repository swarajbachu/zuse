import { expect, test } from "vitest";
import { isCloudSyncExcludedPath } from "../../src/cloud-sync-paths.ts";

test.each([
	"node_modules/pkg/index.js",
	"apps/web/node_modules/pkg/index.js",
	"apps/web/.cache/state",
	"apps/web/.turbo/build.log",
	".next/cache/pack",
	"apps/web/.next/cache/pack",
	"apps/web/__pycache__/module.pyc",
	"apps/web/.pytest_cache/state",
	"apps/web/.git/index.lock",
	"apps/web/.zuse-rsync-partial/file",
	".zuse-sync.json",
	"./apps/web/.cache/state",
	"apps\\web\\.cache\\state",
])("excludes generated activity: %s", (path) => {
	expect(isCloudSyncExcludedPath(path)).toBe(true);
});

test.each([
	"src/index.ts",
	"apps/web/.next/config.json",
	"apps/web/.next/cache-config.json",
	"apps/web/.cache-config",
	"apps/web/node_modules.ts",
	".gitignore",
	"",
])("preserves source and unknown activity: %s", (path) => {
	expect(isCloudSyncExcludedPath(path)).toBe(false);
});
