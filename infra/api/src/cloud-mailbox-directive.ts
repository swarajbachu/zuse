import type { CloudMailboxLifecycleFence } from "./cloud-workspace-store.ts";

const HEADER = {
	action: "x-zuse-mailbox-action",
	account: "x-zuse-mailbox-account",
	billingPolicy: "x-zuse-mailbox-billing-policy",
	destructionFence: "x-zuse-mailbox-destruction-fence",
	lifecycle: "x-zuse-mailbox-lifecycle",
	runtimeGeneration: "x-zuse-mailbox-runtime-generation",
	wakeRevision: "x-zuse-mailbox-wake-revision",
	workspace: "x-zuse-mailbox-workspace",
} as const;

const RECONCILE_WORKSPACE_HEADER = "x-zuse-reconcile-cloud-workspace";

export type CloudMailboxCommandDirective =
	| {
			readonly action: "enqueue";
			readonly workspaceId: string;
			readonly accountId: string;
	  }
	| {
			readonly action: "status";
			readonly workspaceId: string;
	  }
	| {
			readonly action: "watch";
			readonly workspaceId: string;
	  }
	| {
			readonly action: "cancel";
			readonly workspaceId: string;
	  }
	| {
			readonly action: "ack";
			readonly workspaceId: string;
	  }
	| {
			readonly action: "lease";
			readonly workspaceId: string;
			readonly runtimeGeneration: number;
			readonly wakeRevision?: number;
	  };

export interface CloudMailboxBillingDirective {
	readonly policy: "available" | "blocked";
	readonly accountId: string;
}

export interface CloudMailboxDirective {
	readonly command?: CloudMailboxCommandDirective;
	readonly billing?: CloudMailboxBillingDirective;
	readonly lifecycle?: CloudMailboxLifecycleFence & {
		readonly action: "archive" | "delete";
	};
}

export type CloudMailboxDirectiveParseResult =
	| { readonly kind: "none" }
	| { readonly kind: "invalid"; readonly reason: string }
	| { readonly kind: "directive"; readonly directive: CloudMailboxDirective };

const mailboxHeaderNames = Object.values(HEADER);

const positiveInteger = (value: string | null): number | undefined => {
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const nonnegativeInteger = (value: string | null): number | undefined => {
	if (value === null || value.trim() === "") return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const setWorkspace = (headers: Headers, workspaceId: string): void => {
	const current = headers.get(HEADER.workspace);
	if (current !== null && current !== workspaceId)
		throw new Error("conflicting cloud mailbox workspace directives");
	headers.set(HEADER.workspace, workspaceId);
};

/**
 * Encode the API route's internal command handoff to the Worker. The header
 * representation remains compatible with an additive Worker rollout, while
 * callers and consumers share one typed source of truth.
 */
export const attachCloudMailboxCommandDirective = (
	response: Response,
	directive: CloudMailboxCommandDirective,
): Response => {
	setWorkspace(response.headers, directive.workspaceId);
	response.headers.set(HEADER.action, directive.action);
	if (directive.action === "enqueue")
		response.headers.set(HEADER.account, directive.accountId);
	if (directive.action === "lease") {
		response.headers.set(
			HEADER.runtimeGeneration,
			String(directive.runtimeGeneration),
		);
		if (directive.wakeRevision !== undefined)
			response.headers.set(HEADER.wakeRevision, String(directive.wakeRevision));
	}
	return response;
};

export const attachCloudMailboxBillingDirective = (
	response: Response,
	directive: CloudMailboxBillingDirective,
): Response => {
	response.headers.set(HEADER.billingPolicy, directive.policy);
	const current = response.headers.get(HEADER.account);
	if (current !== null && current !== directive.accountId)
		throw new Error("conflicting cloud mailbox account directives");
	response.headers.set(HEADER.account, directive.accountId);
	return response;
};

export const attachCloudMailboxLifecycleDirective = (
	response: Response,
	directive: CloudMailboxLifecycleFence & {
		readonly action: "archive" | "delete";
	},
): Response => {
	setWorkspace(response.headers, directive.workspaceId);
	response.headers.set(HEADER.lifecycle, directive.action);
	response.headers.set(
		HEADER.destructionFence,
		String(directive.destructionFence),
	);
	return response;
};

/**
 * Parse and consume every internal mailbox header in one place. A malformed
 * directive is never partially applied: the Worker must fail the handoff as a
 * unit instead of guessing which action the route intended.
 */
export const takeCloudMailboxDirective = (
	response: Response,
): CloudMailboxDirectiveParseResult => {
	const values = {
		action: response.headers.get(HEADER.action),
		accountId: response.headers.get(HEADER.account),
		billingPolicy: response.headers.get(HEADER.billingPolicy),
		destructionFence: response.headers.get(HEADER.destructionFence),
		lifecycle: response.headers.get(HEADER.lifecycle),
		runtimeGeneration: response.headers.get(HEADER.runtimeGeneration),
		wakeRevision: response.headers.get(HEADER.wakeRevision),
		workspaceId:
			response.headers.get(HEADER.workspace) ??
			response.headers.get(RECONCILE_WORKSPACE_HEADER),
	};
	const hasMailboxHeader = mailboxHeaderNames.some((name) =>
		response.headers.has(name),
	);
	for (const name of mailboxHeaderNames) response.headers.delete(name);
	if (!hasMailboxHeader) return { kind: "none" };

	const workspaceId = values.workspaceId?.trim();
	if (workspaceId === undefined || workspaceId === "")
		return { kind: "invalid", reason: "missing-workspace" };

	let lifecycle: CloudMailboxDirective["lifecycle"];
	if (values.lifecycle !== null) {
		if (values.lifecycle !== "archive" && values.lifecycle !== "delete")
			return { kind: "invalid", reason: "invalid-lifecycle" };
		const destructionFence = nonnegativeInteger(values.destructionFence);
		if (destructionFence === undefined)
			return { kind: "invalid", reason: "invalid-destruction-fence" };
		lifecycle = {
			workspaceId,
			action: values.lifecycle,
			destructionFence,
		};
	} else if (values.destructionFence !== null) {
		return { kind: "invalid", reason: "orphan-destruction-fence" };
	}

	let billing: CloudMailboxDirective["billing"];
	if (values.billingPolicy !== null) {
		if (
			values.billingPolicy !== "available" &&
			values.billingPolicy !== "blocked"
		)
			return { kind: "invalid", reason: "invalid-billing-policy" };
		if (values.accountId === null || values.accountId.trim() === "")
			return { kind: "invalid", reason: "missing-billing-account" };
		billing = {
			policy: values.billingPolicy,
			accountId: values.accountId,
		};
	}

	let command: CloudMailboxCommandDirective | undefined;
	switch (values.action) {
		case null:
			if (
				values.runtimeGeneration !== null ||
				values.wakeRevision !== null ||
				(values.accountId !== null && billing === undefined)
			)
				return { kind: "invalid", reason: "orphan-command-metadata" };
			break;
		case "enqueue":
			if (values.accountId === null || values.accountId.trim() === "")
				return { kind: "invalid", reason: "missing-enqueue-account" };
			if (
				values.runtimeGeneration !== null ||
				values.wakeRevision !== null ||
				billing !== undefined
			)
				return { kind: "invalid", reason: "invalid-enqueue-metadata" };
			command = {
				action: "enqueue",
				workspaceId,
				accountId: values.accountId,
			};
			break;
		case "status":
		case "watch":
			if (billing === undefined)
				return { kind: "invalid", reason: "missing-read-billing-policy" };
			if (values.runtimeGeneration !== null || values.wakeRevision !== null)
				return { kind: "invalid", reason: "invalid-read-metadata" };
			command = { action: values.action, workspaceId };
			break;
		case "cancel":
		case "ack":
			if (
				billing !== undefined ||
				values.accountId !== null ||
				values.runtimeGeneration !== null ||
				values.wakeRevision !== null
			)
				return { kind: "invalid", reason: "invalid-forward-metadata" };
			command = { action: values.action, workspaceId };
			break;
		case "lease": {
			if (billing === undefined)
				return { kind: "invalid", reason: "missing-lease-billing-policy" };
			const runtimeGeneration = positiveInteger(values.runtimeGeneration);
			if (runtimeGeneration === undefined)
				return { kind: "invalid", reason: "invalid-runtime-generation" };
			const wakeRevision =
				values.wakeRevision === null
					? undefined
					: positiveInteger(values.wakeRevision);
			if (values.wakeRevision !== null && wakeRevision === undefined)
				return { kind: "invalid", reason: "invalid-wake-revision" };
			command = {
				action: "lease",
				workspaceId,
				runtimeGeneration,
				...(wakeRevision === undefined ? {} : { wakeRevision }),
			};
			break;
		}
		default:
			return { kind: "invalid", reason: "invalid-action" };
	}

	if (command === undefined && lifecycle === undefined)
		return { kind: "invalid", reason: "empty-directive" };
	return {
		kind: "directive",
		directive: {
			...(command === undefined ? {} : { command }),
			...(billing === undefined ? {} : { billing }),
			...(lifecycle === undefined ? {} : { lifecycle }),
		},
	};
};
