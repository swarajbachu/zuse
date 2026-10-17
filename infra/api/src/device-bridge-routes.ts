import { BridgeDeviceList, DEVICE_BRIDGE_API_PATH } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { ApiConfiguration } from "./config.ts";
import { serviceUnavailable } from "./errors.ts";

export const routeDeviceBridgeRequest = (request: Request) =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		if (!url.pathname.startsWith(`${DEVICE_BRIDGE_API_PATH}/`)) return null;
		const action = url.pathname.slice(DEVICE_BRIDGE_API_PATH.length);
		if (
			!(
				(request.method === "GET" &&
					(action === "/devices" || action === "/connect")) ||
				(request.method === "POST" &&
					(action === "/enroll" || action === "/revoke"))
			)
		)
			return null;
		const authHeaders = new Headers(request.headers);
		if (action === "/connect") {
			const token = request.headers
				.get("sec-websocket-protocol")
				?.split(",")
				.map((value) => value.trim())
				.find((value) => value.startsWith("auth."))
				?.slice(5);
			if (token) authHeaders.set("authorization", `Bearer ${token}`);
		}
		const principal = yield* requireWorkos(
			new Request(request.url, { headers: authHeaders }),
		);
		const config = yield* ApiConfiguration;
		if (!config.deviceBridgeGateway)
			return yield* Effect.fail(
				serviceUnavailable("device_bridge_update_required"),
			);
		if (action === "/connect") {
			if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
				return new Response("WebSocket required", { status: 426 });
			if (
				!request.headers
					.get("sec-websocket-protocol")
					?.split(",")
					.map((value) => value.trim())
					.includes("zuse-device-bridge-v1")
			)
				return new Response("Unsupported device bridge protocol", {
					status: 400,
				});
			return new Response(null, {
				headers: { "x-zuse-bridge-account": principal.accountId },
			});
		}
		const gateway = config.deviceBridgeGateway;
		return yield* Effect.tryPromise({
			try: async () => {
				const response = await gateway(
					principal.accountId,
					new Request(`https://bridge.internal${action}${url.search}`, request),
				);
				if (action !== "/enroll" || !response.ok) return response;
				return Response.json({
					enrolled: true,
					mintPublicKey: config.mintPublicKey,
					apiIssuer: config.apiIssuer,
				});
			},
			catch: () => serviceUnavailable("device_bridge_unavailable"),
		});
	});

export const requireBridgeDevice = (accountId: string, deviceId: string) =>
	Effect.gen(function* () {
		const config = yield* ApiConfiguration;
		const gateway = config.deviceBridgeGateway;
		if (!gateway)
			return yield* Effect.fail(
				serviceUnavailable("device_bridge_update_required"),
			);
		const device = yield* Effect.tryPromise({
			try: async () => {
				const response = await gateway(
					accountId,
					new Request("https://bridge.internal/devices"),
				);
				if (!response.ok) return undefined;
				const devices = Schema.decodeUnknownSync(BridgeDeviceList)(
					await response.json(),
				);
				return devices.find(
					(device) => device.deviceId === deviceId && !device.revoked,
				);
			},
			catch: () => serviceUnavailable("device_bridge_unavailable"),
		});
		if (!device)
			return yield* Effect.fail(
				serviceUnavailable("device_bridge_target_rejected"),
			);
		return device;
	});
