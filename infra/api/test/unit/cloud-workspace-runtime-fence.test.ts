import { describe, expect, test } from "vitest";
import {
	cloudWorkspaceGatewayEpoch,
	cloudWorkspaceRuntimeGeneration,
	nextCloudWorkspaceRuntimeFence,
} from "../../src/cloud-workspace-runtime-fence.ts";

describe("cloud workspace runtime fences", () => {
	test("uses the legacy generation as the current gateway epoch", () => {
		const workspace = { requestConfig: { runtimeGeneration: 7 } };

		expect(cloudWorkspaceRuntimeGeneration(workspace)).toBe(7);
		expect(cloudWorkspaceGatewayEpoch(workspace)).toBe(7);
	});

	test("prefers an explicitly allocated gateway epoch", () => {
		const workspace = {
			requestConfig: { runtimeGeneration: 7, gatewayEpoch: 3 },
		};

		expect(cloudWorkspaceGatewayEpoch(workspace)).toBe(3);
		expect(nextCloudWorkspaceRuntimeFence(workspace)).toEqual({
			runtimeGeneration: 8,
			gatewayEpoch: 4,
		});
	});

	test("allocates the first independent counters from one", () => {
		expect(nextCloudWorkspaceRuntimeFence({ requestConfig: {} })).toEqual({
			runtimeGeneration: 1,
			gatewayEpoch: 1,
		});
	});
});
