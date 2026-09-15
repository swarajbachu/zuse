import { spawnSync } from "node:child_process";

/** ACP processes are spawned as isolated process groups on POSIX. */
export function killAcpProcess(
	pid: number,
	signal: NodeJS.Signals = "SIGKILL",
): void {
	if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
				windowsHide: true,
				timeout: 2000,
				stdio: "ignore",
			});
		} else process.kill(-pid, signal);
	} catch {
		/* Already exited, including its descendants. */
	}
}
