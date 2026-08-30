import type { CloudChatSummary } from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

import { retryCloudConnection } from "../../src/components/cloud-connection-notice.tsx";

describe("cloud connection notice", () => {
	it("wakes a paused workspace when Retry is clicked", async () => {
		const summary = { workspaceId: "workspace-1" } as CloudChatSummary;
		const attach = vi.fn(async () => undefined);

		await retryCloudConnection(summary, attach);

		expect(attach).toHaveBeenCalledWith(summary, "wake");
	});
});
