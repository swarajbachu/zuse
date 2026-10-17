import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
	ensureExecutableFile,
	releaseWindowsPtyOnExit,
} from "../../src/pty/node-pty-helper.ts";

it.each([
	false,
	true,
])("releases Windows PTY resources once (explicit close: %s)", (explicitClose) => {
	let exited = (_event: { exitCode: number }) => {};
	const kill = vi.fn();
	const child = {
		kill,
		onExit: (listener: typeof exited) => {
			exited = listener;
			return { dispose: () => {} };
		},
	};
	releaseWindowsPtyOnExit(child, "win32");
	if (explicitClose) child.kill();
	exited({ exitCode: 0 });
	child.kill();
	expect(kill).toHaveBeenCalledTimes(1);
});

describe("node-pty spawn helper", () => {
	it.skipIf(process.platform === "win32")(
		"repairs an installed helper that has no executable bits",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "zuse-pty-helper-"));
			try {
				const helper = join(directory, "spawn-helper");
				await writeFile(helper, "fixture");
				await chmod(helper, 0o666);

				ensureExecutableFile(helper);

				expect((await stat(helper)).mode & 0o111).toBe(0o111);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
