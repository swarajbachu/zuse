#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const systemdRoot = process.env.ZUSE_SYSTEMD_ROOT ?? "/etc/systemd/system";
const requestFile =
	process.env.ZUSE_RUNTIME_UPDATE_REQUEST_FILE ??
	"/var/lib/zuse/runtime-update/request.json";
const statusFile =
	process.env.ZUSE_RUNTIME_UPDATE_STATUS_FILE ??
	"/var/lib/zuse/runtime-update/status.json";

const run = (command, args) =>
	new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited with ${code ?? "unknown"}`));
		});
	});

const writeAtomic = async (path, contents, mode = 0o644) => {
	await mkdir(dirname(path), { recursive: true, mode: 0o755 });
	const temporary = `${path}.next-${randomUUID()}`;
	await writeFile(temporary, contents, { mode });
	await rename(temporary, path);
};

const service = `[Unit]
Description=Apply a requested Zuse cloud runtime update
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/zuse/runtime.env
Environment=ZUSE_RUNTIME_PUBLIC_KEY_FILE=/etc/zuse/runtime-signing-public.jwk
Environment=ZUSE_RUNTIME_UPDATE_REQUEST_FILE=${requestFile}
Environment=ZUSE_RUNTIME_UPDATE_STATUS_FILE=${statusFile}
ExecStartPre=/bin/sleep 2
ExecStart=/usr/local/bin/node /opt/zuse/current/runtime-updater.mjs
ExecStopPost=/usr/bin/rm -f ${requestFile}
`;

const pathUnit = `[Unit]
Description=Watch for requested Zuse cloud runtime updates

[Path]
PathExists=${requestFile}
Unit=zuse-update-request.service

[Install]
WantedBy=multi-user.target
`;

for (const directory of new Set([dirname(requestFile), dirname(statusFile)])) {
	await run("install", [
		"-d",
		"-o",
		"zuse",
		"-g",
		"zuse",
		"-m",
		"0770",
		directory,
	]);
}

await writeAtomic(`${systemdRoot}/zuse-update-request.service`, service);
await writeAtomic(`${systemdRoot}/zuse-update-request.path`, pathUnit);

if (process.env.ZUSE_RUNTIME_SKIP_SYSTEMD_RELOAD !== "1") {
	await run("systemctl", ["daemon-reload"]);
	await run("systemctl", ["enable", "--now", "zuse-update-request.path"]);
}

console.log("Installed Zuse runtime update trigger");
