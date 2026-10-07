import { expect, test, vi } from "vitest";
import {
	handlePluginTool,
	type PluginPermissionOptions,
	pluginCliEnv,
} from "../../src/drivers/plugin-tools.ts";

const args = {
	address: "tools.linear.user.work.update",
	arguments: { title: "Changed" },
};
test("discovery is available but invocation is blocked in plan mode", async () => {
	const request = vi.fn(async () => []);
	const permissions: PluginPermissionOptions = {
		getRuntimeMode: () => "full-access",
		getPermissionMode: () => "plan",
		requestPermission: vi.fn(),
	};
	await handlePluginTool("plugins_list", {}, { request }, permissions);
	expect(request).toHaveBeenCalledWith({ action: "list" });
	await handlePluginTool(
		"plugins_search",
		{ query: "issue" },
		{ request },
		permissions,
	);
	await expect(
		handlePluginTool("plugins_call", args, { request }, permissions),
	).rejects.toThrow("plan mode");
	expect(request).toHaveBeenCalledTimes(2);
});
test("denial prevents upstream invocation; approval binds the actual tool arguments", async () => {
	const request = vi.fn(async () => ({ ok: true }));
	const requestPermission = vi.fn<PluginPermissionOptions["requestPermission"]>(
		async () => ({ _tag: "Deny" }),
	);
	const permissions: PluginPermissionOptions = {
		getRuntimeMode: () => "approval-required",
		getPermissionMode: () => "default",
		requestPermission,
	};
	await expect(
		handlePluginTool("plugins_call", args, { request }, permissions),
	).rejects.toThrow("denied");
	expect(request).not.toHaveBeenCalled();
	requestPermission.mockResolvedValue({ _tag: "AllowOnce" });
	await handlePluginTool("plugins_call", args, { request }, permissions);
	expect(request).toHaveBeenCalledWith({ action: "call", ...args });
	expect(requestPermission.mock.calls[0]?.[0]).toMatchObject({
		tool: args.address,
	});
});

test("session plugin credentials survive provider shell secret-name filtering", () => {
	const env = pluginCliEnv("http://127.0.0.1:1234/mcp", "session-auth");
	const shellEnv = Object.fromEntries(
		Object.entries(env).filter(([key]) => !/KEY|SECRET|TOKEN/i.test(key)),
	);
	expect(shellEnv).toEqual({
		ZUSE_PLUGIN_URL: "http://127.0.0.1:1234/plugins",
		ZUSE_PLUGIN_AUTH: "session-auth",
	});
});
