import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { LinearService } from "./services/linear-service.ts";

const ListConnections = MemoizeRpcs.toLayerHandler(
	"linear.listConnections",
	() => Effect.flatMap(LinearService, (service) => service.listConnections()),
);
const Connect = MemoizeRpcs.toLayerHandler("linear.connect", () =>
	Effect.flatMap(LinearService, (service) => service.connect()),
);
const Disconnect = MemoizeRpcs.toLayerHandler(
	"linear.disconnect",
	({ workspaceId }) =>
		Effect.flatMap(LinearService, (service) => service.disconnect(workspaceId)),
);
const ListIssues = MemoizeRpcs.toLayerHandler("linear.listIssues", (input) =>
	Effect.flatMap(LinearService, (service) => service.listIssues(input)),
);
const PrepareContext = MemoizeRpcs.toLayerHandler(
	"linear.prepareContext",
	(input) =>
		Effect.flatMap(LinearService, (service) => service.prepareContext(input)),
);

export const LinearHandlersLayer = Layer.mergeAll(
	ListConnections,
	Connect,
	Disconnect,
	ListIssues,
	PrepareContext,
);
