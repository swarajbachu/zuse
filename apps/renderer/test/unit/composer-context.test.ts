import { ComposerInput, EnvironmentId, SessionId } from "@zuse/contracts";
import { beforeEach, expect, test } from "vitest";
import {
	commitAcceptedComposerDelivery,
	withComposerContext,
} from "../../src/lib/composer-delivery.ts";
import {
	composerDraftKeyForSession,
	useComposerDraftsStore,
} from "../../src/store/composer-drafts.ts";

const key = (env: string) =>
	composerDraftKeyForSession({
		environmentId: EnvironmentId.make(env),
		sessionId: SessionId.make("chat"),
	});
const context = {
	sourceKey: "pr:1:comments",
	label: "PR #1 · Comments",
	text: "Repair comments\nFull feedback with file and line",
};
beforeEach(() =>
	useComposerDraftsStore.setState({ draftsByKey: {}, contextsByKey: {} }),
);
test("stages context separately, preserves extra instructions, and isolates environments", () => {
	const store = useComposerDraftsStore.getState();
	store.save(key("local"), { doc: "Also update the tests", chips: [] });
	store.addContext(key("local"), context);
	const state = useComposerDraftsStore.getState();
	expect(state.draftsByKey[key("local")]?.doc).toBe("Also update the tests");
	expect(state.contextsByKey[key("cloud")]).toBeUndefined();
	const input = ComposerInput.make({
		text: "Also update the tests",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
	});
	expect(
		withComposerContext(input, state.contextsByKey[key("local")] ?? []).text,
	).toBe("Also update the tests");
	expect(
		withComposerContext(input, state.contextsByKey[key("local")] ?? [])
			.annotations,
	).toContainEqual(
		expect.objectContaining({
			_tag: "context",
			label: context.label,
			comment: context.text,
		}),
	);
	expect(input.text).toBe("Also update the tests");
});
test("repeated clicks replace the staged scope and failed sends retain it", async () => {
	const store = useComposerDraftsStore.getState();
	store.addContext(key("local"), context);
	const submitted =
		useComposerDraftsStore.getState().contextsByKey[key("local")] ?? [];
	const commit = () =>
		store.removeContexts(
			key("local"),
			submitted.map((item) => item.id),
		);
	await commitAcceptedComposerDelivery(Promise.resolve(false), commit);
	expect(
		useComposerDraftsStore.getState().contextsByKey[key("local")],
	).toHaveLength(1);
	store.addContext(key("local"), { ...context, text: "Updated comments" });
	await commitAcceptedComposerDelivery(Promise.resolve(true), commit);
	const current =
		useComposerDraftsStore.getState().contextsByKey[key("local")] ?? [];
	expect(current).toHaveLength(1);
	expect(current[0]?.text).toBe("Updated comments");
	store.removeContexts(
		key("local"),
		current.map((item) => item.id),
	);
	expect(
		useComposerDraftsStore.getState().contextsByKey[key("local")],
	).toBeUndefined();
});
