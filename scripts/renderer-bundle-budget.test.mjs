import assert from "node:assert/strict";
import test from "node:test";

import {
	collectEntryAssets,
	collectRouteAssets,
} from "./renderer-bundle-budget.mjs";

const manifest = {
	"index.html": {
		file: "assets/main.js",
		imports: ["_react.js"],
		dynamicImports: ["src/application.tsx"],
		isEntry: true,
	},
	"_react.js": { file: "assets/react.js" },
	"src/application.tsx": {
		file: "assets/application.js",
		imports: ["_effect.js"],
		dynamicImports: ["src/settings.tsx"],
	},
	"_effect.js": { file: "assets/effect.js" },
	"src/settings.tsx": { file: "assets/settings.js" },
};

test("entry assets include only the static bootstrap graph", () => {
	assert.deepEqual(collectEntryAssets(manifest, "index.html"), [
		"assets/main.js",
		"assets/react.js",
	]);
});

test("route assets include its static graph without unrelated lazy features", () => {
	assert.deepEqual(
		collectRouteAssets(manifest, "index.html", "src/application.tsx"),
		[
			"assets/application.js",
			"assets/effect.js",
			"assets/main.js",
			"assets/react.js",
		],
	);
});
