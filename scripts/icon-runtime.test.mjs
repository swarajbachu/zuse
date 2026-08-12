import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);

const {
	detectIconMode,
	getPaidIconAliases,
	PAID_ICON_PACKAGES,
} = require("./icon-runtime.cjs");

const createPaidIconsFixture = async (installedPackages) => {
	const root = await mkdtemp(join(tmpdir(), "zuse-icons-"));
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: "icon-fixture", private: true }),
	);

	for (const packageName of installedPackages) {
		const packageDir = join(root, "node_modules", ...packageName.split("/"));
		await mkdir(join(packageDir, "dist", "esm"), { recursive: true });
		await writeFile(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: packageName,
				version: "1.0.0",
				module: "./dist/esm/index.js",
			}),
		);
		await writeFile(
			join(packageDir, "dist", "esm", "index.js"),
			"export {};\n",
		);
	}

	return root;
};

test("contributors without paid icon packages use the free icon set", async () => {
	const paidIconsDir = await createPaidIconsFixture([]);
	assert.equal(detectIconMode({ paidIconsDir }), "free");
});

test("a complete paid icon installation selects every paid style", async () => {
	const paidIconsDir = await createPaidIconsFixture(PAID_ICON_PACKAGES);
	assert.equal(detectIconMode({ paidIconsDir }), "paid");

	const aliases = getPaidIconAliases({ paidIconsDir });
	assert.deepEqual(Object.keys(aliases).sort(), [
		"@zuse/icons/bulk-rounded",
		"@zuse/icons/solid-rounded",
		"@zuse/icons/stroke-rounded",
	]);
	for (const alias of Object.values(aliases)) {
		assert.match(alias, /dist\/esm\/index\.js$/);
	}
});

test("a partial paid icon installation fails instead of mixing icon sets", async () => {
	const paidIconsDir = await createPaidIconsFixture([PAID_ICON_PACKAGES[0]]);
	assert.throws(
		() => detectIconMode({ paidIconsDir }),
		/Incomplete paid icon installation/,
	);
});
