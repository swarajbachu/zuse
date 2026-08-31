import type { CloudChatSummary } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

import { retryCloudConnection } from "../../src/components/cloud-connection-notice.tsx";

describe("cloud connection notice", () => {
	it("wakes a paused workspace when Retry is clicked", async () => {
		const summary = { workspaceId: "workspace-1" } as CloudChatSummary;
		const attach = vi.fn(async () => undefined);
		const retryConnection = vi.fn();

		await retryCloudConnection(summary, attach, retryConnection);

		expect(attach).toHaveBeenCalledWith(summary, "wake");
		expect(retryConnection).toHaveBeenCalledWith("workspace-1");
	});

	it("does not retry the client before workspace recovery succeeds", async () => {
		const summary = { workspaceId: "workspace-1" } as CloudChatSummary;
		const attach = vi.fn(async () => {
			throw new Error("resume failed");
		});
		const retryConnection = vi.fn();

		await expect(
			retryCloudConnection(summary, attach, retryConnection),
		).rejects.toThrow("resume failed");

		expect(retryConnection).not.toHaveBeenCalled();
	});
});
