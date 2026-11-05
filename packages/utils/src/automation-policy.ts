import type { AutomationConfig } from "@zuse/contracts";

/** Facts about the runtime which decide whether a policy can be enforced. */
export interface AutomationPolicyRuntime {
	readonly environment: AutomationConfig["environment"];
	readonly emailNotifications: boolean;
	/** Whether runs can be started as cloud agents from this runtime. */
	readonly cloudMachines?: boolean;
}

export type AutomationPolicyField =
	| "triggers"
	| "queue"
	| "runAs"
	| "environment"
	| "machine"
	| "network"
	| "childSessions"
	| "spendLimit"
	| "mcp"
	| "session"
	| "action"
	| "notifications";

export interface AutomationPolicyIssue {
	readonly field: AutomationPolicyField;
	readonly message: string;
	/** Index of the offending notification, when the field is notifications. */
	readonly index?: number;
}

export const SLACK_NOTIFICATION_DESTINATION =
	/^(?:T[A-Z0-9]+\/)?[CG][A-Z0-9]+$/u;
export const EMAIL_NOTIFICATION_DESTINATION =
	/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/u;

/** Providers which can enforce a hard spending cap. */
export const AUTOMATION_RESTRICTION_PROVIDERS: ReadonlyArray<
	AutomationConfig["providerId"]
> = ["claude"];

/**
 * Every restriction the runtime cannot enforce, in priority order. The server
 * rejects enabling or running an automation with any issue; the editor shows
 * the same issues next to the controls that caused them.
 */
export function automationPolicyIssues(
	config: AutomationConfig,
	runtime: AutomationPolicyRuntime,
): ReadonlyArray<AutomationPolicyIssue> {
	const issues: AutomationPolicyIssue[] = [];
	const add = (field: AutomationPolicyField, message: string, index?: number) =>
		issues.push(
			index === undefined ? { field, message } : { field, message, index },
		);
	const restricted = AUTOMATION_RESTRICTION_PROVIDERS.includes(
		config.providerId,
	);
	if (config.triggers.length === 0)
		add("triggers", "Add at least one trigger.");
	if (config.queue.maxConcurrency > 20)
		add("queue", "Maximum concurrency is 20.");
	if (config.runAs !== "owner")
		add(
			"runAs",
			"System identities are not available in this runtime. Choose owner.",
		);
	if (config.environment !== runtime.environment)
		add("environment", "Create this automation in its target environment.");
	if (config.cloudMachine) {
		if (!runtime.cloudMachines)
			add(
				"machine",
				"Cloud machines can only be chosen from Zuse on your computer.",
			);
		if (config.action === "existing_session")
			add(
				"machine",
				"Messages to an existing session run where that session lives. Choose this computer.",
			);
		if (config.action === "code_scan")
			add(
				"machine",
				"Read-only code scans run on this computer; cloud agents cannot enforce read-only mode.",
			);
		if (config.spendLimitUsd !== null || config.mcpServerIds.length > 0)
			add(
				config.spendLimitUsd !== null ? "spendLimit" : "mcp",
				"Spending caps and MCP selection apply only to sessions on this computer.",
			);
		if (!config.allowChildSessions)
			add(
				"childSessions",
				"Cloud agents manage their own child sessions. Allow child sessions to run on a cloud machine.",
			);
	}
	if (!config.network.enabled || config.network.allowedDomains.length > 0)
		add(
			"network",
			"This runtime does not enforce per-session network isolation or domain allowlists.",
		);
	if (
		config.allowChildSessions &&
		(config.spendLimitUsd !== null || config.mcpServerIds.length > 0)
	)
		add(
			"childSessions",
			"Disable child sessions when using a spending cap or native MCP selection; spawned sessions cannot inherit these restrictions.",
		);
	if (config.spendLimitUsd !== null && !restricted)
		add(
			"spendLimit",
			"This provider cannot enforce a hard per-session spending cap.",
		);
	if (config.mcpServerIds.length > 0)
		add(
			"mcp",
			"MCP servers are managed through connected plugins. Per-automation native MCP selection is unavailable.",
		);
	if (config.action === "existing_session" && config.spendLimitUsd !== null)
		add(
			config.spendLimitUsd !== null ? "spendLimit" : "mcp",
			"Spending caps and native MCP selection require a new session.",
		);
	if (config.action === "existing_session" && !config.allowChildSessions)
		add(
			"childSessions",
			"An existing provider session cannot change its delegation policy. Allow child sessions or choose a new session.",
		);
	if (config.action === "existing_session" && config.sessionId === null)
		add("session", "Select a session for the existing-session action.");
	if (
		config.action === "auto_triage" &&
		config.triggers.some((trigger) => trigger._tag !== "slack")
	)
		add("action", "Automatic triage supports Slack triggers only.");
	config.notifications.forEach((notification, index) => {
		if (notification.channel === "slack") {
			if (runtime.environment !== "cloud")
				add(
					"notifications",
					"Slack completion notifications require a connected cloud integration.",
					index,
				);
			else if (!SLACK_NOTIFICATION_DESTINATION.test(notification.destination))
				add(
					"notifications",
					"Choose a Slack channel ID, optionally prefixed with its team ID.",
					index,
				);
			return;
		}
		if (!runtime.emailNotifications)
			add(
				"notifications",
				"Configure ZUSE_AUTOMATION_EMAIL_API_KEY and ZUSE_AUTOMATION_EMAIL_FROM to send email notifications.",
				index,
			);
		else if (!EMAIL_NOTIFICATION_DESTINATION.test(notification.destination))
			add("notifications", "Invalid email notification address.", index);
	});
	return issues;
}
