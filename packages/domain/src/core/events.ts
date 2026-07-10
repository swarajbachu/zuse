import type { SegmentKind, SettlementOutcome } from "./commands.js";

export type SessionEvent =
	| {
			readonly _tag: "SessionCreated";
			readonly sessionId: string;
			readonly chatId: string;
			readonly projectId: string;
			readonly createdAt: number;
	  }
	| { readonly _tag: "SessionTitleSet"; readonly title: string }
	| { readonly _tag: "SessionArchived"; readonly archivedAt: number }
	| { readonly _tag: "SessionDeleted"; readonly deletedAt: number }
	| {
			readonly _tag: "TurnStarted";
			readonly turnId: string;
			readonly startedAt: number;
	  }
	| {
			readonly _tag: "TurnSettled";
			readonly turnId: string;
			readonly outcome: SettlementOutcome;
			readonly settledAt: number;
	  }
	| {
			readonly _tag: "MessagePersisted";
			readonly messageId: string;
			readonly turnId: string | null;
			readonly role: string;
			readonly kind: string;
			readonly contentJson: string;
			readonly parentItemId: string | null;
			readonly createdAt: number;
	  }
	| {
			readonly _tag: "SegmentOpened";
			readonly turnId: string;
			readonly segmentId: string;
			readonly kind: SegmentKind;
			readonly openedAt: number;
	  }
	| {
			readonly _tag: "SegmentSettled";
			readonly turnId: string;
			readonly segmentId: string;
			readonly outcome: SettlementOutcome;
			readonly settledAt: number;
	  }
	| {
			readonly _tag: "PermissionRequested";
			readonly requestId: string;
			readonly turnId: string;
			readonly payloadJson: string;
			readonly requestedAt: number;
	  }
	| {
			readonly _tag: "PermissionResolved";
			readonly requestId: string;
			readonly decision: string;
			readonly resolvedAt: number;
	  }
	| {
			readonly _tag: "ProviderAttached";
			readonly providerId: string;
			readonly attachedAt: number;
	  }
	| {
			readonly _tag: "ProviderDetached";
			readonly providerId: string;
			readonly detachedAt: number;
	  }
	| {
			readonly _tag: "CheckpointRecorded";
			readonly checkpointId: string;
			readonly payloadJson: string;
			readonly recordedAt: number;
	  }
	| {
			readonly _tag: "WorktreeArchiveRequested";
			readonly worktreeId: string;
			readonly requestedAt: number;
	  };
