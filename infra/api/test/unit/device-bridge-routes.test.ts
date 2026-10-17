import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { expect, it, vi } from "vitest";
import { layer as config } from "../../src/config";
import { routeDeviceBridgeRequest } from "../../src/device-bridge-routes";
import { unauthorized } from "../../src/errors";
import { WorkosVerifier } from "../../src/workos";

it("authenticates enrollment without consuming its body and scopes the registry to the verified account", async () => {
	const gateway = vi.fn(async (_account: string, request: Request) => {
		expect(await request.json()).toEqual({
			deviceId: "mac",
			label: "Mac",
			secret: "secret",
		});
		return Response.json({ enrolled: true });
	});
	const runtime = ManagedRuntime.make(
		Layer.merge(
			config({
				apiIssuer: "https://api.test",
				workosIssuer: "https://auth.test",
				workosJwksUrl: "https://auth.test/keys",
				mintPrivateKey: Redacted.make("unused"),
				mintPublicKey: "public",
				deviceBridgeGateway: gateway,
			}),
			Layer.succeed(WorkosVerifier, {
				verify: (token) =>
					token === "valid"
						? Effect.succeed({ accountId: "verified", orgId: undefined })
						: Effect.fail(unauthorized("invalid")),
				exchangeToken: () => Effect.fail(unauthorized("unsupported")),
			}),
		),
	);
	try {
		const response = await runtime.runPromise(
			routeDeviceBridgeRequest(
				new Request("https://api.test/v1/device-bridge/enroll", {
					method: "POST",
					headers: { authorization: "Bearer valid" },
					body: JSON.stringify({
						deviceId: "mac",
						label: "Mac",
						secret: "secret",
					}),
				}),
			),
		);
		expect(response?.status).toBe(200);
		expect(gateway.mock.calls[0]?.[0]).toBe("verified");
		await expect(
			runtime.runPromise(
				routeDeviceBridgeRequest(
					new Request("https://api.test/v1/device-bridge/devices"),
				),
			),
		).rejects.toThrow();
		expect(gateway).toHaveBeenCalledTimes(1);
		expect(
			await runtime.runPromise(
				routeDeviceBridgeRequest(
					new Request("https://api.test/v1/device-bridge/dispatch", {
						method: "POST",
						headers: { authorization: "Bearer valid" },
					}),
				),
			),
		).toBeNull();
		for (const protocol of [
			"auth.valid",
			"zuse-device-bridge-v1, auth.valid",
		]) {
			const result = await runtime.runPromise(
				routeDeviceBridgeRequest(
					new Request(
						"https://api.test/v1/device-bridge/connect?deviceId=mac",
						{
							headers: {
								upgrade: "websocket",
								"sec-websocket-protocol": protocol,
								"x-zuse-bridge-account": "untrusted",
							},
						},
					),
				),
			);
			expect(result?.status).toBe(protocol.startsWith("zuse") ? 200 : 400);
			expect(result?.headers.get("x-zuse-bridge-account")).toBe(
				protocol.startsWith("zuse") ? "verified" : null,
			);
		}
	} finally {
		await runtime.dispose();
	}
});
