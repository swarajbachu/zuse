import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const rpcClientSource = readFileSync(
	join(
		dirname(require.resolve("effect/package.json")),
		"dist/unstable/rpc/RpcClient.js",
	),
	"utf8",
);

// patches/effect@*.patch ports the upstream liveness rule. Dropping it (for
// example during an Effect upgrade without the fix) brings back 5 second
// pong-only timeouts that disconnect busy mobile sockets.
describe("RPC socket liveness patch", () => {
	test("counts any decoded server frame as liveness", () => {
		expect(rpcClientSource).toContain("pinger.onFrame();");
		expect(rpcClientSource).not.toContain("pinger.onPong()");
	});

	test("honors a configurable ping timeout", () => {
		expect(rpcClientSource).toContain(
			"Duration.toMillis(options?.pingTimeout ?? interval)",
		);
	});
});
