import {
	PluginRequest,
	type PluginTenant,
	PluginToolRequest,
} from "@zuse/contracts";
import { Clock, Effect, Option, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { requireRuntime } from "./cloud-workspace-routes.ts";
import { ApiConfiguration } from "./config.ts";
import { badRequest, forbidden, serviceUnavailable } from "./errors.ts";
import { readLimitedJsonBody } from "./http.ts";
import { PluginHost, PluginOperationError } from "./plugin-host.ts";

export const pluginTenants = (
	accountId: string,
	orgId?: string,
): PluginTenant[] => [
	{ id: `personal:${accountId}`, kind: "personal", name: "Personal" },
	...(orgId
		? [
				{
					id: `organization:${orgId}`,
					kind: "organization" as const,
					name: "Organization",
				},
			]
		: []),
];
export const routePluginRequest = (request: Request) =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/v1/plugins")) return null;
		const host = yield* Effect.serviceOption(PluginHost);
		if (Option.isNone(host))
			return yield* Effect.fail(serviceUnavailable("plugins_unavailable"));
		const attempt = <A>(f: () => Promise<A>) =>
			Effect.tryPromise({
				try: f,
				catch: (error) =>
					badRequest(
						error instanceof PluginOperationError
							? error.code
							: "plugin_operation_failed",
					),
			});
		if (
			/^\/v1\/plugins\/callback\/[a-f0-9]{64}$/.test(url.pathname) &&
			request.method === "GET"
		)
			return yield* attempt(() => host.value.callback(request));
		const mcp = /^\/v1\/plugins\/([^/]+)\/mcp$/.exec(url.pathname);
		if (mcp) {
			const principal = yield* requireWorkos(request);
			const tenant = decodeURIComponent(mcp[1] ?? "");
			if (
				!pluginTenants(principal.accountId, principal.orgId).some(
					(t) => t.id === tenant,
				)
			)
				return yield* Effect.fail(forbidden("plugin_tenant_rejected"));
			// The MCP SDK loads on first use to keep Worker startup within limits.
			return yield* attempt(async () => {
				const { servePluginMcp } = await import("./plugin-mcp.ts");
				return servePluginMcp(
					request,
					{ tenant, subject: principal.accountId },
					host.value,
				);
			});
		}
		if (request.method !== "POST")
			return yield* Effect.fail(badRequest("invalid_plugin_method"));
		// Check origin on browser management operations. Desktop requests have no Origin.
		const config = yield* ApiConfiguration;
		const origin = request.headers.get("origin");
		if (origin && !config.allowedBrowserOrigins.includes(origin))
			return yield* Effect.fail(forbidden("plugin_origin_rejected"));
		const raw = yield* attempt(() => readLimitedJsonBody(request, 128_000));
		const runtime = /^\/v1\/plugins\/runtime\/([^/]+)\/tools$/.exec(
			url.pathname,
		);
		if (runtime || url.pathname === "/v1/plugins/tools") {
			const identity = runtime
				? {
						accountId: (yield* requireRuntime(
							request,
							runtime[1] ?? "",
							yield* Clock.currentTimeMillis,
						)).accountId,
					}
				: yield* requireWorkos(request);
			const input = yield* Schema.decodeUnknownEffect(PluginToolRequest)(
				raw,
			).pipe(Effect.mapError(() => badRequest("invalid_plugin_tool")));
			return Response.json(
				yield* attempt(() =>
					host.value.tools(
						{
							tenant: `personal:${identity.accountId}`,
							subject: identity.accountId,
						},
						input,
					),
				),
				{ headers: { "cache-control": "no-store" } },
			);
		}
		if (url.pathname !== "/v1/plugins")
			return yield* Effect.fail(badRequest("invalid_plugin_path"));
		const principal = yield* requireWorkos(request);
		const tenants = pluginTenants(principal.accountId, principal.orgId);
		const input = yield* Schema.decodeUnknownEffect(PluginRequest)(raw).pipe(
			Effect.mapError(() => badRequest("invalid_plugin_request")),
		);
		const tenant = input.tenantId ?? `personal:${principal.accountId}`;
		if (!tenants.some((t) => t.id === tenant))
			return yield* Effect.fail(forbidden("plugin_tenant_rejected"));
		const result = yield* attempt(() =>
			host.value.request({ tenant, subject: principal.accountId }, input),
		);
		return Response.json(
			result.kind === "snapshot" ? { ...result, tenants } : result,
			{ headers: { "cache-control": "no-store" } },
		);
	});
