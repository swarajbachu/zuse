import { describe, expect, it, vi } from "vitest";
import { handleDeviceCommandTool } from "../../src/drivers/device-command-tools.ts";

describe("local command tools", () => {
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
		const request = vi.fn().mockResolvedValue({ state: "pending" });
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
