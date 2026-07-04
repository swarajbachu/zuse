import { MemoizeRpcs } from "@zuse/wire";
import { Effect, Layer, Stream } from "effect";

import { SkillBridge } from "./services/skill-bridge.ts";

const SkillList = MemoizeRpcs.toLayerHandler("skill.list", ({ sessionId }) =>
  Effect.flatMap(SkillBridge, (svc) => svc.list(sessionId)),
);

const SkillStream = MemoizeRpcs.toLayerHandler(
  "skill.stream",
  ({ sessionId }) =>
    Stream.unwrap(
      Effect.map(SkillBridge, (svc) => svc.stream(sessionId)),
    ),
);

export const SkillHandlersLayer = Layer.mergeAll(SkillList, SkillStream);
