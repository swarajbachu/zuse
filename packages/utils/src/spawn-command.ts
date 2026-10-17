import {
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
} from "node:child_process";
import crossSpawn from "cross-spawn";

// Keep Node's native behavior on POSIX. Windows additionally needs PATHEXT,
// npm .cmd shims, and command/argument quoting handled together.
export const spawn =
	process.platform === "win32" ? crossSpawn.spawn : nodeSpawn;
export const spawnSync =
	process.platform === "win32" ? crossSpawn.sync : nodeSpawnSync;
