import type { PermissionRequest } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { connectionSessionKey } from "../../../src/lib/session-key";
import {
	decidePermission,
	pendingBySessionAtom,
	resetPermissionsRuntime,
} from "../../../src/store/permissions";
import { appAtomRegistry } from "../../../src/store/registry";

const rpc = vi.hoisted(() => ({
	resolve: undefined as (() => void) | undefined,
	shouldFail: false,
}));

vi.mock("~/rpc/actions", () => ({
	decidePermission: () =>
		Effect.tryPromise({
			try: () =>
				new Promise<void>((resolve, reject) => {
					rpc.resolve = () =>
						rpc.shouldFail ? reject(new Error("decision failed")) : resolve();
				}),
			catch: (cause) => cause,
		}),
}));

vi.mock("~/rpc/connection", () => ({
	getConnectionClient: vi.fn(),
	reportConnectionFailure: vi.fn(),
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
		rpc.resolve = undefined;
		rpc.shouldFail = false;
		appAtomRegistry.set(pendingBySessionAtom, { [key]: [request] });
	});

	test("keeps the request visible and disabled until the decision is acknowledged", async () => {
		const pendingDecision = decidePermission(
			"conn",
			options,
			sessionId,
			request.id,
			{ _tag: "AllowOnce" },
		);

		expect(appAtomRegistry.get(pendingBySessionAtom)[key]).toEqual([request]);
		rpc.resolve?.();
		await pendingDecision;
		expect(appAtomRegistry.get(pendingBySessionAtom)[key]).toEqual([]);
	});

	test("keeps the request available when the decision fails", async () => {
		rpc.shouldFail = true;
		const pendingDecision = decidePermission(
			"conn",
			options,
			sessionId,
			request.id,
			{ _tag: "AllowOnce" },
		);

		rpc.resolve?.();
		await expect(pendingDecision).rejects.toThrow("decision failed");
		expect(appAtomRegistry.get(pendingBySessionAtom)[key]).toEqual([request]);
	});
});
