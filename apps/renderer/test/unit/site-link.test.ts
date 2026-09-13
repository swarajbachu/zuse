import { describe, expect, it } from "vitest";
import { knownSiteLink } from "../../src/lib/site-link";

describe("known service link labels", () => {
	it.each([
		[
			"https://github.com/swarajbachu/zuse/pull/546",
			"github",
			"swarajbachu/zuse#546",
		],
		[
			"https://github.com/team/repo/issues/42?tab=comments#latest",
			"github",
			"team/repo#42",
		],
		[
			"https://github.com/team/repo/commit/123456789abcdef",
			"github",
			"team/repo@1234567",
		],
		["https://github.com/team/repo/tree/main", "github", "team/repo/tree/main"],
		["https://github.com", "github", "GitHub"],
		[
			"https://gitlab.com/group/subgroup/project/-/merge_requests/12",
			"gitlab",
			"group/subgroup/project!12",
		],
		[
			"https://gitlab.com/group/project/-/issues/7",
			"gitlab",
			"group/project#7",
		],
		["https://linear.app/team/issue/APP-42/fix-links", "linear", "APP-42"],
		[
			"https://www.figma.com/design/abc123/Design-System",
			"figma",
			"Design System",
		],
		[
			"https://example.notion.site/Project-notes-1234567890abcdef1234567890abcdef",
			"notion",
			"Project notes",
		],
	])("formats %s without losing the resource identity", (url, site, label) => {
		expect(knownSiteLink(url)).toEqual({ site, label });
	});

	it.each([
		"https://github.com.attacker.example/team/repo/pull/546",
		"https://github.com@attacker.example/team/repo/pull/546",
		"https://attacker-notion.site/page",
		"https://github.com:8443/team/repo",
		"javascript:alert(1)",
		"file:///tmp/github.com",
		"https://github.com/%broken",
	])("does not disguise an unrecognized destination: %s", (url) => {
		expect(knownSiteLink(url)).toBeNull();
	});
});
