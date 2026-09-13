import { type ChildProcess, spawn } from "node:child_process";

/** Signal a detached process group, with a direct-child fallback if it already exited. */
export const signalProcessGroup = (
	child: ChildProcess,
	signal: NodeJS.Signals,
): void => {
	if (child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
};

export const SUPERVISED_COMMAND_LEASE_MS = 15_000;

// The supervisor shares a process group with the command. Losing the private
// stdin pipe means the server died, so no command survives without its authority.
const SUPERVISOR = `
const { spawn } = require('node:child_process');
const [shell, command, initialDeadline] = process.argv.slice(1);
let deadline = Number(initialDeadline);
let input = "";
const stop = () => { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } };
const watchdog = setInterval(() => { if (!Number.isFinite(deadline) || Date.now() >= deadline) stop(); }, 250);
process.stdin.on('data', chunk => {
 input += chunk.toString('utf8');
 let end;
 while ((end = input.indexOf('\\n')) >= 0) {
  deadline = Math.min(Number(input.slice(0, end)), Date.now() + ${SUPERVISED_COMMAND_LEASE_MS});
  input = input.slice(end + 1);
 }
 if (input.length > 64) stop();
});
process.stdin.resume();
process.stdin.once('end', stop);
process.stdin.once('error', stop);
if (!Number.isFinite(deadline) || Date.now() >= deadline) stop();
const child = spawn(shell, ['-lc', command], { stdio: ['ignore', 'inherit', 'inherit'] });
child.once('error', error => { console.error(error.message); process.exit(127); });
child.once('exit', (code, signal) => { clearInterval(watchdog); process.exitCode = code ?? 1; process.stdin.pause(); process.stdin.destroy(); });
`;
export const spawnSupervisedCommand = (
	command: string,
	cwd: string,
	deadline = Date.now() + SUPERVISED_COMMAND_LEASE_MS,
): ChildProcess =>
	spawn(
		process.execPath,
		[
			"-e",
			SUPERVISOR,
			process.env.SHELL || "/bin/sh",
			command,
			String(deadline),
		],
		{
			cwd,
			detached: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		},
	);
