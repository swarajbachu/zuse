import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const script = fileURLToPath(
	new URL("../../../cloud-sandboxes/box-resume-benchmark.ts", import.meta.url),
);

test.each([
	"create",
	"launch",
	"initial-health",
	"pre-round-health",
	"pause",
	"archive",
	"resume",
])("benchmark records %s failures and cleans up allocated machines", async (stage) => {
	const directory = await mkdtemp(join(tmpdir(), "box-benchmark-test-"));
	try {
		const adapter = join(directory, "adapter.mjs");
		const preload = join(directory, "preload.mjs");
		const output = join(directory, "result.json");
		const cleanup = join(directory, "cleanup");
		await writeFile(
			adapter,
			`
import { Effect } from ${JSON.stringify(createRequire(import.meta.url).resolve("effect"))};
import { writeFileSync } from 'node:fs';
const step = (name, value) => Effect.sync(() => {
 if (process.env.TEST_STAGE === name) throw new Error(name);
 return value;
});
export const makeBoxSandboxProvider = () => ({
 create: () => step('create', { providerSandboxId: 'bx_test' }),
 replaceProcess: () => step('launch'),
 setNetwork: () => Effect.void,
 pause: () => step('pause'),
 resume: () => step('resume'),
 kill: () => Effect.sync(() => writeFileSync(${JSON.stringify(cleanup)}, 'deleted')),
});
`,
		);
		await writeFile(
			preload,
			`
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => timer(fn, 0, ...args);
let health = 0;
globalThis.fetch = async (_url, init) => {
 if (init.method === 'GET') {
  if (process.env.TEST_STAGE === 'archive') throw new Error('archive');
  return Response.json({ sandbox: { state: 'archived' } });
 }
 health++;
 const failed = (health === 1 && process.env.TEST_STAGE === 'initial-health') || (health === 2 && process.env.TEST_STAGE === 'pre-round-health');
 return Response.json({ exitCode: failed ? 1 : 0 });
};
`,
		);
		await expect(
			promisify(execFile)("bun", ["--preload", preload, script], {
				timeout: 5000,
				env: {
					...process.env,
					BOX_API_KEY: "test-only",
					BOX_TEMPLATE_SNAPSHOT: "test",
					BOX_BENCH_ADAPTER: adapter,
					BOX_BENCH_OUTPUT: output,
					BOX_BENCH_REUSE_ID: "",
					BOX_BENCH_KEEP: "0",
					BOX_BENCH_ROUNDS: "1",
					TEST_STAGE: stage,
				},
			}),
		).rejects.toMatchObject({ code: 1 });
		const samples = JSON.parse(await readFile(output, "utf8"));
		expect(samples).toHaveLength(1);
		expect(samples[0]).toMatchObject({
			status: "failed",
			round: ["create", "launch", "initial-health"].includes(stage) ? 0 : 1,
		});
		expect(samples[0].elapsedMs).toBeGreaterThanOrEqual(0);
		if (stage !== "create")
			expect(await readFile(cleanup, "utf8")).toBe("deleted");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
