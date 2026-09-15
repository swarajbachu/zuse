import { MarketplaceExtension } from "@zuse/contracts";
import { Schema } from "effect";
import { expect, it } from "vitest";
import catalog from "../../../web/public/extensions/staging/catalog.v1.json";
import { visibleMarketplaceEntries } from "../../src/lib/extension-marketplace.ts";

const entries = catalog.entries.map((entry) =>
	Schema.decodeUnknownSync(MarketplaceExtension)({
		...entry,
		id: entry.manifest.id,
		installed: false,
		updateAvailable: false,
	}),
);
it("reconciles stale fetched flags immediately after install, update, and removal", () => {
	const entry = entries[0];
	if (!entry) throw Error("Missing catalog fixture");
	const current = {
		id: entry.id,
		manifest: entry.manifest,
		activeCommit: entry.commit,
	};
	expect(visibleMarketplaceEntries([entry], [current], "")[0]).toMatchObject({
		installed: true,
		updateAvailable: false,
	});
	expect(
		visibleMarketplaceEntries(
			[entry],
			[{ ...current, activeCommit: "older" }],
			"",
		)[0],
	).toMatchObject({ installed: true, updateAvailable: true });
	expect(
		visibleMarketplaceEntries([{ ...entry, installed: true }], [], "")[0],
	).toMatchObject({ installed: false, updateAvailable: false });
});
it("searches names, descriptions and contributions without altering the installed state", () => {
	expect(
		visibleMarketplaceEntries(entries, [], "  TEST reports ").map(
			(entry) => entry.id,
		),
	).toEqual(["test-reports"]);
	expect(
		visibleMarketplaceEntries(entries, [], "failed").map((entry) => entry.id),
	).toContain("test-reports");
	expect(visibleMarketplaceEntries(entries, [], "zzzz-unmatched")).toEqual([]);
});
