import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Called by bin before constructing layers that open the canonical SQLite store. */
export const assertCloudRuntimeDataLock = (
	directory: string,
	descriptor = process.env.ZUSE_WORKSPACE_RUNTIME_LOCK_FD,
): void => {
	if (!descriptor || !/^\d+$/u.test(descriptor))
		throw new Error("workspace_runtime_data_lock_missing");
	try {
		const expected = realpathSync(join(directory, ".workspace-runtime.lock"));
		const actual = realpathSync(`/proc/self/fd/${descriptor}`);
		const info = readFileSync(`/proc/self/fdinfo/${descriptor}`, "utf8");
		if (
			expected !== actual ||
			!/^lock:\s+.*FLOCK\s+ADVISORY\s+WRITE\s/mu.test(info)
		)
			throw new Error("invalid lock");
	} catch {
		throw new Error("workspace_runtime_data_lock_missing");
	}
};
