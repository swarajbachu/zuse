import { describe, expect, it, vi } from "vitest";

import {
	linearGraphql,
	makeLinearIssueListRequest,
	renderLinearIssueMarkdown,
	rewriteMarkdownImages,
} from "../../src/linear/linear-api.ts";

describe("Linear API boundary", () => {
	it("uses public workspace-wide issue filtering for non-empty queries", () => {
		const request = makeLinearIssueListRequest({
			query: "  new test  ",
			viewerId: "viewer-1",
			after: "cursor-1",
		});
		expect(request.rootField).toBe("issues");
		expect(request.document).toContain("issues(");
		expect(request.document).not.toContain("issueSearch(");
		expect(request.variables).toEqual({
			first: 50,
			after: "cursor-1",
			filter: { searchableContent: { contains: "new test" } },
		});
	});

	it("keeps the empty issue list scoped to the viewer's open work", () => {
		const request = makeLinearIssueListRequest({
			query: "",
			viewerId: "viewer-1",
			after: null,
		});
		expect(request.rootField).toBe("issues");
		expect(request.variables).toMatchObject({
			filter: {
				assignee: { id: { eq: "viewer-1" } },
				state: { type: { nin: ["completed", "canceled"] } },
			},
		});
	});

	it("rejects GraphQL partial errors even when HTTP succeeds", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						data: { viewer: null },
						errors: [{ message: "nope" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		await expect(
			linearGraphql(fetcher, "secret", "query Viewer { viewer { id } }", {}),
		).rejects.toThrow("nope");
	});

	it("retries one rate-limited GraphQL request using retry-after", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("rate limited", {
					status: 429,
					headers: { "retry-after": "0" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ data: { viewer: { id: "viewer" } } }), {
					status: 200,
				}),
			);
		await expect(
			linearGraphql<{ viewer: { id: string } }>(
				fetcher,
				"secret",
				"query Viewer { viewer { id } }",
				{},
			),
		).resolves.toEqual({ viewer: { id: "viewer" } });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("renders a complete issue document", () => {
		const markdown = renderLinearIssueMarkdown({
			identifier: "ENG-123",
			title: "Fix sync",
			url: "https://linear.app/acme/issue/ENG-123/fix-sync",
			workspaceName: "Acme",
			state: "In Progress",
			priorityLabel: "High",
			assignee: "Ada",
			labels: ["bug", "desktop"],
			project: "Reliability",
			cycle: "Cycle 8",
			description: "The description.",
			relations: [
				{ type: "blocks", identifier: "ENG-124", title: "Follow-up" },
			],
			comments: [
				{
					author: "Lin",
					createdAt: "2026-07-15T01:02:03.000Z",
					body: "A comment.",
				},
			],
			warnings: [],
		});
		expect(markdown).toContain("# ENG-123 — Fix sync");
		expect(markdown).toContain("**State:** In Progress");
		expect(markdown).toContain("## Relations");
		expect(markdown).toContain("## Comment by Lin");
	});

	it("deduplicates images and preserves failed remote URLs", async () => {
		const download = vi.fn(async (url: string) =>
			url.includes("ok") ? `assets/ENG-123/image.png` : null,
		);
		const result = await rewriteMarkdownImages(
			"![one](https://uploads.linear.app/ok)\n![again](https://uploads.linear.app/ok)\n![bad](https://uploads.linear.app/bad)",
			download,
		);
		expect(download).toHaveBeenCalledTimes(2);
		expect(result.markdown.match(/assets\/ENG-123\/image\.png/g)).toHaveLength(
			2,
		);
		expect(result.markdown).toContain("https://uploads.linear.app/bad");
		expect(result.warnings).toHaveLength(1);
	});
});
