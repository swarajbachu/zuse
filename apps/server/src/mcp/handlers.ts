import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { McpService } from "./services/mcp-service.ts";

/**
 * mcp.* RPC handlers — thin passthroughs to McpService. The renderer's
 * composer popover polls `mcp.list` on open (cached snapshots return
 * immediately after one initial discovery), the refresh button awaits
 * `mcp.refresh`, and the settings pane drives `mcp.setEnabled` /
 * `mcp.authenticate`.
 */
const McpList = MemoizeRpcs.toLayerHandler(
	"mcp.list",
	({ projectId, provider }) =>
		Effect.flatMap(McpService, (svc) => svc.list({ projectId, provider })),
);

const McpRefresh = MemoizeRpcs.toLayerHandler(
	"mcp.refresh",
	({ projectId, provider }) =>
		Effect.flatMap(McpService, (svc) => svc.refresh({ projectId, provider })),
);

const McpSetEnabled = MemoizeRpcs.toLayerHandler(
	"mcp.setEnabled",
	({ key, enabled, projectId }) =>
		Effect.flatMap(McpService, (svc) =>
			svc.setEnabled(key, enabled, projectId),
		),
);

const McpAuthenticate = MemoizeRpcs.toLayerHandler(
	"mcp.authenticate",
	({ key, projectId }) =>
		Stream.unwrap(
			Effect.map(McpService, (svc) => svc.authenticate(key, projectId)),
		),
);

export const McpHandlersLayer = Layer.mergeAll(
	McpList,
	McpRefresh,
	McpSetEnabled,
	McpAuthenticate,
);
