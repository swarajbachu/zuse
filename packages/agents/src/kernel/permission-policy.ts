export type RuntimeMode =
	| "approval-required"
	| "auto-accept-edits"
	| "auto-accept-edits-and-bash"
	| "full-access";

export type PermissionMode = "default" | "plan" | "acceptEdits";

export type ToolCategory =
	| "read"
	| "edit"
	| "execute"
	| "network"
	| "delegate"
	| "other"
	| "exit-plan";

export type PermissionVerdict = "allow" | "prompt" | "deny";

export const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
	/(^|\/)\.env(\.|$)/,
	/(^|\/)credentials(\.[^/]+)?$/i,
	/(^|\/)\.aws\//,
	/(^|\/)\.ssh\//,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
	/\.(pem|key|p12|pfx)$/i,
	/(^|\/)\.netrc$/,
	/(^|\/)\.pgpass$/,
];

export const isSensitivePath = (path: string): boolean =>
	SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));

export type PermissionInput = {
	readonly runtimeMode: RuntimeMode;
	readonly permissionMode: PermissionMode;
	readonly category: ToolCategory;
	readonly sensitive: boolean;
	readonly canPrompt?: boolean;
};

const promptOrDeny = (canPrompt: boolean | undefined): PermissionVerdict =>
	canPrompt === false ? "deny" : "prompt";

export const decidePermission = (input: PermissionInput): PermissionVerdict => {
	if (input.sensitive || input.category === "exit-plan") {
		return promptOrDeny(input.canPrompt);
	}
	if (input.permissionMode === "plan") {
		return input.category === "read" ? "allow" : promptOrDeny(input.canPrompt);
	}
	if (input.category === "read") return "allow";
	if (input.permissionMode === "acceptEdits" && input.category === "edit") {
		return "allow";
	}

	switch (input.runtimeMode) {
		case "approval-required":
			return promptOrDeny(input.canPrompt);
		case "auto-accept-edits":
			return input.category === "edit"
				? "allow"
				: promptOrDeny(input.canPrompt);
		case "auto-accept-edits-and-bash":
			return input.category === "edit" || input.category === "execute"
				? "allow"
				: promptOrDeny(input.canPrompt);
		case "full-access":
			return "allow";
	}
};
