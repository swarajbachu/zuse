import { parseCloudChatRoute } from "@zuse/client-runtime/environment-scope";
import { describe, expect, it } from "vitest";
import { workspaceLink } from "../src/workspace-link.ts";

describe("Slack workspace links", () => {
	it("uses the existing personal workspace browser route", () => {
		expect(workspaceLink({}, "workspace_one")).toBe(
			"<https://code.zuse.sh/w/personal/chat/workspace_one|View in Zuse>",
		);
	});
	it("preserves the organization and staging origin with encoded identifiers", () => {
		const scope = { kind: "organization", organizationId: "org/one" } as const;
		const link = workspaceLink(
			{
				WORKSPACE_APP_ORIGIN: "https://code-staging.zuse.sh",
				WORKSPACE_SCOPE: scope,
			},
			"workspace/one",
		);
		expect(link).toBe(
			"<https://code-staging.zuse.sh/w/organization/org%2Fone/chat/workspace%2Fone|View in Zuse>",
		);
		const url = new URL(link.slice(1, link.indexOf("|")));
		expect(parseCloudChatRoute(url.pathname)).toEqual({
			scope,
			workspaceId: "workspace/one",
		});
		expect(url.search).toBe("");
		expect(url.hash).toBe("");
	});
});
