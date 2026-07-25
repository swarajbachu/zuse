import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../../../src/drivers/codex-app-server-client.ts";

const FAKE_CODEX = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const log = process.env.CODEX_START_LOG;
if (!log) process.exit(2);
appendFileSync(log, "start\\n");
const lines = readline.createInterface({ input: process.stdin });
lines.once("line", (line) => {
  const request = JSON.parse(line);
  setTimeout(() => {
    appendFileSync(log, "end\\n");
    process.stdout.write(JSON.stringify({
      id: request.id,
      result: {
        userAgent: "fake",
        codexHome: "",
        platformFamily: "test",
        platformOs: "test"
      }
    }) + "\\n");
  }, 50);
});
`;

describe("CodexAppServerClient startup", () => {
	it("serializes concurrent initialization against shared Codex state", async () => {
		const directory = mkdtempSync(join(tmpdir(), "zuse-codex-start-"));
		const executable = join(directory, "fake-codex.mjs");
		const log = join(directory, "starts.log");
		writeFileSync(executable, FAKE_CODEX, "utf8");
		chmodSync(executable, 0o755);

		try {
			const options = {
				codexPath: executable,
				env: { ...process.env, CODEX_START_LOG: log },
				onNotification: () => {},
				onServerRequest: (
					_request: unknown,
					respond: (value: unknown) => void,
				) => respond({}),
			};
			const [first, second] = await Promise.all([
				CodexAppServerClient.start(options),
				CodexAppServerClient.start(options),
			]);
			first.close();
			second.close();

			expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
				"start",
				"end",
				"start",
				"end",
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
