import { describe, expect, it, vi } from "vitest";

import {
	callLinearTool,
	ensureLinearToolPermission,
	type LinearToolDeps,
} from "../../src/drivers/linear-tools.ts";

const deps: LinearToolDeps = {
	searchIssues: vi.fn(async () => ({ ok: true as const, data: [] })),
	getIssue: vi.fn(async () => ({
		ok: true as const,
		data: { identifier: "ENG-1" },
	})),
	addComment: vi.fn(async () => ({
		ok: true as const,
		data: { id: "comment-1" },
	})),
	updateIssue: vi.fn(async () => ({
		ok: true as const,
		data: { identifier: "ENG-1" },
	})),
};

describe("Linear connector tools", () => {
	it("executes reads without a mutation permission", async () => {
		const requestPermission = vi.fn();
		await ensureLinearToolPermission(
			"linear_get_issue",
			{ issue: "ENG-1" },
			{
				requestPermission,
				getRuntimeMode: () => "full-access",
				getPermissionMode: () => "default",
			},
		);
		expect(requestPermission).not.toHaveBeenCalled();
	});

	it("denies mutations in plan mode", async () => {
		await expect(
			ensureLinearToolPermission(
				"linear_update_issue",
				{ issue: "ENG-1" },
				{
					requestPermission: vi.fn(),
					getRuntimeMode: () => "full-access",
					getPermissionMode: () => "plan",
				},
			),
		).rejects.toThrow("blocked in plan mode");
	});

	it("passes broad update fields through the public tool seam", async () => {
		const result = await callLinearTool(deps, "linear_update_issue", {
			issue: "ENG-1",
			status: "Done",
			labels: ["bug"],
		});
		expect(result.isError).not.toBe(true);
		expect(deps.updateIssue).toHaveBeenCalledWith({
			issue: "ENG-1",
			status: "Done",
			labels: ["bug"],
		});
	});
});
