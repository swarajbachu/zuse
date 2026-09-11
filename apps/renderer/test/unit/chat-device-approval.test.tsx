import { DeviceBridgeStatus, type DeviceCommand } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DevicePermissionCard } from "../../src/components/device-permission-card.tsx";
import { pendingChatDeviceCommands } from "../../src/lib/chat-device-approval.ts";

const command: DeviceCommand = {
	id: "cmd",
	accountId: "account",
	workspaceId: "cloud-a",
	chatId: "chat-a",
	chatTitle: "Test chat",
	grantEpoch: 0,
	sessionId: "session",
	deviceId: "mac",
	deviceName: "MacBook Pro",
	command: "pwd",
	cwd: "/Users/test",
	state: "pending",
	stdout: "",
	stderr: "",
	exitCode: null,
	truncated: false,
	createdAt: 0,
};
describe("chat device approvals", () => {
	it("shows only pending commands belonging to the selected chat and workspace", () => {
		const status = DeviceBridgeStatus.make({
			version: 1,
			enabled: true,
			connected: true,
			deviceId: "mac",
			deviceName: "MacBook Pro",
			homeDirectory: "/Users/test",
			grants: [],
			commands: [
				command,
				{ ...command, id: "other-chat", chatId: "chat-b" },
				{ ...command, id: "other-workspace", workspaceId: "cloud-b" },
				{ ...command, id: "finished", state: "completed" },
			],
		});
		expect(pendingChatDeviceCommands(status, "cloud-a", "chat-a")).toEqual([
			command,
		]);
		expect(pendingChatDeviceCommands(status, undefined, null)).toEqual([]);
	});
	it("uses the standard permission surface and queues requests instead of floating cards", () => {
		const html = renderToStaticMarkup(
			<DevicePermissionCard
				command={command}
				queueSize={2}
				onDecision={async () => {}}
			/>,
		);
		for (const label of [
			"MacBook Pro",
			"/Users/test",
			"pwd",
			"Allow once",
			"Allow for session",
			"Always allow",
			"Deny",
			"+1",
		])
			expect(html).toContain(label);
		expect(html).toContain("bg-card/95");
		expect(html).not.toContain("fixed");
		expect(html).toContain("h-7");
	});
});
