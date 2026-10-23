import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { ReviewGuideService } from "./service.ts";

const GuideStream = MemoizeRpcs.toLayerHandler(
	"reviewGuide.stream",
	({ folderId, worktreeId }) =>
		Stream.unwrap(
			Effect.map(ReviewGuideService, (svc) =>
				svc.stream({ folderId, worktreeId }),
			),
		),
);

const Generate = MemoizeRpcs.toLayerHandler(
	"reviewGuide.generate",
	({ folderId, worktreeId, originSessionId, force }) =>
		Effect.flatMap(ReviewGuideService, (svc) =>
			svc.generate(
				{ folderId, worktreeId },
				{ originSessionId: originSessionId ?? null, force: force ?? false },
			),
		),
);

const Cancel = MemoizeRpcs.toLayerHandler(
	"reviewGuide.cancel",
	({ folderId, worktreeId }) =>
		Effect.flatMap(ReviewGuideService, (svc) =>
			svc.cancel({ folderId, worktreeId }),
		),
);

export const ReviewGuideHandlersLayer = Layer.mergeAll(
	GuideStream,
	Generate,
	Cancel,
);
