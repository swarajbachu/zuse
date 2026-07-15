import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
	LinearConnection,
	LinearIssueRef,
	LinearIssueSummary,
} from "../../src/linear.ts";

describe("Linear wire contracts", () => {
	it("round-trips workspace-qualified issue references", () => {
		const encoded = {
			workspaceId: "workspace-1",
			issueId: "issue-1",
			identifier: "ENG-123",
		};
		const decoded = Schema.decodeUnknownSync(LinearIssueRef)(encoded);
		expect(Schema.encodeSync(LinearIssueRef)(decoded)).toEqual(encoded);
	});

	it("keeps duplicate tickers distinct across workspaces", () => {
		const first = LinearIssueSummary.make({
			workspaceId: "workspace-1",
			workspaceName: "Acme",
			issueId: "issue-1",
			identifier: "ENG-123",
			title: "First",
			state: "Todo",
			stateType: "unstarted",
			stateColor: "#6b7280",
			priority: 2,
			assignee: "Ada",
			assigneeAvatarUrl: "https://example.com/ada.png",
			labels: [],
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		const second = LinearIssueSummary.make({
			...first,
			workspaceId: "workspace-2",
			workspaceName: "Beta",
			issueId: "issue-2",
		});
		expect(`${first.workspaceId}:${first.issueId}`).not.toBe(
			`${second.workspaceId}:${second.issueId}`,
		);
	});

	it("preserves issue status and assignee presentation metadata", () => {
		const decoded = Schema.decodeUnknownSync(LinearIssueSummary)({
			workspaceId: "workspace-1",
			workspaceName: "Acme",
			issueId: "issue-1",
			identifier: "ENG-123",
			title: "First",
			state: "In Progress",
			stateType: "started",
			stateColor: "#f59e0b",
			priority: 2,
			assignee: "Ada Lovelace",
			assigneeAvatarUrl: "https://example.com/ada.png",
			labels: [],
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		const encoded = Schema.encodeSync(LinearIssueSummary)(decoded);
		expect(encoded).toMatchObject({
			stateType: "started",
			stateColor: "#f59e0b",
			assigneeAvatarUrl: "https://example.com/ada.png",
		});
	});

	it("never includes OAuth tokens in renderer-visible connections", () => {
		const connection = LinearConnection.make({
			workspaceId: "workspace-1",
			workspaceName: "Acme",
			workspaceKey: "acme",
			viewerName: "Ada",
			viewerEmail: "ada@example.com",
			connectedAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		const encoded = Schema.encodeSync(LinearConnection)(connection);
		expect(JSON.stringify(encoded)).not.toMatch(/access|refresh|token/i);
	});
});
