import { describe, expect, it, vi } from "vitest";
import { handleDeviceCommandTool } from "../../src/drivers/device-command-tools.ts";

describe("local command tools", () => {
	it("keeps the tool open through approval and execution, returning only the final output", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ state: "pending", id: "cmd" })
			.mockResolvedValueOnce({ state: "running", id: "cmd" })
			.mockResolvedValueOnce({
				state: "completed",
				id: "cmd",
				stdout: "hello",
				exitCode: 0,
			});
		let settled = false;
		const execution = handleDeviceCommandTool(
			{ request },
			"local_command_execute",
			{ command: "printf hello", cwd: "/tmp" },
			false,
		).then((result) => {
			settled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(settled).toBe(false);
		const result = await execution;
		expect(JSON.parse(result.content[0]?.text ?? "null")).toMatchObject({
			state: "completed",
			stdout: "hello",
			exitCode: 0,
		});
		expect(
			request.mock.calls.filter(([action]) => action._tag === "execute"),
		).toHaveLength(1);
	});
	it.each([
		"denied",
		"cancelled",
		"interrupted",
		"unknown",
	])("returns terminal %s without replaying execution", async (state) => {
		const request = vi.fn().mockResolvedValue({ state });
		const result = await handleDeviceCommandTool(
			{ request },
			"local_command_execute",
			{ command: "pwd", cwd: "/tmp" },
			false,
		);
		expect(JSON.parse(result.content[0]?.text ?? "null").state).toBe(state);
		expect(request).toHaveBeenCalledTimes(1);
	});
	it("cancels the same command when the tool request is aborted while awaiting approval", async () => {
		const request = vi.fn().mockResolvedValue({ state: "pending" });
		const abort = new AbortController();
		const execution = handleDeviceCommandTool(
			{ request },
			"local_command_execute",
			{ command: "pwd", cwd: "/tmp" },
			false,
			abort.signal,
		);
		await Promise.resolve();
		abort.abort();
		await expect(execution).rejects.toThrow("interrupted");
		expect(request).toHaveBeenLastCalledWith({
			_tag: "cancel",
			id: request.mock.calls[0]?.[0].input.id,
		});
	});
	it("does not expose execution in plan mode", async () => {
		const request = vi.fn();
		await expect(
			handleDeviceCommandTool(
				{ request },
				"local_command_execute",
				{ command: "touch x", cwd: "/tmp" },
				true,
			),
		).rejects.toThrow("plan mode");
		expect(request).not.toHaveBeenCalled();
	});
	it("sends no model-supplied target, account, workspace, or permission grant", async () => {
		const request = vi.fn().mockResolvedValue({ state: "completed" });
		await handleDeviceCommandTool(
			{ request },
			"local_command_execute",
			{
				command: "pwd",
				cwd: "/tmp",
				deviceId: "other",
				accountId: "intruder",
				decision: "AlwaysAllow",
			},
			false,
		);
		expect(request).toHaveBeenCalledWith({
			_tag: "execute",
			input: { id: expect.any(String), command: "pwd", cwd: "/tmp" },
		});
	});
});
