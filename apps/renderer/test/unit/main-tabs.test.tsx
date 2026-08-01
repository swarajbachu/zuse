import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatTabButton } from "../../src/components/main-tabs.tsx";

describe("ChatTabButton", () => {
	it("keeps the established title visible while a new turn starts", () => {
		const markup = renderToStaticMarkup(
			<ChatTabButton
				active
				label="Stable Session Title"
				providerId="codex"
				booting
				running={false}
				activityState="working"
				awaitingPermission={false}
				awaitingPlanApproval={false}
				onClick={vi.fn()}
				onClose={vi.fn()}
				onRename={vi.fn()}
			/>,
		);

		expect(markup).toContain("Stable Session Title");
		expect(markup).not.toContain('class="truncate">Starting agent');
	});
});
