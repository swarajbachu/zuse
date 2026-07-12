import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { SystemRpcClient } from "./rpc-client.ts";

export const initializeSystemRepository = (path: string): void => {
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "README.md"), "# System fixture\n");
	execFileSync("git", ["init", "--initial-branch=main"], { cwd: path });
	execFileSync("git", ["config", "user.email", "system@example.test"], {
		cwd: path,
	});
	execFileSync("git", ["config", "user.name", "System Test"], { cwd: path });
	execFileSync("git", ["add", "README.md"], { cwd: path });
	execFileSync("git", ["commit", "-m", "Initial fixture"], { cwd: path });
};

export const createSystemConversation = async (
	client: SystemRpcClient,
	repository: string,
	options?: { readonly runtimeMode?: "approval-required" | "full-access" },
) => {
	const folder = await Effect.runPromise(
		client["workspace.add"]({ path: repository }),
	);
	const conversation = await Effect.runPromise(
		client["chat.create"]({
			projectId: folder.id,
			providerId: "gemini",
			model: "deterministic-model",
			title: "System conversation",
			runtimeMode: options?.runtimeMode,
		}),
	);
	return { folder, conversation };
};
