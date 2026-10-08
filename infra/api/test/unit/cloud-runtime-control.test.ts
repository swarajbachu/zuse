import { describe, expect, test } from "vitest";
import { runtimeControlPathAllowed } from "../../src/cloud-runtime-control.ts";

describe("runtime control boundary", () => {
	test.each([
		["/v1/cloud/projects", "GET"],
		["/v1/cloud/providers", "GET"],
		["/v1/cloud/workspaces?projectId=project", "GET"],
		["/v1/cloud/workspaces", "POST"],
		["/v1/cloud/workspaces/workspace/gateway/ticket", "POST"],
		["/v1/cloud/workspaces/workspace/preview-url", "POST"],
		["/v1/cloud/workspaces/workspace/preview-url", "DELETE"],
		["/v1/cloud/workspaces/workspace/archive", "POST"],
	])("permits orchestration: %s %s", (path, method) => {
		expect(runtimeControlPathAllowed(path, method)).toBe(true);
	});
	test.each([
		["/v1/cloud/api-keys", "POST"],
		["/v1/cloud/auth", "GET"],
		["/v1/cloud/provider-connections", "POST"],
		["/v1/cloud/workspaces/workspace/runtime/control", "POST"],
		["/v1/cloud/workspaces/workspace/ssh-access", "POST"],
		["/v1/cloud/workspaces/workspace/data-key", "POST"],
		["/v1/cloud/workspaces?scope=organization:other", "GET"],
		["/v1/cloud/workspaces/%2e%2e/auth", "GET"],
		["/v1/cloud/workspaces/../auth", "GET"],
		["https://evil.test/v1/cloud/workspaces", "POST"],
		["/v1/cloud/workspaces#fragment", "POST"],
	])("rejects non-orchestration routes: %s %s", (path, method) => {
		expect(runtimeControlPathAllowed(path, method)).toBe(false);
	});
});
