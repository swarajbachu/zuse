import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { ConvexAuthService } from "./services/convex-auth-service.ts";
import { DeployService } from "./services/deploy-service.ts";

const Detect = MemoizeRpcs.toLayerHandler(
  "deploy.detect",
  ({ folderId, worktreeId }) =>
    Effect.flatMap(DeployService, (svc) => svc.detect(folderId, worktreeId)),
);

const Start = MemoizeRpcs.toLayerHandler(
  "deploy.start",
  ({ folderId, worktreeId }) =>
    Effect.flatMap(DeployService, (svc) => svc.start(folderId, worktreeId)),
);

const Events = MemoizeRpcs.toLayerHandler(
  "deploy.events",
  ({ folderId, worktreeId }) =>
    Stream.unwrap(
      Effect.map(DeployService, (svc) => svc.events(folderId, worktreeId)),
    ),
);

const Cancel = MemoizeRpcs.toLayerHandler("deploy.cancel", ({ deploymentId }) =>
  Effect.flatMap(DeployService, (svc) => svc.cancel(deploymentId)),
);

const History = MemoizeRpcs.toLayerHandler(
  "deploy.history",
  ({ folderId, limit }) =>
    Effect.flatMap(DeployService, (svc) => svc.history(folderId, limit)),
);

const LastFailure = MemoizeRpcs.toLayerHandler(
  "deploy.lastFailure",
  ({ folderId, worktreeId }) =>
    Effect.flatMap(DeployService, (svc) =>
      svc.lastFailure(folderId, worktreeId),
    ),
);

const ConvexStatus = MemoizeRpcs.toLayerHandler("deploy.convexStatus", () =>
  Effect.flatMap(ConvexAuthService, (svc) => svc.status()),
);

const ConnectConvex = MemoizeRpcs.toLayerHandler("deploy.connectConvex", () =>
  Effect.flatMap(ConvexAuthService, (svc) => svc.connect()),
);

const DisconnectConvex = MemoizeRpcs.toLayerHandler(
  "deploy.disconnectConvex",
  () => Effect.flatMap(ConvexAuthService, (svc) => svc.disconnect()),
);

export const DeployHandlersLayer = Layer.mergeAll(
  Detect,
  Start,
  Events,
  Cancel,
  History,
  LastFailure,
  ConvexStatus,
  ConnectConvex,
  DisconnectConvex,
);
