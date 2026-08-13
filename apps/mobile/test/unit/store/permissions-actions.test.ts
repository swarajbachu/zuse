import type { PermissionRequest } from "@zuse/contracts";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { connectionSessionKey } from "../../../src/lib/session-key";
import {
	decidePermission,
	pendingBySessionAtom,
	resetPermissionsRuntime,
} from "../../../src/store/permissions";
import { appAtomRegistry } from "../../../src/store/registry";

const harness = vi.hoisted(() => {
	const data = {
		requestsById: {} as Record<string, PermissionRequest>,
	};
	return {
		data,
		resolve: undefined as (() => void) | undefined,
		reject: undefined as ((cause: Error) => void) | undefined,
		dispatch: vi.fn(
			() =>
				new Promise((resolve, reject) => {
					harness.resolve = () => resolve({ result: undefined });
					harness.reject = reject;
				}),
		),
	};
});

vi.mock("../../../src/store/mobile-client-bus", () => ({
	dispatchMobileSessionCommand: harness.dispatch,
	mobileClientBus: () => ({
		snapshot: () => ({ data: harness.data }),
		overlay: (
			_key: unknown,
			overlay: {
				update: (data: typeof harness.data) => typeof harness.data;
			},
		) => {
			const next = overlay.update(harness.data);
			harness.data.requestsById = { ...next.requestsById };
			return true;
		},
	}),
	mobilePermissionsKey: () => ({ kind: "environment-permissions" }),
	registerMobileEnvironment: () => "environment-1",
}));

const options = { host: "127.0.0.1", port: 4000, token: null } as never;
const sessionId = "session-1" as never;
const key = connectionSessionKey("conn", sessionId);
const request = {
	id: "permission-1",
	sessionId,
	requestedAt: new Date("2026-07-23T12:00:00Z"),
	kind: { _tag: "Bash", command: "echo ok" },
	forcePrompt: false,
} as PermissionRequest;

describe("permission decisions", () => {
	beforeEach(async () => {
		await resetPermissionsRuntime();
		harness.resolve = undefined;
		harness.reject = undefined;
		harness.dispatch.mockClear();
		harness.data.requestsById = { [request.id]: request };
		appAtomRegistry.set(pendingBySessionAtom, { [key]: [request] });
	});

	test("keeps the request visible until the decision is acknowledged", async () => {
		const pendingDecision = decidePermission(
			"conn",
			options,
			sessionId,
			request.id,
			{ _tag: "AllowOnce" },
		);

		expect(appAtomRegistry.get(pendingBySessionAtom)[key]).toEqual([request]);
		harness.resolve?.();
		await pendingDecision;
		expect(harness.data.requestsById).toEqual({});
	});

	test("keeps the request available when the decision fails", async () => {
		const pendingDecision = decidePermission(
			"conn",
			options,
			sessionId,
			request.id,
			{ _tag: "AllowOnce" },
		);

		harness.reject?.(new Error("decision failed"));
		await expect(pendingDecision).rejects.toThrow("decision failed");
		expect(harness.data.requestsById).toEqual({ [request.id]: request });
	});
});
