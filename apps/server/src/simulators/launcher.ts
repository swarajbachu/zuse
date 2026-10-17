import { join } from "node:path";
import type { SimulatorPlatform, SimulatorTarget } from "@zuse/contracts";

/** A session launcher connects only to the daemon supervised by this server incarnation. */
export function simulatorLauncher(input: {
	node: string;
	entry: string;
	root: string;
	owner: string;
	session: string;
	target: SimulatorTarget;
	platform: SimulatorPlatform;
}) {
	const source = `
const fs = require('node:fs');
const cp = require('node:child_process');
const read = path => JSON.parse(fs.readFileSync(path,'utf8'));
const access = read(${JSON.stringify(join(input.root, "access.json"))});
if (!access.enabled || access.owner !== ${JSON.stringify(input.owner)}) throw Error('Agent device access is off');
process.kill(access.pid,0);
const sessions = read(${JSON.stringify(join(input.root, "sessions.json"))});
if (!sessions.some(s => s.chatId === ${JSON.stringify(input.target.chatId)} && s.deviceId === ${JSON.stringify(input.target.deviceId)})) throw Error('Device session is closed');
const args = process.argv.slice(1);
if (args[0] === 'daemon' || args.some(a => /^--(?:config|session|udid|serial|platform|state-dir|daemon|target|device|remote|ios-simulator-device-set)/.test(a))) throw Error('Device target flags are managed by Zuse');
const env = {...process.env};
for (const key of Object.keys(env)) if (key.startsWith('AGENT_DEVICE_')) delete env[key];
const registration = read(${JSON.stringify(join(input.root, "agent-device", input.session, "daemon.json"))});
process.kill(registration.pid,0);
if (!Number.isInteger(registration.httpPort) || registration.httpPort < 1 || registration.httpPort > 65535 || typeof registration.token !== 'string') throw Error('Reopen this device to reconnect agent controls');
env.AGENT_DEVICE_DAEMON_BASE_URL = 'http://127.0.0.1:' + registration.httpPort;
env.AGENT_DEVICE_DAEMON_AUTH_TOKEN = registration.token;
env.AGENT_DEVICE_DAEMON_TRANSPORT = 'http';
const child = cp.spawn(${JSON.stringify(input.node)}, [${JSON.stringify(input.entry)}, ...args,
 '--config', ${JSON.stringify(join(input.root, "agent-config.json"))},
 '--platform', ${JSON.stringify(input.platform)}, ${JSON.stringify(input.platform === "ios" ? "--udid" : "--serial")}, ${JSON.stringify(input.target.deviceId)},
 '--session', ${JSON.stringify(`zuse-${input.session}`)},
 '--state-dir', ${JSON.stringify(join(input.root, "agent-device", input.session))}
], {stdio:'inherit', env:{...env,ELECTRON_RUN_AS_NODE:'1',AGENT_DEVICE_NO_UPDATE_NOTIFIER:'1'}});
child.once('error', () => process.exit(1));
child.once('exit', code => process.exit(code ?? 1));
`;
	return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(input.node)} -e ${shellQuote(source)} -- "$@"\n`;
}
export const shellQuote = (value: string) =>
	`'${value.replaceAll("'", "'\\''")}'`;
