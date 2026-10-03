import type { SDKCustomTool } from "@cursor/sdk";
import { maskSecrets } from "@zuse/utils/environment";
import type { AcpPermissionContext } from "../kernel/acp-permission-context.ts";
import { handleTerminalRequest } from "./acp/terminal.ts";

/** Adapter for SDKs without per-session env: use the existing permission-gated
 * command runner, never process.env or a plaintext shell profile. */
export function makeEnvironmentCommand(context: AcpPermissionContext) {
	const active = new Set<string>();
	let generation = 0;
	const values = Object.values(context.executionEnvironment ?? {});
	const close = async () => {
		generation++;
		await Promise.all(
			[...active].map((terminalId) =>
				handleTerminalRequest("terminal/release", { terminalId }, context),
			),
		);
		active.clear();
	};
	const tool: SDKCustomTool = {
		description:
			"Run a shell command with this project's Zuse environment variables. Use variable names such as $DATABASE_URL; do not print secrets. Use this tool for deployments and other commands requiring managed variables.",
		inputSchema: {
			type: "object",
			properties: { command: { type: "string" } },
			required: ["command"],
			additionalProperties: false,
		},
		execute: async (args) => {
			if (!context.requestPermission || !context.getRuntimeMode)
				throw new Error("Command permissions are unavailable.");
			if (typeof args.command !== "string" || args.command.length > 65_536)
				throw new Error("Invalid command.");
			const startedAtGeneration = generation;
			let terminalId: string | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const created = await handleTerminalRequest(
					"terminal/create",
					{ command: args.command, outputByteLimit: 1_048_576 },
					context,
				);
				if (
					!created ||
					typeof created !== "object" ||
					!("terminalId" in created) ||
					typeof created.terminalId !== "string"
				)
					throw new Error("Command did not start.");
				terminalId = created.terminalId;
				if (startedAtGeneration !== generation)
					throw new Error("Command cancelled.");
				active.add(terminalId);
				await Promise.race([
					handleTerminalRequest(
						"terminal/wait_for_exit",
						{ terminalId },
						context,
					),
					new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error("Environment command timed out after two minutes."),
								),
							120_000,
						);
					}),
				]);
				const output = await handleTerminalRequest(
					"terminal/output",
					{ terminalId },
					context,
				);
				return maskSecrets(
					JSON.stringify(output),
					values.flatMap((value) => [
						value,
						JSON.stringify(value).slice(1, -1),
					]),
				);
			} catch {
				throw new Error(
					"Environment command failed, was denied, or timed out.",
				);
			} finally {
				if (timer) clearTimeout(timer);
				if (terminalId) {
					active.delete(terminalId);
					await handleTerminalRequest(
						"terminal/release",
						{ terminalId },
						context,
					);
				}
			}
		},
	};
	return { tool, close };
}
