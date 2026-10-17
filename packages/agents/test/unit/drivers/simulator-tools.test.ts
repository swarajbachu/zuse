import { expect, it, vi } from "vitest";
import {
	handleSimulatorTool,
	type SimulatorToolOptions,
} from "../../../src/drivers/simulator-tools.ts";

function options(
	mode: "plan" | "full-access" | "default",
	allow = true,
): SimulatorToolOptions {
	return {
		client: {
			call: vi.fn(async () => ({
				content: [{ type: "text" as const, text: "done" }],
			})),
		},
		getRuntimeMode: () =>
			mode === "full-access" ? "full-access" : "approval-required",
		getPermissionMode: () => (mode === "plan" ? "plan" : "default"),
		requestPermission: vi.fn(async () =>
			allow ? { _tag: "AllowOnce" as const } : { _tag: "Deny" as const },
		),
	};
}
it("blocks device mutations in plan mode before calling host or prompting", async () => {
	const settings = options("plan");
	for (const name of ["device_open", "device_close"]) {
		await expect(
			handleSimulatorTool(
				name,
				{ deviceId: "ABC" },
				settings,
				"session",
				new AbortController().signal,
			),
		).rejects.toThrow("plan mode");
	}
	expect(settings.client.call).not.toHaveBeenCalled();
	expect(settings.requestPermission).not.toHaveBeenCalled();
});
it("allows read-only screenshots in plan mode while retaining the session identity", async () => {
	const settings = options("plan"),
		signal = new AbortController().signal;
	await handleSimulatorTool(
		"device_screenshot",
		{ deviceId: "ABC" },
		settings,
		"session-a",
		signal,
	);
	expect(settings.client.call).toHaveBeenCalledWith(
		"session-a",
		"device_screenshot",
		{ deviceId: "ABC" },
		signal,
	);
	expect(settings.requestPermission).not.toHaveBeenCalled();
});
it("honors a denied device action", async () => {
	const settings = options("default", false);
	await expect(
		handleSimulatorTool(
			"device_open",
			{ deviceId: "ABC" },
			settings,
			"session",
			new AbortController().signal,
		),
	).rejects.toThrow("denied");
	expect(settings.client.call).not.toHaveBeenCalled();
});
it("does not dispatch cancelled tools", async () => {
	const settings = options("full-access"),
		controller = new AbortController();
	controller.abort();
	await expect(
		handleSimulatorTool(
			"device_list",
			{},
			settings,
			"session",
			controller.signal,
		),
	).rejects.toThrow();
	expect(settings.client.call).not.toHaveBeenCalled();
});
