import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "vite-plus";

const exec = promisify(execFile);
const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

/** Read worktree HEAD as well as shared refs (including packed refs). */
export async function watchGitRevision(
	root: string,
	onChange: () => Promise<void>,
	intervalMs = 500,
): Promise<() => void> {
	let gitDir: string;
	let commonDir: string;
	try {
		const { stdout } = await exec(
			"git",
			["rev-parse", "--absolute-git-dir", "--git-common-dir"],
			{ cwd: root },
		);
		const [git, common] = stdout.trim().split("\n");
		if (!git || !common) return () => {};
		gitDir = resolve(root, git);
		commonDir = resolve(root, common);
	} catch {
		return () => {};
	}
	const revision = async (): Promise<string | null> => {
		try {
			// Do not reload half a checkout or an unresolved merge/rebase.
			if (
				(
					await Promise.all(
						[
							"index.lock",
							"HEAD.lock",
							"MERGE_HEAD",
							"rebase-merge",
							"rebase-apply",
						].map((name) => exists(resolve(gitDir, name))),
					)
				).some(Boolean)
			)
				return null;
			const head = (await readFile(resolve(gitDir, "HEAD"), "utf8")).trim();
			if (!head.startsWith("ref: ")) return head;
			const ref = head.slice(5);
			try {
				return (await readFile(resolve(commonDir, ref), "utf8")).trim();
			} catch {
				const packed = await readFile(
					resolve(commonDir, "packed-refs"),
					"utf8",
				);
				return (
					packed
						.split("\n")
						.find((line) => line.endsWith(` ${ref}`))
						?.split(" ")[0] ?? null
				);
			}
		} catch {
			return null;
		}
	};
	let current = await revision();
	let candidate: string | null = null;
	let busy = false;
	let stopped = false;
	const timer = setInterval(async () => {
		if (busy || stopped) return;
		busy = true;
		try {
			const next = await revision();
			if (stopped) return;
			if (next === null || next === current) {
				candidate = null;
				return;
			}
			// Two stable samples let atomic ref/index updates settle.
			if (next !== candidate) {
				candidate = next;
				return;
			}
			current = next;
			candidate = null;
			await onChange();
		} finally {
			busy = false;
		}
	}, intervalMs);
	timer.unref();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

export function gitRevisionRecovery(): Plugin {
	return {
		name: "zuse-git-revision-recovery",
		apply: "serve",
		async configureServer(server) {
			const httpServer = server.httpServer;
			if (!httpServer) return;
			const stop = await watchGitRevision(server.config.root, async () => {
				server.config.logger.info(
					"[zuse] Git revision changed; rebuilding the dev module graph.",
				);
				try {
					await server.restart(true);
				} catch (error) {
					server.config.logger.error(
						`[zuse] Dev restart failed: ${String(error)}`,
					);
				}
			});
			// Bind cleanup to this server generation. Vite can reuse the plugin
			// object while constructing the replacement before closing the old one.
			httpServer.once("close", stop);
		},
	};
}
