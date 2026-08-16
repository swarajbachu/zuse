import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { RepositorySettingsService } from "./services/repository-settings-service.ts";

const Get = MemoizeRpcs.toLayerHandler(
  "repositorySettings.get",
  ({ projectId }) =>
    Effect.flatMap(RepositorySettingsService, (svc) => svc.get(projectId)),
);

const Update = MemoizeRpcs.toLayerHandler(
  "repositorySettings.update",
  ({ projectId, patch }) =>
    Effect.flatMap(RepositorySettingsService, (svc) =>
      svc.update(projectId, patch),
    ),
);

export const RepositorySettingsHandlersLayer = Layer.mergeAll(Get, Update);
