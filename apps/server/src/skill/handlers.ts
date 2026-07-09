import { MemoizeRpcs } from "@zuse/wire";
import { Effect, Layer, Stream } from "effect";

import { SkillBridge } from "./services/skill-bridge.ts";

const SkillList = MemoizeRpcs.toLayerHandler("skill.list", ({ sessionId }) =>
  Effect.flatMap(SkillBridge, (svc) => svc.list(sessionId)),
);

const SkillListForProject = MemoizeRpcs.toLayerHandler(
  "skill.listForProject",
  ({ projectId, providerId }) =>
    Effect.flatMap(SkillBridge, (svc) =>
      svc.listForProject(projectId, providerId),
    ),
);

const SkillStream = MemoizeRpcs.toLayerHandler(
  "skill.stream",
  ({ sessionId }) =>
    Stream.unwrap(Effect.map(SkillBridge, (svc) => svc.stream(sessionId))),
);

export const SkillHandlersLayer = Layer.mergeAll(
  SkillList,
  SkillListForProject,
  SkillStream,
);
