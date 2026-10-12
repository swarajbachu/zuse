import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpTerminalSession } from "../../../../src/drivers/acp/terminal.ts";

describe("ACP terminal ownership", () => {
	it("isolates connections and retains released output for late tool updates", async () => {
		const terminalContext = () => ({
			cwd: process.cwd(),
			getRuntimeMode: () => "approval-required" as const,
			requestPermission: async () => ({ _tag: "AllowOnce" as const }),
		});
		const first = createAcpTerminalSession(terminalContext);
		const other = createAcpTerminalSession(terminalContext);
		try {
			const created = (await first.handle("terminal/create", {
				command: process.execPath,
				args: ["-e", "process.stdout.write('terminal result')"],
			})) as { terminalId: string };
			await expect(other.handle("terminal/output", created)).rejects.toThrow(
				"Unknown terminal",
			);
			await first.handle("terminal/wait_for_exit", created);
			await first.handle("terminal/release", created);
			const update = await first.resolveUpdate({
				sessionUpdate: "tool_call_update",
				toolCallId: "command",
				content: [{ type: "terminal", terminalId: created.terminalId }],
			});
			expect(update).toMatchObject({
				content: [
					{
						type: "content",
						content: { type: "text", text: "terminal result" },
					},
				],
			});
		} finally {
			await first.close();
			await other.close();
		}
		await expect(first.handle("terminal/create", {})).rejects.toThrow("closed");
	});

	it("rejects a working directory that escapes through a symlink", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "zuse-acp-term-"));
		const workspace = path.join(root, "workspace");
		const outside = path.join(root, "outside");
		try {
			await mkdir(workspace, { recursive: true });
			await mkdir(outside, { recursive: true });
			await symlink(outside, path.join(workspace, "link"));
			const session = createAcpTerminalSession(() => ({ cwd: workspace }));
			try {
				await expect(
					session.handle("terminal/create", {
						command: "pwd",
						cwd: path.join(workspace, "link"),
					}),
				).rejects.toThrow(/escapes workspace/);
				await expect(
					session.handle("terminal/create", {
						command: "pwd",
						cwd: "link",
					}),
				).rejects.toThrow(/escapes workspace/);
			} finally {
				await session.close();
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
