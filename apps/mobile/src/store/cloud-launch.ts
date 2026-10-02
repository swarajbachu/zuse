import { summaryFromLaunch } from "@zuse/client-runtime/cloud-catalog";
import {
	type CloudProject,
	Message,
	MessageId,
	type ProviderId,
	type RuntimeMode,
} from "@zuse/contracts";
import { Effect } from "effect";
import { connectionSessionKey } from "~/lib/session-key";
import { makeTextInput, sendCloudMessage } from "~/rpc/actions";
import { cloudControlClientForWorkspace } from "~/rpc/api-client";
import {
	cloudCatalogAtom,
	cloudCatalogGeneration,
	cloudConnectionKey,
	registerCloudSummary,
} from "./cloud-catalog";
import {
	clearComposerDraft,
	composerDraft,
	persistComposerDraft,
} from "./composer-drafts";
import { addOptimisticMessage } from "./messages";
import { appAtomRegistry } from "./registry";

export const launchMobileCloudChat = async (input: {
	accountId: string;
	draftKey: string;
	project: CloudProject;
	providerId: string;
	agent: ProviderId;
	model: string;
	runtimeMode: RuntimeMode;
	text: string;
}) => {
	const generation = cloudCatalogGeneration();
	const scope = appAtomRegistry.get(cloudCatalogAtom).scope;
	const assertAccount = () => {
		if (
			appAtomRegistry.get(cloudCatalogAtom).accountId !== input.accountId ||
			cloudCatalogGeneration() !== generation
		)
			throw new Error("Sign in to this account before sending.");
	};
	assertAccount();
	const cloudControlClient = cloudControlClientForWorkspace(scope);
	const request = {
		projectId: input.project.projectId,
		providerId: input.providerId,
		baseRef: `origin/${input.project.defaultBranch}`,
		agent: input.agent,
		model: input.model,
		runtimeMode: input.runtimeMode,
		firstMessage: input.text,
		initialMessageDelivery: "mailbox-v1" as const,
	};
	const encoded = JSON.stringify(
		scope.kind === "personal" ? request : { scope, request },
	);
	const draft = composerDraft(input.draftKey);
	const intent =
		draft.cloudLaunch?.request === encoded
			? draft.cloudLaunch
			: {
					idempotencyKey: crypto.randomUUID(),
					messageId: crypto.randomUUID(),
					request: encoded,
				};
	await persistComposerDraft(input.draftKey, {
		text: input.text,
		attachments: [],
		goalMode: false,
		cloudLaunch: intent,
	});
	assertAccount();
	const launch = await Effect.runPromise(
		cloudControlClient["cloud.workspaces.create"]({
			...request,
			idempotencyKey: intent.idempotencyKey,
		}),
	);
	assertAccount();
	const summary = summaryFromLaunch({
		workspaceScope: scope,
		workspace: launch.workspace,
		repositoryIdentity: input.project.repositoryIdentity,
		repositoryDisplayName: input.project.displayName,
		title: input.text.trim().split(/\r?\n/u)[0]?.slice(0, 80) || "New chat",
		agent: input.agent,
		model: input.model,
		runtimeMode: input.runtimeMode,
	});
	registerCloudSummary(summary);
	const key = cloudConnectionKey(summary.workspaceId);
	if (launch.initialMessageDelivery === "mailbox-v1") {
		const messageId = MessageId.make(intent.messageId);
		// Like desktop, open the chat as soon as the workspace exists: show the
		// prompt now and let the durable outbox deliver it while the sandbox
		// boots. The draft (with its idempotent launch intent) is cleared only
		// once the mailbox accepts, so a killed app can still recover it.
		addOptimisticMessage(
			connectionSessionKey(key, launch.initialSessionId),
			Message.make({
				id: messageId,
				sessionId: launch.initialSessionId,
				role: "user",
				content: { _tag: "user", text: input.text, goal: false },
				createdAt: new Date(),
			}),
		);
		const handle = sendCloudMessage({
			connection: {
				key,
				environmentId: summary.workspaceId,
				cloudWorkspaceId: summary.workspaceId,
				host: "",
				port: 443,
			},
			sessionId: launch.initialSessionId,
			input: makeTextInput(input.text),
			clientMessageId: messageId,
		});
		void handle.result.catch(() => undefined);
		void handle.accepted
			.then(() => {
				if (appAtomRegistry.get(cloudCatalogAtom).accountId === input.accountId)
					clearComposerDraft(input.draftKey);
			})
			.catch(() => undefined);
	} else {
		clearComposerDraft(input.draftKey);
	}
	return { connectionKey: key, sessionId: launch.initialSessionId };
};
