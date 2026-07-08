import { MemoizeRpcs } from "@zuse/wire";
import { Effect, Layer, Stream } from "effect";

import { MobileService } from "./services/mobile-service.ts";

const Availability = MemoizeRpcs.toLayerHandler("mobile.availability", () =>
  Effect.flatMap(MobileService, (svc) => svc.availability()),
);

const ListDevices = MemoizeRpcs.toLayerHandler("mobile.listDevices", () =>
  Effect.flatMap(MobileService, (svc) => svc.listDevices()),
);

const DetectProject = MemoizeRpcs.toLayerHandler(
  "mobile.detectProject",
  ({ cwd }) => Effect.flatMap(MobileService, (svc) => svc.detectProject(cwd)),
);

const Start = MemoizeRpcs.toLayerHandler(
  "mobile.start",
  ({ cwd, udid, source }) =>
    Effect.flatMap(MobileService, (svc) =>
      svc.start(cwd, udid, source ?? "user"),
    ),
);

const Stop = MemoizeRpcs.toLayerHandler("mobile.stop", () =>
  Effect.flatMap(MobileService, (svc) => svc.stop()),
);

const Status = MemoizeRpcs.toLayerHandler("mobile.status", () =>
  Effect.flatMap(MobileService, (svc) => svc.status()),
);

const Events = MemoizeRpcs.toLayerHandler("mobile.events", () =>
  Stream.unwrap(Effect.map(MobileService, (svc) => svc.events())),
);

const Frames = MemoizeRpcs.toLayerHandler("mobile.frames", () =>
  Stream.unwrap(Effect.map(MobileService, (svc) => svc.frames())),
);

export const MobileHandlersLayer = Layer.mergeAll(
  Availability,
  ListDevices,
  DetectProject,
  Start,
  Stop,
  Status,
  Events,
  Frames,
);

