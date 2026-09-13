import { mailboxBookkeepingWithDeadline } from "./cloud-mailbox-bookkeeping.ts";
import { takeCloudMailboxDirective } from "./cloud-mailbox-directive.ts";
import type { CloudMailboxLifecycleFence } from "./cloud-workspace-store.ts";

interface WorkspaceMailboxNamespace {
	readonly idFromName: (name: string) => unknown;
	readonly get: (id: unknown) => {
		readonly fetch: (request: Request) => Promise<Response>;
	};
}

export interface CloudMailboxCoordinatorApi {
	readonly dispose: () => Promise<void>;
	readonly requestCloudMailboxWake: (
		workspaceId: string,
		accountId: string,
	) => Promise<"ready" | "blocked" | "destroyed">;
	readonly reconcileCloudWorkspaceStartup: (
		workspaceId: string,
	) => Promise<void>;
	readonly completeCloudMailboxDrain: (
		workspaceId: string,
		accountId: string,
		runtimeGeneration: number,
		wakeRevision: number,
	) => Promise<boolean>;
	readonly recordCloudMailboxRuntimeProgress: (
		workspaceId: string,
		accountId: string,
		runtimeGeneration: number,
		wakeRevision: number,
		mailboxRevision: number,
		fenceRequired: boolean,
	) => Promise<boolean>;
	readonly acknowledgeCloudMailboxLifecycle: (
		lifecycle: CloudMailboxLifecycleFence,
		nowMs: number,
	) => Promise<boolean>;
}

export interface CloudMailboxCoordinatorContext {
	readonly waitUntil: (promise: Promise<unknown>) => void;
}

export const cloudMailboxUnavailableResponse = (): Response =>
	new Response(JSON.stringify({ code: "cloud-command-mailbox-unavailable" }), {
		status: 503,
		headers: { "content-type": "application/json" },
	});

export const deliverCloudMailboxLifecycle = async (
	mailboxes: WorkspaceMailboxNamespace,
	lifecycle: CloudMailboxLifecycleFence,
): Promise<boolean> => {
	const mailbox = mailboxes.get(mailboxes.idFromName(lifecycle.workspaceId));
	const response = await mailboxBookkeepingWithDeadline(
		mailbox.fetch(
			new Request("https://workspace-mailbox.internal/lifecycle", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: lifecycle.action,
					destructionFence: lifecycle.destructionFence,
				}),
			}),
		),
	);
	if (!response.ok)
		throw new Error(`workspace mailbox lifecycle rejected: ${response.status}`);
	return true;
};

const assertUnreachableCommand = (command: never): never => {
	throw new Error(
		`unhandled cloud mailbox command: ${JSON.stringify(command)}`,
	);
};

const commandIdentifier = (body: string): string => {
	const decoded = JSON.parse(body) as { readonly commandId?: unknown };
	if (typeof decoded.commandId !== "string" || decoded.commandId === "")
		throw new Error("cloud mailbox command id missing");
	return decoded.commandId;
};

const watchRevision = (body: string): number => {
	const decoded = JSON.parse(body) as { readonly afterRevision?: unknown };
	if (
		typeof decoded.afterRevision !== "number" ||
		!Number.isSafeInteger(decoded.afterRevision) ||
		decoded.afterRevision < 0
	)
		throw new Error("cloud mailbox watch revision invalid");
	return decoded.afterRevision;
};

/**
 * Apply the typed API-to-Worker handoff. `undefined` means there was no mailbox
 * command response and the Worker should continue its normal gateway/reconcile
 * processing. Every command variant is terminally handled here.
 */
export const coordinateCloudMailboxResponse = async (input: {
	readonly response: Response;
	readonly mailboxes: WorkspaceMailboxNamespace;
	readonly mailboxEnabled: boolean;
	readonly api: CloudMailboxCoordinatorApi;
	readonly context: CloudMailboxCoordinatorContext;
	readonly nowMs?: () => number;
}): Promise<Response | undefined> => {
	const parsed = takeCloudMailboxDirective(input.response);
	if (parsed.kind === "none") return undefined;
	if (parsed.kind === "invalid") {
		console.error("[workspace-mailbox] invalid internal directive", {
			reason: parsed.reason,
		});
		await input.api.dispose();
		return cloudMailboxUnavailableResponse();
	}
	const { command, billing, lifecycle } = parsed.directive;
	if (lifecycle !== undefined) {
		try {
			if (!(await deliverCloudMailboxLifecycle(input.mailboxes, lifecycle))) {
				console.error(
					"[workspace-mailbox] lifecycle fence rejected",
					lifecycle,
				);
				await input.api.dispose();
				return cloudMailboxUnavailableResponse();
			}
			await input.api.acknowledgeCloudMailboxLifecycle(
				lifecycle,
				(input.nowMs ?? Date.now)(),
			);
		} catch (error) {
			console.error("[workspace-mailbox] lifecycle fence failed", {
				...lifecycle,
				error,
			});
			await input.api.dispose();
			return cloudMailboxUnavailableResponse();
		}
	}
	if (command === undefined) return undefined;

	const mailbox = input.mailboxes.get(
		input.mailboxes.idFromName(command.workspaceId),
	);
	const body = await input.response.text();
	const internal = (path: string, method: string, value?: string) =>
		mailbox.fetch(
			new Request(`https://workspace-mailbox.internal${path}`, {
				method,
				headers:
					value === undefined
						? undefined
						: { "content-type": "application/json" },
				body: value,
			}),
		);
	let apiOwnedByPolicyReconcile = false;
	try {
		if (billing !== undefined) {
			const policyResponse = await internal(
				billing.policy === "available" ? "/unblock" : "/block",
				"POST",
				JSON.stringify({ blockedUntil: "billing-restored" }),
			);
			if (!policyResponse.ok) {
				await input.api.dispose();
				return cloudMailboxUnavailableResponse();
			}
			if (billing.policy === "available" && command.action !== "lease") {
				const policyResult = (await policyResponse.json()) as {
					readonly unblocked?: number;
				};
				if ((policyResult.unblocked ?? 0) > 0) {
					const wake = await input.api.requestCloudMailboxWake(
						command.workspaceId,
						billing.accountId,
					);
					if (wake === "ready") {
						apiOwnedByPolicyReconcile = true;
						input.context.waitUntil(
							input.api
								.reconcileCloudWorkspaceStartup(command.workspaceId)
								.finally(() => input.api.dispose()),
						);
					} else {
						await internal(
							"/block",
							"POST",
							JSON.stringify({ blockedUntil: "billing-restored" }),
						);
					}
				}
			}
		}

		if (command.action === "enqueue") {
			if (!input.mailboxEnabled) {
				await input.api.dispose();
				return new Response(
					JSON.stringify({ code: "cloud-command-mailbox-disabled" }),
					{ status: 409, headers: { "content-type": "application/json" } },
				);
			}
			const reserved = await internal("/reserve", "POST", body);
			if (!reserved.ok) {
				await input.api.dispose();
				return reserved;
			}
			const commandId = commandIdentifier(body);
			const wake = await input.api.requestCloudMailboxWake(
				command.workspaceId,
				command.accountId,
			);
			if (wake === "destroyed") {
				const cancelled = await internal(
					"/cancel",
					"POST",
					JSON.stringify({
						commandId,
						category: "workspace-destroyed",
					}),
				);
				if (!cancelled.ok) {
					await input.api.dispose();
					return cancelled;
				}
				const notAccepted = await internal(
					"/commit",
					"POST",
					JSON.stringify({ commandId }),
				);
				await input.api.dispose();
				return notAccepted;
			}
			const committed = await internal(
				"/commit",
				"POST",
				JSON.stringify({
					commandId,
					...(wake === "blocked" ? { blockedUntil: "billing-restored" } : {}),
				}),
			);
			if (!committed.ok) {
				await input.api.dispose();
				return committed;
			}
			const finalFence = await input.api.requestCloudMailboxWake(
				command.workspaceId,
				command.accountId,
			);
			if (finalFence === "destroyed") {
				const cancelled = await internal(
					"/cancel",
					"POST",
					JSON.stringify({
						commandId,
						category: "workspace-destroyed",
					}),
				);
				if (!cancelled.ok)
					console.error(
						"[workspace-mailbox] post-acceptance compensation rejected",
						{
							workspaceId: command.workspaceId,
							commandId,
							status: cancelled.status,
						},
					);
				await input.api.dispose();
				return committed;
			}
			if (finalFence !== wake) {
				const policyResponse = await internal(
					finalFence === "ready" ? "/unblock" : "/block",
					"POST",
					JSON.stringify({
						commandId,
						blockedUntil: "billing-restored",
					}),
				);
				if (!policyResponse.ok) {
					await input.api.dispose();
					return cloudMailboxUnavailableResponse();
				}
			}
			input.context.waitUntil(
				input.api
					.reconcileCloudWorkspaceStartup(command.workspaceId)
					.finally(() => input.api.dispose()),
			);
			return committed;
		}
		if (command.action === "status") {
			const commandId = commandIdentifier(body);
			if (!apiOwnedByPolicyReconcile) await input.api.dispose();
			return internal(
				`/status?commandId=${encodeURIComponent(commandId)}`,
				"GET",
			);
		}
		if (command.action === "watch") {
			const afterRevision = watchRevision(body);
			if (!apiOwnedByPolicyReconcile) await input.api.dispose();
			return internal(`/watch?afterRevision=${afterRevision}`, "GET");
		}
		if (command.action === "cancel") {
			await input.api.dispose();
			return internal("/cancel", "POST", body);
		}
		if (command.action === "ack") {
			await input.api.dispose();
			return internal("/ack", "POST", body);
		}
		if (command.action === "lease") {
			if (billing === undefined)
				throw new Error("cloud mailbox lease billing directive missing");
			const leaseResponse = await internal("/lease", "POST", body);
			if (leaseResponse.ok && command.wakeRevision !== undefined) {
				try {
					const leaseResult = (await leaseResponse.clone().json()) as {
						readonly nonterminalCount?: unknown;
						readonly mailboxRevision?: unknown;
						readonly fenceRequired?: unknown;
					};
					const mailboxRevision =
						typeof leaseResult.mailboxRevision === "number" &&
						Number.isSafeInteger(leaseResult.mailboxRevision) &&
						leaseResult.mailboxRevision >= 0
							? leaseResult.mailboxRevision
							: null;
					const nonterminalCount =
						typeof leaseResult.nonterminalCount === "number" &&
						Number.isSafeInteger(leaseResult.nonterminalCount) &&
						leaseResult.nonterminalCount >= 0
							? leaseResult.nonterminalCount
							: null;
					if (
						nonterminalCount !== null &&
						(nonterminalCount === 0 || mailboxRevision !== null)
					) {
						const fenceRequired = leaseResult.fenceRequired === true;
						apiOwnedByPolicyReconcile = true;
						input.context.waitUntil(
							mailboxBookkeepingWithDeadline(
								nonterminalCount === 0
									? input.api.completeCloudMailboxDrain(
											command.workspaceId,
											billing.accountId,
											command.runtimeGeneration,
											command.wakeRevision,
										)
									: input.api.recordCloudMailboxRuntimeProgress(
											command.workspaceId,
											billing.accountId,
											command.runtimeGeneration,
											command.wakeRevision,
											mailboxRevision ?? 0,
											fenceRequired,
										),
							)
								.then(() =>
									fenceRequired
										? input.api.reconcileCloudWorkspaceStartup(
												command.workspaceId,
											)
										: undefined,
								)
								.catch((error) => {
									console.error(
										"[workspace-mailbox] lease bookkeeping failed",
										{
											workspaceId: command.workspaceId,
											runtimeGeneration: command.runtimeGeneration,
											wakeRevision: command.wakeRevision,
											error,
										},
									);
								})
								.finally(() => input.api.dispose()),
						);
					}
				} catch (error) {
					console.error("[workspace-mailbox] lease metadata invalid", {
						workspaceId: command.workspaceId,
						runtimeGeneration: command.runtimeGeneration,
						wakeRevision: command.wakeRevision,
						error,
					});
				}
			}
			if (!apiOwnedByPolicyReconcile) await input.api.dispose();
			return leaseResponse;
		}
		return assertUnreachableCommand(command);
	} catch (error) {
		if (!apiOwnedByPolicyReconcile) await input.api.dispose();
		console.error("[workspace-mailbox] orchestration failed", {
			workspaceId: command.workspaceId,
			action: command.action,
			error,
		});
		return cloudMailboxUnavailableResponse();
	}
};
