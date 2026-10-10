import {
	PluginRequest,
	PluginToolRequest,
	WORKSPACE_SCOPE_HEADER,
} from "@zuse/contracts";
import { Clock, Effect, Option, Schema } from "effect";
import { authenticateWorkos } from "./auth.ts";
import { requireRuntime } from "./cloud-workspace-routes.ts";
import { ApiConfiguration } from "./config.ts";
import { badRequest, forbidden, serviceUnavailable } from "./errors.ts";
import { readLimitedJsonBody } from "./http.ts";
import { PluginHost, PluginOperationError } from "./plugin-host.ts";
import { resolveWorkspaceActorAccess } from "./workspace-authorization.ts";
import { requestWorkspaceScope } from "./workspace-scope.ts";

const pluginAccess = (
	request: Request,
	tenant: string | undefined,
	access: "content" | "administration",
) =>
	Effect.gen(function* () {
		const actor = yield* authenticateWorkos(request);
		const selected = yield* requestWorkspaceScope(request);
		const scope = tenant?.startsWith("organization:")
			? { kind: "organization" as const, organizationId: tenant.slice(13) }
			: selected;
		if (
			request.headers.has(WORKSPACE_SCOPE_HEADER) &&
			tenant !== undefined &&
			tenant !==
				(selected.kind === "organization"
					? `organization:${selected.organizationId}`
					: `personal:${actor.accountId}`)
		)
			return yield* forbidden("plugin_tenant_rejected");
		const resolved = yield* resolveWorkspaceActorAccess(actor, scope, access);
		const id =
			scope.kind === "organization"
				? resolved.ownerId
				: `personal:${actor.accountId}`;
		if (tenant !== undefined && tenant !== id)
			return yield* forbidden("plugin_tenant_rejected");
		return {
			identity: { tenant: id, subject: actor.accountId },
			canManage:
				resolved.membership === null ||
				resolved.membership.role.slug === "admin",
			tenant: {
				id,
				kind: scope.kind,
				name: scope.kind === "organization" ? "Organization" : "Personal",
			},
		};
	});

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
			const tenant = decodeURIComponent(mcp[1] ?? "");
			const { identity } = yield* pluginAccess(request, tenant, "content");
			// The MCP SDK loads on first use to keep Worker startup within limits.
			return yield* attempt(async () => {
				const { servePluginMcp } = await import("./plugin-mcp.ts");
				return servePluginMcp(request, identity, host.value);
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
				? yield* Effect.gen(function* () {
						const workspace = yield* requireRuntime(
							request,
							runtime[1] ?? "",
							yield* Clock.currentTimeMillis,
						);
						return {
							tenant: workspace.accountId.startsWith("organization:")
								? workspace.accountId
								: `personal:${workspace.accountId}`,
							subject: workspace.accountId,
						};
					})
				: (yield* pluginAccess(request, undefined, "content")).identity;
			const input = yield* Schema.decodeUnknownEffect(PluginToolRequest)(
				raw,
			).pipe(Effect.mapError(() => badRequest("invalid_plugin_tool")));
			return Response.json(
				yield* attempt(() => host.value.tools(identity, input)),
				{ headers: { "cache-control": "no-store" } },
			);
		}
		if (url.pathname !== "/v1/plugins")
			return yield* Effect.fail(badRequest("invalid_plugin_path"));
		const input = yield* Schema.decodeUnknownEffect(PluginRequest)(raw).pipe(
			Effect.mapError(() => badRequest("invalid_plugin_request")),
		);
		const { identity, tenant, canManage } = yield* pluginAccess(
			request,
			input.tenantId,
			input.action === "list" ? "content" : "administration",
		);
		const result = yield* attempt(() => host.value.request(identity, input));
		return Response.json(
			result.kind === "snapshot"
				? { ...result, tenants: [tenant], canManage }
				: result,
			{ headers: { "cache-control": "no-store" } },
		);
	});
