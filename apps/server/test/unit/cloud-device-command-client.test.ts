import { afterEach, expect, it, vi } from "vitest";
import { CloudDeviceCommandClient } from "../../src/device-bridge/cloud-client.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it("reports the command ID on response loss and never resubmits execution", async () => {
	vi.useFakeTimers();
	const fetch = vi.fn().mockRejectedValue(new Error("response lost"));
	vi.stubGlobal("fetch", fetch);
	const client = new CloudDeviceCommandClient(
		"https://api.test/bridge",
		() => "runtime",
	);
	try {
		await expect(
			client.request({
				_tag: "execute",
				input: { id: "lost-command", command: "touch marker", cwd: "/tmp" },
			}),
		).rejects.toThrow("lost-command has an unknown outcome");
		await vi.advanceTimersByTimeAsync(30000);
		expect(fetch).toHaveBeenCalledTimes(1);
	} finally {
		client.close();
	}
});
