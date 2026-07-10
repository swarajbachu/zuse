import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { AttachmentService } from "./services/attachment-service.ts";

const Upload = MemoizeRpcs.toLayerHandler(
  "attachments.upload",
  ({ sessionId, bytes, mimeType, originalName, rootPath }) =>
    Effect.flatMap(AttachmentService, (svc) =>
      svc.upload(sessionId, bytes, mimeType, originalName, rootPath),
    ),
);

const SaveText = MemoizeRpcs.toLayerHandler(
  "context.saveText",
  ({ sessionId, text, ext, rootPath }) =>
    Effect.flatMap(AttachmentService, (svc) =>
      svc.saveText(sessionId, text, ext, rootPath),
    ),
);

export const AttachmentHandlersLayer = Layer.mergeAll(Upload, SaveText);
