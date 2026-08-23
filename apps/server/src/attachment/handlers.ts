import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import { AttachmentNotFoundError, MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

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

const Read = MemoizeRpcs.toLayerHandler(
	"attachments.read",
	({ sessionId, id }) =>
		Effect.gen(function* () {
			const svc = yield* AttachmentService;
			const result = yield* svc.readForSession(sessionId, id);
			if (result === null) {
				return yield* new AttachmentNotFoundError({ sessionId, id });
			}
			return result;
		}),
);

export const AttachmentHandlersLayer = Layer.mergeAll(Upload, Read, SaveText);
