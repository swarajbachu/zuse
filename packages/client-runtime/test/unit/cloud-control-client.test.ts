import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
	type CloudControlRequest,
	makeCloudControlClient,
} from "../../src/cloud-control-client.ts";

describe("cloud control HTTP routing", () => {
	it("preserves provider selection and idempotent lifecycle command IDs", async () => {
		const calls = vi.fn();
		const request: CloudControlRequest = (...args) => {
			calls(...args);
			return Effect.die("record only");
		};
		const client = makeCloudControlClient(request);
		client["cloud.image.status"]({ providerId: "provider/one" });
		expect(calls.mock.calls.at(-1)?.[0]).toBe(
			"/v1/cloud/image?providerId=provider%2Fone",
		);
		const input = { workspaceId: "workspace/one", commandId: "stable" };
		client["cloud.workspaces.archive"](input);
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/cloud/workspaces/workspace%2Fone/archive",
			expect.anything(),
			"POST",
			input,
		);
		client["cloud.workspaces.list"]({ projectId: "project one" });
		expect(calls.mock.calls.at(-1)?.[0]).toBe(
			"/v1/cloud/workspaces?projectId=project%20one",
		);
	});
	it("routes agent setup and subscription to account endpoints", () => {
		const calls = vi.fn();
		const request: CloudControlRequest = (...args) => {
			calls(...args);
			return Effect.die("record only");
		};
		const client = makeCloudControlClient(request);
		client["cloud.auth.provision"]();
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/cloud/auth/provision",
			expect.anything(),
			"POST",
			{},
		);
		client["machines.entitlements"]();
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/billing/entitlements",
			expect.anything(),
		);
		client["cloud.github.install"]();
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/cloud/github/install",
			expect.anything(),
			"POST",
			{},
		);
	});
});
