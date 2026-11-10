import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	add: vi.fn(),
	notify: vi.fn(),
	request: vi.fn(),
}));
vi.mock("../../src/components/ui/toast.tsx", () => ({
	toastManager: { add: mocks.add },
}));
vi.mock("../../src/lib/plugins-client.ts", () => ({
	claimPluginFailure: () => true,
	notifyPluginsChanged: mocks.notify,
	pluginRequest: mocks.request,
}));

import { redeemPluginReturn } from "../../src/components/plugin-return-redemption.ts";

beforeEach(() => vi.clearAllMocks());
test("shows the provider reason and refreshes failed connections without redeeming a ticket", async () => {
	await redeemPluginReturn({
		ticket: null,
		tenantId: "personal:fixture",
		plugin: "Calendar",
		error: "invalid_scope: Scope is not allowed",
	});
	expect(mocks.add).toHaveBeenCalledWith(
		expect.objectContaining({
			description: "invalid_scope: Scope is not allowed",
			type: "error",
		}),
	);
	expect(mocks.request).not.toHaveBeenCalled();
	expect(mocks.notify).toHaveBeenCalledWith("personal:fixture");
});
