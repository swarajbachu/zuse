export type SegmentKind = "assistant" | "reasoning" | "tool";
export type SettlementOutcome = "completed" | "interrupted" | "error";

export type SessionCommand =
	| {
			readonly _tag: "CreateSession";
			readonly sessionId: string;
			readonly chatId: string;
			readonly projectId: string;
			readonly createdAt: number;
	  }
	| { readonly _tag: "SetTitle"; readonly title: string }
	| { readonly _tag: "ArchiveSession"; readonly archivedAt: number }
	| { readonly _tag: "DeleteSession"; readonly deletedAt: number }
	| {
			readonly _tag: "StartTurn";
			readonly turnId: string;
			readonly startedAt: number;
	  }
	| {
			readonly _tag: "SettleTurn";
			readonly turnId: string;
			readonly outcome: SettlementOutcome;
			readonly settledAt: number;
	  }
	| {
			readonly _tag: "PersistMessage";
			readonly messageId: string;
			readonly turnId: string | null;
			readonly role: string;
			readonly kind: string;
			readonly contentJson: string;
			readonly parentItemId: string | null;
			readonly createdAt: number;
	  }
	| {
			readonly _tag: "OpenSegment";
			readonly turnId: string;
			readonly segmentId: string;
			readonly kind: SegmentKind;
			readonly openedAt: number;
	  }
	| {
			readonly _tag: "SettleSegment";
			readonly turnId: string;
			readonly segmentId: string;
			readonly outcome: SettlementOutcome;
			readonly settledAt: number;
	  }
	| {
			readonly _tag: "RequestPermission";
			readonly requestId: string;
			readonly turnId: string;
			readonly payloadJson: string;
			readonly requestedAt: number;
	  }
	| {
			readonly _tag: "ResolvePermission";
			readonly requestId: string;
			readonly decision: string;
			readonly resolvedAt: number;
	  }
	| {
			readonly _tag: "AttachProvider";
			readonly providerId: string;
			readonly attachedAt: number;
	  }
	| { readonly _tag: "DetachProvider"; readonly detachedAt: number }
	| {
			readonly _tag: "RecordCheckpoint";
			readonly checkpointId: string;
			readonly payloadJson: string;
			readonly recordedAt: number;
	  }
	| {
			readonly _tag: "RequestWorktreeArchive";
			readonly worktreeId: string;
			readonly requestedAt: number;
	  };
