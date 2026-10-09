import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { startIsolatedCursorAgent } from "../../src/drivers/cursor-isolated-agent.ts";

test("Cursor workers keep shell identities isolated across concurrent agents and resume", async () => {
	const root = await mkdtemp(join(tmpdir(), "cursor-isolation-"));
	const sdk = join(root, "sdk.mjs");
	await writeFile(
		sdk,
		`import {execFileSync} from 'node:child_process';
 export class JsonlLocalAgentStore {}
 export class Agent {
 static async create() { return new Agent(); }
 static async resume() { return new Agent(); }
 agentId='test';
 close() {}
 async send(){return {
 async *stream(){yield {type:'system', marker: execFileSync(process.execPath,['-p','process.env.GIT_AUTHOR_NAME'],{encoding:'utf8'}).trim()};},
 async wait(){return {status:'completed'};}, async cancel(){} };}
 }`,
	);
	const agents = [];
	try {
		const results = await Promise.all(
			["alice", "bob", "zuse[bot]"].map((name) =>
				startIsolatedCursorAgent(
					{ local: { cwd: root } },
					root,
					"resume-id",
					{ GIT_AUTHOR_NAME: name },
					sdk,
				),
			),
		);
		agents.push(...results.map((result) => result.agent));
		expect(results.every((result) => result.resumed)).toBe(true);
		for (const [index, agent] of agents.entries()) {
			const run = await agent.send("commit");
			const messages = [];
			for await (const message of run.stream()) messages.push(message);
			expect(messages).toEqual([
				{ type: "system", marker: ["alice", "bob", "zuse[bot]"][index] },
			]);
			expect(await run.wait()).toEqual({ status: "completed" });
		}
		expect(process.env.GIT_AUTHOR_NAME).not.toBe("zuse[bot]");
	} finally {
		for (const agent of agents) agent.close();
		await rm(root, { recursive: true, force: true });
	}
});
