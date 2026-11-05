import {
	AutomationError,
	type FolderId,
	type MachineErrorCode,
	type ProviderId,
	type RuntimeMode,
} from "@zuse/contracts";
import { GitService } from "@zuse/git/git-service";
import { Context, Effect, Layer } from "effect";
import {
	type MachineControlError,
	MachineControlService,
} from "../machine/machine-control-service.ts";
import { MachineRuntimeRole } from "../machine/machine-runtime-role.ts";

export interface AutomationCloudLaunchInput {
	readonly projectId: FolderId;
	readonly providerId: string;
	readonly fallback: boolean;
	readonly agent: ProviderId;
	readonly model: string;
	readonly runtimeMode: RuntimeMode;
	readonly prompt: string;
	/** Stable per run, so a retried launch never starts a second agent. */
	readonly idempotencyKey: string;
}

export interface AutomationCloudLaunch {
	readonly providerId: string;
	readonly workspaceId: string;
	readonly chatId: string;
	readonly sessionId: string;
}

export interface AutomationCloudLauncherShape {
	/** False in runtimes that cannot reach the cloud control plane. */
	readonly available: boolean;
	readonly launch: (
		input: AutomationCloudLaunchInput,
	) => Effect.Effect<AutomationCloudLaunch, AutomationError>;
}

export class AutomationCloudLauncher extends Context.Service<
	AutomationCloudLauncher,
	AutomationCloudLauncherShape
>()("zuse/AutomationCloudLauncher") {}

export interface LaunchAttemptFailure {
	/** Whether another provider might succeed where this one failed. */
	readonly providerSpecific: boolean;
	readonly reason: string;
}

/**
 * Try providers in order. Only provider-specific failures move on to the next
 * provider; account-wide failures (billing, entitlement, credentials) would
 * fail everywhere, so they stop immediately with their own reason.
 */
export const launchWithFallback = <A>(
	order: ReadonlyArray<string>,
	attempt: (providerId: string) => Effect.Effect<A, LaunchAttemptFailure>,
): Effect.Effect<A, AutomationError> =>
	Effect.gen(function* () {
		const reasons: string[] = [];
		for (const providerId of order) {
			const result = yield* attempt(providerId).pipe(Effect.result);
			if (result._tag === "Success") return result.success;
			reasons.push(result.failure.reason);
			if (!result.failure.providerSpecific) break;
		}
		return yield* new AutomationError({
			message: reasons.join(" ") || "No cloud provider is available.",
		});
	});

const failureReason = (code: MachineErrorCode, provider: string): string => {
	switch (code) {
		case "provider-unavailable":
			return `${provider} is unavailable right now.`;
		case "billing-hold":
		case "billing-unavailable":
			return "Cloud billing is on hold. Check your billing settings.";
		case "entitlement-required":
		case "beta-access-required":
		case "beta-access-unavailable":
			return "Your account doesn’t have access to cloud agents.";
		case "credential-required":
			return "Connect this agent in Cloud settings before running it in the cloud.";
		case "machine-limit-reached":
			return "You’ve reached your cloud machine limit.";
		case "access-denied":
		case "not-allowed":
			return "Sign in to Zuse to run automations in the cloud.";
		default:
			return `${provider} couldn’t start the cloud agent (${code}).`;
	}
};

const describeControlError = (error: MachineControlError): AutomationError =>
	new AutomationError({ message: failureReason(error.code, "Cloud") });

export const AutomationCloudLauncherLive = Layer.effect(
	AutomationCloudLauncher,
	Effect.gen(function* () {
		const role = yield* MachineRuntimeRole;
		const control = yield* MachineControlService;
		const git = yield* GitService;
		const available = role === "control-plane";
		return AutomationCloudLauncher.of({
			available,
			launch: Effect.fn("automation.cloudLaunch")(function* (input) {
				if (!available)
					return yield* new AutomationError({
						message:
							"Cloud machines can only be chosen from Zuse on your computer.",
					});
				const origin = yield* git
					.origin(input.projectId)
					.pipe(Effect.orElseSucceed(() => null));
				if (!origin)
					return yield* new AutomationError({
						message:
							"This project has no Git origin, so it can’t run on a cloud machine.",
					});
				const identity =
					`${origin.host}/${origin.owner}/${origin.repo}`.toLowerCase();
				const [projects, providers] = yield* Effect.all([
					control.cloudProjects(),
					control.cloudProviders(),
				]).pipe(Effect.mapError(describeControlError));
				const project = projects.projects.find(
					(candidate) =>
						candidate.repositoryIdentity.toLowerCase() === identity,
				);
				if (!project)
					return yield* new AutomationError({
						message:
							"Connect this repository in Cloud settings before running it on a cloud machine.",
					});
				const name = (providerId: string) =>
					providers.providers.find((option) => option.providerId === providerId)
						?.displayName ?? providerId;
				const order = input.fallback
					? [
							input.providerId,
							...providers.providers
								.map((option) => option.providerId)
								.filter((providerId) => providerId !== input.providerId),
						]
					: [input.providerId];
				return yield* launchWithFallback(order, (providerId) =>
					control
						.createCloudWorkspace({
							projectId: project.projectId,
							providerId,
							baseRef: project.defaultBranch,
							agent: input.agent,
							model: input.model,
							runtimeMode: input.runtimeMode,
							firstMessage: input.prompt,
							idempotencyKey: `${input.idempotencyKey}:${providerId}`,
						})
						.pipe(
							Effect.map(
								(launch): AutomationCloudLaunch => ({
									providerId,
									workspaceId: launch.workspace.workspaceId,
									chatId: launch.chatId,
									sessionId: launch.initialSessionId,
								}),
							),
							Effect.mapError(
								(error): LaunchAttemptFailure => ({
									providerSpecific: error.code === "provider-unavailable",
									reason: failureReason(error.code, name(providerId)),
								}),
							),
						),
				);
			}),
		});
	}),
);
