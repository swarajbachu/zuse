import { describe, expect, it } from "vitest";

import { parseRemoteUrl } from "../../src/git-service-live.ts";

describe("parseRemoteUrl", () => {
	it("preserves credential-free SSH clone URLs", () => {
		expect(parseRemoteUrl("git@git.example.com:team/project.git")).toEqual({
			host: "git.example.com",
			owner: "team",
			repo: "project",
			cloneUrl: "git@git.example.com:team/project.git",
		});
	});

	it("removes credentials and URL metadata from HTTPS origins", () => {
		expect(
			parseRemoteUrl(
				"https://user:secret@git.example.com/team/project.git?token=other#readme",
			),
		).toEqual({
			host: "git.example.com",
			owner: "team",
			repo: "project",
			cloneUrl: "https://git.example.com/team/project.git",
		});
	});

	it("rejects local and unsupported transports", () => {
		expect(parseRemoteUrl("file:///tmp/project.git")).toBeNull();
		expect(parseRemoteUrl("../project")).toBeNull();
	});
});
