import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CloudEnvironmentRecoverySurface } from "../../src/components/cloud-environment-recovery.tsx";

const snapshot = (
	status: ConnectionSnapshot["status"],
	attempt = 0,
): ConnectionSnapshot => ({
	key: "environment:env_cloud_1",
	status,
	generation: 0,
	attempt,
	error: attempt > 0 ? "private connection detail" : null,
});

describe("CloudEnvironmentRecoverySurface", () => {
	it("shows stable progress while the selected machine connects", () => {
		const markup = renderToStaticMarkup(
			<CloudEnvironmentRecoverySurface
				onRetry={vi.fn()}
				onReturnToLocal={vi.fn()}
				snapshot={snapshot("connecting")}
			/>,
		);

		expect(markup).toContain('aria-busy="true"');
		expect(markup).toContain("Connecting to your cloud machine");
		expect(markup).not.toContain("Return to this Mac");
	});

	it("offers retry and return-to-local after a failed attempt", () => {
		const markup = renderToStaticMarkup(
			<CloudEnvironmentRecoverySurface
				onRetry={vi.fn()}
				onReturnToLocal={vi.fn()}
				snapshot={snapshot("reconnecting", 1)}
			/>,
		);

		expect(markup).toContain("Cloud machine unavailable");
		expect(markup).toContain("Try again");
		expect(markup).toContain("Return to this Mac");
		expect(markup).not.toContain("private connection detail");
	});
});
