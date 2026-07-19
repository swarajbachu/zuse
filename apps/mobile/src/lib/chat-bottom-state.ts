import type { PendingPlanInteraction } from "@zuse/client-runtime/plan-interactions";
import type {
	PermissionRequest,
	ThreadGoal,
	UserQuestion,
} from "@zuse/contracts";

export type PendingQuestion = {
	readonly itemId: string;
	readonly questions: readonly UserQuestion[];
};

export type ChatBottomState = {
	readonly blocking:
		| {
				readonly kind: "permission";
				readonly requests: readonly PermissionRequest[];
		  }
		| { readonly kind: "question"; readonly question: PendingQuestion }
		| null;
	readonly planReview: PendingPlanInteraction | null;
	readonly goal: ThreadGoal | null;
	readonly queue: { readonly count: number; readonly paused: boolean };
};

export const coordinateChatBottomState = ({
	permissions,
	question,
	planReview,
	goal,
	serverQueueCount,
	localQueueCount,
	queuePaused,
}: {
	readonly permissions: readonly PermissionRequest[];
	readonly question: PendingQuestion | null;
	readonly planReview: PendingPlanInteraction | null;
	readonly goal: ThreadGoal | null;
	readonly serverQueueCount: number;
	readonly localQueueCount: number;
	readonly queuePaused: boolean;
}): ChatBottomState => ({
	blocking:
		permissions.length > 0
			? { kind: "permission", requests: permissions }
			: question === null
				? null
				: { kind: "question", question },
	planReview: permissions.length === 0 && question === null ? planReview : null,
	goal,
	queue: {
		count: serverQueueCount + localQueueCount,
		paused: queuePaused,
	},
});
