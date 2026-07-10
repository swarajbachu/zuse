export type ProviderId =
	| "claude"
	| "codex"
	| "grok"
	| "gemini"
	| "cursor"
	| "opencode";

export type AgentEvent =
	| {
			readonly _tag: "Started";
			readonly sessionId: string;
			readonly providerId: ProviderId;
			readonly mode: "spawn-cli" | "sdk";
	  }
	| {
			readonly _tag: "Status";
			readonly status:
				| "idle"
				| "starting"
				| "running"
				| "waiting"
				| "closed"
				| "error";
	  }
	| { readonly _tag: "Auth"; readonly sdkConfigured: boolean }
	| {
			readonly _tag: "Version";
			readonly cliVersion?: string;
			readonly sdkVersion?: string;
	  }
	| { readonly _tag: "Capabilities"; readonly capabilities: readonly string[] }
	| {
			readonly _tag: "AssistantMessage";
			readonly itemId: string;
			readonly text: string;
			readonly parentItemId?: string;
	  }
	| {
			readonly _tag: "Thinking";
			readonly itemId: string;
			readonly text: string;
			readonly redacted: boolean;
			readonly parentItemId?: string;
	  }
	| {
			readonly _tag: "ToolUse";
			readonly itemId: string;
			readonly tool: string;
			readonly input: unknown;
			readonly parentItemId?: string;
	  }
	| {
			readonly _tag: "ToolResult";
			readonly itemId: string;
			readonly output: unknown;
			readonly isError: boolean;
			readonly parentItemId?: string;
	  }
	| {
			readonly _tag: "PermissionRequest";
			readonly itemId: string;
			readonly kind: string;
			readonly details: unknown;
			readonly parentItemId?: string;
	  }
	| {
			readonly _tag: "UsageDelta";
			readonly inputTokens: number;
			readonly outputTokens: number;
			readonly cacheReadTokens: number;
			readonly cacheCreationTokens: number;
			readonly model: string;
			readonly parentItemId?: string;
	  }
	| {
			readonly _tag: "SubagentSummary";
			readonly itemId: string;
			readonly agentName: string;
			readonly model: string;
			readonly turns: number;
			readonly durationMs: number;
			readonly summary: string;
			readonly isError: boolean;
	  }
	| {
			readonly _tag: "ContextUsage";
			readonly providerId: ProviderId;
			readonly usedTokens: number | null;
			readonly windowTokens: number | null;
			readonly precision: "exact" | "estimated" | "capacity-only";
			readonly source?: string;
	  }
	| {
			readonly _tag: "ContextCompaction";
			readonly itemId: string;
			readonly providerId: ProviderId;
			readonly startedAt: number;
			readonly durationMs: number;
			readonly beforeTokens: number | null;
			readonly afterTokens: number | null;
			readonly status: "in_progress" | "completed";
	  }
	| {
			readonly _tag: "UsageLimit";
			readonly providerId: ProviderId;
			readonly label: string;
			readonly usedPercent: number | null;
			readonly resetsAt: string | null;
			readonly windowMinutes: number | null;
	  }
	| {
			readonly _tag: "SessionCursor";
			readonly cursor: string;
			readonly strategy:
				| "claude-session-id"
				| "codex-thread-id"
				| "grok-session-id"
				| "cursor-session-id"
				| "gemini-session-id"
				| "opencode-session-id";
	  }
	| {
			readonly _tag: "UserQuestion";
			readonly itemId: string;
			readonly questions: readonly {
				readonly question: string;
				readonly options: readonly string[];
				readonly multiSelect?: boolean;
			}[];
			readonly parentItemId?: string;
	  }
	| {
			readonly _tag: "PermissionModeChanged";
			readonly mode: "default" | "plan" | "acceptEdits";
	  }
	| {
			readonly _tag: "GoalUpdated";
			readonly goal: {
				readonly threadId: string;
				readonly objective: string;
				readonly status:
					| "active"
					| "paused"
					| "budgetLimited"
					| "usageLimited"
					| "blocked"
					| "complete";
				readonly tokenBudget: number | null;
				readonly tokensUsed: number;
				readonly timeUsedSeconds: number;
				readonly createdAt: number;
				readonly updatedAt: number;
			};
	  }
	| { readonly _tag: "GoalCleared" }
	| {
			readonly _tag: "Completed";
			readonly reason: "ended" | "interrupted" | "error";
	  }
	| { readonly _tag: "Interrupted" }
	| {
			readonly _tag: "Error";
			readonly message: string;
			readonly kind?: "auth" | "network" | "generic";
			readonly providerId?: ProviderId;
	  };
