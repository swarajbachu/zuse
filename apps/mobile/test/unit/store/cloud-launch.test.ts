import { CloudProject } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ComposerDraft } from "../../../src/store/composer-drafts";
import { workspace } from "../../fixtures/cloud";

const state = vi.hoisted(() => ({
	draft: { text: "", attachments: [], goalMode: false } as ComposerDraft,
	create: vi.fn(),
	send: vi.fn(),
	saved: vi.fn(),
	clear: vi.fn(),
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClient: {
		"cloud.workspaces.create": (input: unknown) =>
			Effect.tryPromise({
				try: () => state.create(input),
				catch: (cause) => cause,
			}),
	},
}));
vi.mock("~/rpc/actions", () => ({
	makeTextInput: (text: string) => ({ text }),
	sendCloudMessage: (input: unknown) => state.send(input),
}));
vi.mock("~/store/composer-drafts", () => ({
	composerDraft: () => state.draft,
	persistComposerDraft: async (_key: string, value: ComposerDraft) => {
		state.draft = structuredClone(value);
		state.saved();
	},
	clearComposerDraft: () => state.clear(),
}));

import { setCloudCatalogAccount } from "../../../src/store/cloud-catalog";
import { launchMobileCloudChat } from "../../../src/store/cloud-launch";

const input = {
	accountId: "account-1",
	draftKey: "new-cloud:account-1",
	providerId: "e2b",
	agent: "codex" as const,
	model: "gpt-5.5",
	runtimeMode: "full-access" as const,
	text: "Fix the tests",
	project: CloudProject.make({
		projectId: "project-1",
		repositoryIdentity: "github.com/example/repo",
		repositoryUrl: "https://github.com/example/repo",
		displayName: "example/repo",
		defaultBranch: "main",
		visibility: "private",
		state: "ready",
		activeBuilds: {},
		latestBuilds: {},
		createdAt: 1,
		updatedAt: 1,
	}),
};
const launch = () => {
	const row = workspace();
	return {
		workspace: row,
		initialSessionId: row.initialSessionId,
		chatId: row.chatId,
		initialMessageDelivery: "mailbox-v1",
	};
};
describe("mobile initial cloud launch intent", () => {
	beforeEach(() => {
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-1");
		state.draft = { text: "", attachments: [], goalMode: false };
		state.saved.mockReset();
		state.clear.mockReset();
		state.create.mockReset().mockImplementation(async () => {
			expect(state.saved).toHaveBeenCalled();
			return launch();
		});
		state.send.mockReset().mockReturnValue({
			accepted: Promise.resolve(),
			result: new Promise(() => undefined),
		});
	});
	test("persists identity before creating compute and clears only after durable acceptance", async () => {
		let accepted!: () => void;
		state.send.mockReturnValue({
			accepted: new Promise<void>((resolve) => {
				accepted = resolve;
			}),
			result: new Promise(() => undefined),
		});
		const request = launchMobileCloudChat(input);
		await vi.waitFor(() => expect(state.send).toHaveBeenCalled());
		expect(state.clear).not.toHaveBeenCalled();
		accepted();
		expect(await request).toEqual({
			connectionKey: "cloud:workspace-1",
			sessionId: "session-1",
		});
		expect(state.clear).toHaveBeenCalledTimes(1);
		expect(state.create.mock.calls[0]?.[0]).toMatchObject({
			runtimeMode: "full-access",
			initialMessageDelivery: "mailbox-v1",
		});
	});
	test("lost create response reuses both workspace and first-message identity", async () => {
		state.create.mockRejectedValueOnce(new Error("response lost after insert"));
		await expect(launchMobileCloudChat(input)).rejects.toThrow("response lost");
		const first = state.draft.cloudLaunch;
		await launchMobileCloudChat(input);
		expect(state.create.mock.calls[0]?.[0]).toEqual(
			state.create.mock.calls[1]?.[0],
		);
		expect(state.send.mock.calls[0]?.[0]).toMatchObject({
			clientMessageId: first?.messageId,
		});
	});
	test("account switch during provisioning cannot send or clear the old account's draft", async () => {
		state.create.mockImplementation(async () => {
			setCloudCatalogAccount("account-2");
			return launch();
		});
		await expect(launchMobileCloudChat(input)).rejects.toThrow(
			"Sign in to this account",
		);
		expect(state.send).not.toHaveBeenCalled();
		expect(state.clear).not.toHaveBeenCalled();
	});
});
