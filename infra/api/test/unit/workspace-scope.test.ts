import { ApiPaths } from "@zuse/contracts";
import { describe, expect, it } from "vitest";
import { workspaceAccessForPath } from "../../src/workspace-scope.ts";

describe("organization configuration route permissions", () => {
	it.each([
		["GET", ApiPaths.cloudApiKeys],
		["POST", ApiPaths.cloudApiKeys],
		["DELETE", `${ApiPaths.cloudApiKeys}/key_a`],
	])("keeps Personal-only API key management closed for organizations: %s %s", (method, path) => {
		expect(workspaceAccessForPath(path, method)).toBeUndefined();
	});

	it.each([
		ApiPaths.cloudProviders,
		ApiPaths.cloudProjects,
		ApiPaths.cloudAuth,
		ApiPaths.cloudAccountImage,
	])("permits content members to read %s without granting writes", (path) => {
		expect(workspaceAccessForPath(path, "GET")).toBe("content");
		expect(workspaceAccessForPath(path, "POST")).toBe("administration");
		expect(workspaceAccessForPath(path, "DELETE")).toBe("administration");
	});

	it.each([
		ApiPaths.cloudProviderConnections,
		ApiPaths.cloudAuthLoginStart,
		ApiPaths.cloudAuthLoginPoll("operation_a"),
		ApiPaths.cloudAccountImageBuild,
		`${ApiPaths.cloudProjects}/project_a`,
	])("keeps %s restricted to administrators", (path) => {
		for (const method of ["GET", "POST", "DELETE"])
			expect(workspaceAccessForPath(path, method)).toBe("administration");
	});
});

describe("organization command and lifecycle route allowlist", () => {
	const base = "/v1/cloud/workspaces/workspace_a";
	it.each([
		["GET", "data-key"],
		["GET", "commands/watch"],
		["GET", "commands/command_a"],
		["POST", "commands"],
		["DELETE", "commands/command_a"],
		...["pause", "resume", "restart", "archive", "unarchive", "delete"].map(
			(action) => ["POST", action],
		),
	])("routes %s %s through content authorization", (method, suffix) => {
		expect(workspaceAccessForPath(`${base}/${suffix}`, method)).toBe("content");
	});

	it.each([
		["POST", "data-key"],
		["GET", "commands"],
		["DELETE", "commands/watch"],
		["POST", "commands/command_a"],
		["GET", "resume"],
		["DELETE", "delete"],
		["POST", "runtime/commands/lease"],
		["POST", "runtime/commands/ack"],
		["GET", "commands/command_a/extra"],
		["POST", "unknown"],
	])("does not expand access to %s %s", (method, suffix) => {
		expect(workspaceAccessForPath(`${base}/${suffix}`, method)).toBeUndefined();
	});
});

it("lets members connect their own GitHub but reserves installation removal for admins", () => {
	expect(workspaceAccessForPath(ApiPaths.cloudGithub, "GET")).toBe("content");
	expect(workspaceAccessForPath(ApiPaths.cloudGithubInstall, "POST")).toBe(
		"content",
	);
	expect(
		workspaceAccessForPath("/v1/cloud/github/installations/1", "DELETE"),
	).toBe("administration");
});
