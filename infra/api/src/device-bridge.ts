import type { DeviceBridgeAction } from "@zuse/contracts";
import { DEVICE_BRIDGE_VERSION } from "@zuse/contracts";
import { Effect, Redacted } from "effect";
import { importJWK, SignJWT } from "jose";
import type { CloudWorkspaceRecord } from "./cloud-workspace-store.ts";
import { workspaceDestructionFence } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { parseJwk, sha256Hex } from "./crypto.ts";
import { requireBridgeDevice } from "./device-bridge-routes.ts";
import { forbidden, serviceUnavailable } from "./errors.ts";

/** The API signs the exact operation; runtimes never receive a desktop RPC token. */
export const forwardDeviceBridge = Effect.fn("forwardDeviceBridge")(function* (
	workspace: CloudWorkspaceRecord,
	action: typeof DeviceBridgeAction.Type,
	actor: "runtime" | "user",
) {
	if (
		workspace.archiveRequestedAtMs !== undefined ||
		workspace.deletedAtMs !== undefined ||
		workspace.desiredState !== "ready"
	)
		return yield* Effect.fail(forbidden("device_bridge_chat_inactive"));
	if (
		actor === "runtime" &&
		(action._tag === "decide" || action._tag === "revoke")
	)
		return yield* Effect.fail(forbidden("device_bridge_user_required"));
	if (actor === "user" && action._tag === "execute")
		return yield* Effect.fail(forbidden("device_bridge_runtime_required"));
	if (workspace.requestConfig.deviceBridgeVersion !== DEVICE_BRIDGE_VERSION)
		return yield* Effect.fail(
			serviceUnavailable("device_bridge_runtime_update_required"),
		);
	const target = workspace.requestConfig.localDeviceId;
	if (typeof target !== "string")
		return yield* Effect.fail(serviceUnavailable("device_bridge_no_target"));
	const device = yield* requireBridgeDevice(workspace.accountId, target);
	if (action._tag === "status" && !device.connected)
		return Response.json({
			version: DEVICE_BRIDGE_VERSION,
			deviceId: device.deviceId,
			deviceName: device.label,
			enabled: true,
			connected: false,
			homeDirectory: "",
			commands: [],
			grants: [],
		});
	const config = yield* ApiConfiguration;
	const body = JSON.stringify(action);
	const bodyHash = yield* sha256Hex(body);
	const jwk = yield* parseJwk(Redacted.value(config.mintPrivateKey));
	const token = yield* Effect.tryPromise({
		try: async () =>
			new SignJWT({
				accountId: workspace.accountId,
				workspaceId: workspace.workspaceId,
				chatId: workspace.chatId,
				chatTitle:
					typeof workspace.requestConfig.title === "string"
						? workspace.requestConfig.title
						: workspace.chatId,
				sessionId: workspace.initialSessionId,
				grantEpoch: workspaceDestructionFence(workspace),
				actor,
				bodyHash,
			})
				.setProtectedHeader({ alg: "EdDSA", typ: "device-bridge+jwt" })
				.setIssuer(config.apiIssuer)
				.setAudience(`device-bridge:${target}`)
				.setIssuedAt()
				.setExpirationTime("15s")
				.sign(await importJWK(jwk, "EdDSA")),
		catch: () => serviceUnavailable("device_bridge_signing_failed"),
	});
	return yield* Effect.tryPromise({
		try: async () => {
			const gateway = config.deviceBridgeGateway;
			if (!gateway) throw new Error("Bridge transport unavailable");
			const response = await gateway(
				workspace.accountId,
				new Request(
					`https://bridge.internal/dispatch?deviceId=${encodeURIComponent(target)}`,
					{ method: "POST", body: JSON.stringify({ token, body }) },
				),
			);

			if (response.status >= 300 && response.status < 400)
				throw new Error("Device bridge endpoint redirected");
			return new Response(await response.text(), {
				status: response.status,
				headers: {
					"content-type": "application/json",
					"cache-control": "no-store",
				},
			});
		},
		catch: (cause) => {
			console.warn("Device bridge forwarding failed", {
				workspaceId: workspace.workspaceId,
				reason:
					cause instanceof Error ? cause.message : "Unknown fetch failure",
			});
			return serviceUnavailable("device_bridge_desktop_unavailable");
		},
	});
});
