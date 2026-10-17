import type { HarnessToolContext } from "@zuse/agents/harness/types";
import { expect, it, vi } from "vitest";
import { simulatorHarnessTools } from "../../src/simulators/harness.ts";

const context: HarnessToolContext = {
	agentId: "agent",
	callId: "call",
	signal: new AbortController().signal,
	permissionMode: "default",
	readOnly: false,
};
it("uses the same device surface for native models and converts screenshots to model image content", async () => {
	const client = {
		call: vi.fn(async () => ({
			content: [
				{
					type: "image" as const,
					data: "cG5n",
					mimeType: "image/png" as const,
				},
			],
		})),
	};
	const tools = simulatorHarnessTools({
		client,
		sessionId: "session",
		getRuntimeMode: () => "full-access",
		requestPermission: vi.fn(),
	});
	expect(Object.keys(tools.tools)).toEqual([
		"device_list",
		"device_open",
		"device_screenshot",
		"device_close",
	]);
	expect(tools.tools.device_screenshot?.category).toBe("read");
	expect(tools.tools.device_open?.category).toBe("other");
	expect(
		await tools.execute("device_screenshot", { deviceId: "ABC" }, context),
	).toEqual({
		type: "content",
		value: [
			{
				type: "file",
				mediaType: "image/png",
				data: { type: "data", data: "cG5n" },
			},
		],
	});
	expect(client.call).toHaveBeenCalledWith(
		"session",
		"device_screenshot",
		{ deviceId: "ABC" },
		context.signal,
	);
});
it("keeps read-only subagents and plan turns from changing a simulator", async () => {
	const client = { call: vi.fn() },
		requestPermission = vi.fn();
	const tools = simulatorHarnessTools({
		client,
		sessionId: "session",
		getRuntimeMode: () => "full-access",
		requestPermission,
	});
	await expect(
		tools.execute(
			"device_open",
			{ deviceId: "ABC" },
			{ ...context, readOnly: true },
		),
	).rejects.toThrow("plan mode");
	await expect(
		tools.execute(
			"device_close",
			{ deviceId: "ABC" },
			{ ...context, permissionMode: "plan" },
		),
	).rejects.toThrow("plan mode");
	expect(client.call).not.toHaveBeenCalled();
	expect(requestPermission).not.toHaveBeenCalled();
});
