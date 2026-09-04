import { summaryFromLaunch } from "@zuse/client-runtime/cloud-catalog";
import {
	type CloudProject,
	MessageId,
	type ProviderId,
	type RuntimeMode,
} from "@zuse/contracts";
import { Effect } from "effect";
import { makeTextInput, sendCloudMessage } from "~/rpc/actions";
import { cloudControlClient } from "~/rpc/api-client";
import {
	cloudCatalogAtom,
	cloudConnectionKey,
	registerCloudSummary,
} from "./cloud-catalog";
import {
	clearComposerDraft,
	composerDraft,
	persistComposerDraft,
} from "./composer-drafts";
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
	const assertAccount = () => {
		if (appAtomRegistry.get(cloudCatalogAtom).accountId !== input.accountId)
			throw new Error("Sign in to this account before sending.");
	};
	assertAccount();
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
	const encoded = JSON.stringify(request);
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
			clientMessageId: MessageId.make(intent.messageId),
		});
		void handle.result.catch(() => undefined);
		await handle.accepted;
	}
	assertAccount();
	clearComposerDraft(input.draftKey);
	return { connectionKey: key, sessionId: launch.initialSessionId };
};
