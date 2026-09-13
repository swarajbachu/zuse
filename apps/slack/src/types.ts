import type { InstallationStore } from "./installations.ts";
import type { ZuseClientConfig } from "./zuse.ts";

export interface StateStore {
	get(key: string): Promise<string | null>;
	put(
		key: string,
		value: string,
		options?: { expirationTtl?: number },
	): Promise<void>;
}
export interface AppEnv {
	readonly store: InstallationStore;
	readonly cloud: (accountId: string) => ZuseClientConfig;
	readonly identity: {
		readonly clientId: string;
		exchange(code: string, verifier: string): Promise<{ accountId: string }>;
	};
	readonly JOBS: {
		send(job: AppJob, options?: { delaySeconds: number }): Promise<void>;
	};
	readonly APP_ORIGIN: string;
	readonly SLACK_APP_ID: string;
	readonly SLACK_CLIENT_ID: string;
	readonly SLACK_CLIENT_SECRET: string;
	readonly SLACK_SIGNING_SECRET: string;
}
export type AppJob = {
	readonly teamId: string;
	readonly generation: string;
	readonly id: string;
} & (
	| { readonly kind: "home"; readonly userId: string }
	| {
			readonly kind: "reply-mode";
			readonly userId: string;
			readonly mode: "mentions" | "all";
			readonly memberRevision: number;
	  }
	| {
			readonly kind: "status-clear";
			readonly channel: string;
			readonly threadTs: string;
			readonly version: string;
	  }
	| {
			readonly kind: "agent-required";
			readonly request: Extract<AppJob, { kind: "conversation" }>;
	  }
	| {
			readonly kind: "connected";
			readonly pendingRequest?: PendingConnectionRequest;
			readonly connectionId: string;
			readonly userId: string;
			readonly channel?: string;
	  }
	| {
			readonly kind: "picker";
			readonly userId: string;
			readonly token: string;
			readonly viewId: string;
	  }
	| {
			readonly kind: "selection";
			readonly agentChoice?: string;
			readonly userId: string;
			readonly token: string;
			readonly viewId: string;
			readonly projectId: string;
			readonly channelDefault: boolean;
			readonly personalDefault: boolean;
	  }
	| {
			readonly kind: "policy";
			readonly userId: string;
			readonly revision: number;
			readonly mode: import("./installations.ts").AccessMode;
	  }
	| {
			readonly kind: "disconnect";
			readonly userId: string;
			readonly connectionId: string;
	  }
	| {
			readonly kind: "project";
			readonly memberRevision?: number;
			readonly userId: string;
			readonly projectId: string;
			readonly revision: number;
	  }
	| {
			readonly kind: "conversation";
			readonly agentSelection?: {
				readonly agent: string;
				readonly model: string;
			};
			readonly userId: string;
			readonly channel: string;
			readonly threadTs: string;
			readonly messageTs: string;
			readonly text: string;
			readonly revision: number;
			readonly files?: ReadonlyArray<import("./slack.ts").SlackFileMetadata>;
			readonly projectId?: string;
			readonly selectionToken?: string;
			readonly connectionId?: string;
	  }
	| {
			readonly kind: "progress";
			readonly channel: string;
			readonly threadTs: string;
			readonly workspaceId: string;
			readonly turnKey: string;
			readonly connectionId: string;
			readonly startedAt: number;
			readonly userId?: string;
	  }
	| {
			readonly kind: "alert";
			readonly connectionId?: string;
			readonly revision: number;
			readonly channel: string;
			readonly threadTs: string;
			readonly ruleId: string;
	  }
);
export interface PendingConnectionRequest {
	readonly job: Extract<AppJob, { kind: "conversation" }>;
	readonly expiresAt: number;
}
export interface QueueMessage {
	readonly body: AppJob;
	readonly attempts: number;
	ack(): void;
	retry(options: { delaySeconds: number }): void;
}
