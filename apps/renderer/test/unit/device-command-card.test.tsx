import type { DeviceCommand } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceCommandCard } from "../../src/components/device-command-card.tsx";

import { ToolRow } from "../../src/components/tool-row.tsx";

const command: DeviceCommand = {
	id: "command",
	accountId: "account",
	workspaceId: "workspace",
	chatId: "chat",
	chatTitle: "Fix login",
	sessionId: "session",
	grantEpoch: 0,
	deviceId: "desktop",
	deviceName: "My Mac",
	cwd: "/Users/test/project",
	command: "git status",
	state: "pending",
	stdout: "",
	stderr: "",
	exitCode: null,
	truncated: false,
	createdAt: 0,
};
const render = (value = command) =>
	renderToStaticMarkup(
		<DeviceCommandCard
			command={value}
			busy={false}
			onAction={async () => {}}
		/>,
	);
describe("device command approval", () => {
	it("names the computer, chat, command and local working directory before all four approval choices", () => {
		const html = render();
		for (const text of [
			"My Mac",
			"Fix login",
			"git status",
			"/Users/test/project",
			"Allow once",
			"Allow for this session",
			"Always allow",
			"Deny",
		])
			expect(html).toContain(text);
		expect(html).not.toContain("h-8");
		expect(html).toContain("h-7");
	});
	it("shows cancellation only while running and never offers approval for unknown outcomes", () => {
		expect(render({ ...command, state: "running" })).toContain("Stop command");
		const html = render({ ...command, state: "unknown" });
		expect(html).not.toContain("Allow once");
		expect(html).not.toContain("Stop command");
	});
	it("shows the exit code, output, and truncation marker", () => {
		const html = render({
			...command,
			state: "completed",
			exitCode: 7,
			stdout: "hello",
			stderr: "failure",
			truncated: true,
		});
		for (const text of ["Exit 7", "hello", "failure", "Truncated"])
			expect(html).toContain(text);
	});
});

it.each([
	"local_command_execute",
	"mcp__zuse__local_command_execute",
])("renders %s as a local shell row", (tool) => {
	const html = renderToStaticMarkup(
		<ToolRow
			tool={tool}
			input={{ command: "git status", cwd: "/Users/test" }}
		/>,
	);
	expect(html).toContain("Local computer");
	expect(html).toContain("Local command");
	expect(html).toContain("git status");
});
