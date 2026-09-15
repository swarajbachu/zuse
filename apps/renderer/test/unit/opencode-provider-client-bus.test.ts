import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import busSource from "../../src/lib/session-timeline-client-bus.ts?raw";
import catalogSource from "../../src/store/model-catalog.ts?raw";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const agentSource = readFileSync(
	join(repoRoot, "packages/contracts/src/agent.ts"),
	"utf8",
);

describe("OpenCode provider ClientBus dispatch", () => {
	it("dispatches every provider.opencode* RPC from contracts", () => {
		const rpcs = [
			...agentSource.matchAll(/Rpc\.make\(\s*"((?:provider\.opencode)[^"]*)"/g),
		].map((match) => match[1]);
		expect(rpcs.length).toBeGreaterThan(0);
		expect(rpcs).toEqual(
			expect.arrayContaining([
				"provider.opencode.setAuth",
				"provider.opencode2.setAuth",
				"provider.opencode2.removeAuth",
				"provider.opencode2.addCustom",
				"provider.opencode2.removeCustom",
			]),
		);
		for (const rpc of rpcs) {
			expect(busSource).toContain(`case "${rpc}":`);
			expect(catalogSource).toContain(`"${rpc}"`);
		}
	});
});
