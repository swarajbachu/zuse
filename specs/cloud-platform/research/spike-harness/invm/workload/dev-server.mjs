// Dev-server stand-in: an HTTP server plus a recursive file watcher over a
// directory. verify-fork.sh touches a file post-fork and asserts the watcher
// observed it (watch descriptors are a known fork casualty to measure).

import { watch } from "node:fs";
import { createServer } from "node:http";

const watchedDir = process.argv[2] ?? "/opt/spike/watched";
const port = Number(process.argv[3] ?? 8787);
const events = [];

watch(watchedDir, { recursive: true }, (eventType, filename) => {
	events.push({ eventType, filename, at: new Date().toISOString() });
});

createServer((req, res) => {
	if (req.url === "/health") {
		res.end(
			JSON.stringify({
				ok: true,
				pid: process.pid,
				uptimeSec: process.uptime(),
			}),
		);
		return;
	}
	if (req.url === "/watch-events") {
		res.end(JSON.stringify(events.slice(-50)));
		return;
	}
	res.end("spike dev server");
}).listen(port, () =>
	console.log(`dev-server up on :${port} watching ${watchedDir}`),
);
