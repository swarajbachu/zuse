import { makeRpcClientSession } from "@zuse/client-runtime/connection";
import { MemoizeRpcs, WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import {
	makeTemporaryDirectory,
	startHeadlessServer,
	withResourceScope,
} from "@zuse/testkit";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { wsClientProtocolLayer } from "../../../src/rpc/ws-protocol.ts";

describe("mobile WebSocket transport", () => {
	it("performs the shared handshake and RPC contract against the production server", async () => {
		await withResourceScope(async (resources) => {
			const temporary = await resources.acquire(
				() => makeTemporaryDirectory("zuse-mobile-rpc-"),
				(value) => value.dispose(),
			);
			const server = await resources.acquire(
				() => startHeadlessServer({ root: temporary.path }),
				(value) => value.stop(),
			);
			const session = await resources.acquire(
				() =>
					makeRpcClientSession(
						wsClientProtocolLayer({
							host: "127.0.0.1",
							port: server.port,
						}),
						MemoizeRpcs,
						{
							protocolVersion: WIRE_PROTOCOL_VERSION,
							perform: (client, hello) => client["connect.handshake"](hello),
						},
					),
				(value) => value.dispose(),
			);
			const description = await Effect.runPromise(
				session.client["connect.describe"](),
			);
			expect(description.providerKind).toBe("desktop");
			expect(description.endpoint.wsBaseUrl).toMatch(/^ws:\/\//);
		});
	}, 30_000);
});
