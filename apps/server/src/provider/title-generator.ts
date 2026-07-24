import * as os from "node:os";
import {
	AgentSessionId,
	AgentTurnId,
	type BranchNamingStyle,
	type FolderId,
	type ProviderId,
	type RuntimeMode,
} from "@zuse/contracts";
import { Context, Effect, Layer, Option, Result, Stream } from "effect";

import { ProviderService } from "./services/provider-service.ts";

/** Hard ceiling on the one-shot turn; on timeout we fall back to truncation. */
const TITLE_TIMEOUT_MS = 25_000;
export const MAX_GENERATED_TITLE_LENGTH = 60;

const PROMPT_PREFIX = [
	"Summarize the following conversation as a SHORT title of 3 to 5 words in Title Case.",
	"Reply with ONLY the title — no quotes, no punctuation, no preamble, no explanation.",
	"Do NOT use any tools, do NOT read or write files, do NOT run commands. Just output the title text.",
	"",
	"Conversation:",
	"",
].join("\n");

const BRANCH_PROMPT_PREFIX = [
	"Generate a concise semantic git branch name for the following task.",
	"Reply with ONLY 2 to 5 lowercase words separated by hyphens.",
	"Do NOT include a username or category prefix. Do NOT use tools.",
	"",
	"Task:",
	"",
].join("\n");

/** Render user/assistant turns into the throwaway title prompt body. */
export const buildConversationText = (
	turns: ReadonlyArray<{
		readonly role: "user" | "assistant";
		readonly text: string;
	}>,
): string =>
	turns
		.map((turn) => {
			const label = turn.role === "user" ? "User" : "Assistant";
			const text = turn.text.trim();
			if (text.length === 0) return null;
			return `${label}: ${text}`;
		})
		.filter((line): line is string => line !== null)
		.join("\n\n")
		.slice(0, 4000);

/* ──────────────────────────── pure helpers ──────────────────────────── */

/**
 * First-line truncation fallback — identical in spirit to the conversation-services
 * helper of the same shape. Used whenever the model call is unavailable
 * (offline, provider not installed) or returns nothing usable, so a chat is
 * never left on its "New chat" placeholder.
 */
export const fallbackTitle = (firstMessage: string): string => {
	const firstLine = firstMessage.trim().split("\n")[0] ?? "";
	const truncated = firstLine.slice(0, MAX_GENERATED_TITLE_LENGTH).trim();
	return truncated.length > 0 ? truncated : "New chat";
};

/** Strip the model's stray quoting / punctuation and clamp to one tidy line. */
export const cleanTitle = (raw: string): string => {
	const firstLine = raw.trim().split("\n")[0] ?? "";
	return firstLine
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.!,;:]+$/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_GENERATED_TITLE_LENGTH)
		.trim();
};

/**
 * Lowercase kebab slug safe for a git ref segment: only `[a-z0-9-]`, no
 * leading/trailing/triple dashes, length-capped. Empty input yields
 * `"session"` so we never produce an invalid (empty) ref.
 */
export const slugify = (text: string): string => {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40)
		.replace(/-$/g, "");
	return slug.length > 0 ? slug : "session";
};

/**
 * Collapse a git `user.name` into a branch-prefix handle: lowercase, all
 * non-alphanumerics dropped (not dashed) so `"Swaraj Bachu"` becomes
 * `swarajbachu` — matching the GitHub-style `username/branch` convention.
 * Empty when nothing usable remains.
 */
export const usernameHandle = (username: string): string =>
	username.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Normalize a user-supplied branch prefix into a valid, slash-delimited ref
 * fragment: lowercase, keep `[a-z0-9/_-]`, collapse repeats, trim stray
 * leading/trailing separators. Empty when nothing usable remains.
 */
export const sanitizePrefix = (prefix: string): string =>
	prefix
		.toLowerCase()
		.replace(/[^a-z0-9/_-]+/g, "-")
		.replace(/\/{2,}/g, "/")
		.replace(/-+/g, "-")
		.replace(/^[-/]+|[-/]+$/g, "")
		.slice(0, 40)
		.replace(/[-/]+$/g, "");

/**
 * Build the new branch name from an LLM title, the (raw) git user name, the
 * chosen style, and (for `custom`) a user-defined prefix. `username-slug` and
 * `custom` gracefully degrade to a bare slug when their prefix is empty,
 * rather than emitting a leading slash.
 */
export const formatBranchName = (
	title: string,
	username: string,
	style: BranchNamingStyle,
	customPrefix: string,
): string => {
	const slug = slugify(title);
	switch (style) {
		case "slug":
			return slug;
		case "feat-slug":
			return `feat/${slug}`;
		case "username-slug": {
			const handle = usernameHandle(username);
			return handle.length === 0 ? slug : `${handle}/${slug}`;
		}
		case "custom": {
			const prefix = sanitizePrefix(customPrefix);
			return prefix.length === 0 ? slug : `${prefix}/${slug}`;
		}
	}
};

/* ───────────────────────────── service ──────────────────────────────── */

export interface GenerateTitleInput {
	/** Project the chat belongs to (resolves provider auth + default cwd). */
	readonly folderId: FolderId;
	/** The chat's chosen provider — the title runs on THIS agent, never a
	 *  hardcoded one, so a Grok/Codex-only user uses their own auth. */
	readonly providerId: ProviderId;
	/** The chat's chosen model. */
	readonly model: string;
	/** Recent user/assistant turns to summarize. */
	readonly conversationText: string;
	/** Deterministic source used only when the auxiliary naming turn fails. */
	readonly fallbackText?: string;
}

export interface GenerateBranchInput {
	readonly folderId: FolderId;
	readonly providerId: ProviderId;
	readonly model: string;
	readonly userText: string;
}

export interface TitleGeneratorShape {
	/**
	 * Summarize a chat's first message into a short title by running a single,
	 * throwaway turn through the chat's OWN provider (so it reuses whatever
	 * auth that provider has). Never fails: any error / timeout / empty
	 * response collapses to the first-line truncation fallback.
	 */
	readonly generate: (input: GenerateTitleInput) => Effect.Effect<string>;
	readonly generateBranch: (
		input: GenerateBranchInput,
	) => Effect.Effect<string>;
}

export class TitleGenerator extends Context.Service<
	TitleGenerator,
	TitleGeneratorShape
>()("memoize/TitleGenerator") {}

export const TitleGeneratorLive = Layer.effect(
	TitleGenerator,
	Effect.gen(function* () {
		const provider = yield* ProviderService;
		// Run the throwaway session in a scratch dir, not the worktree: the title
		// only needs the message text (it's in the prompt), so an empty cwd means
		// the agent can't read/edit the repo even if it ignores the no-tools
		// instruction. Paired with a full-access runtime mode below so the turn
		// never raises a permission toast the user would see for a hidden session.
		const scratchCwd = os.tmpdir();
		const runtimeMode: RuntimeMode = "full-access";

		const generateText = (
			input: Pick<GenerateTitleInput, "folderId" | "providerId" | "model">,
			prompt: string,
		) =>
			Effect.gen(function* () {
				const sid = AgentSessionId.make(`title-${crypto.randomUUID()}`);
				const turnId = AgentTurnId.make(`title-turn-${crypto.randomUUID()}`);
				const text = yield* Effect.gen(function* () {
					yield* provider.start(
						{
							folderId: input.folderId,
							providerId: input.providerId,
							mode: "sdk",
							sessionId: sid,
							initialPrompt: prompt,
							initialTurnId: turnId,
							model: input.model,
							cwdOverride: scratchCwd,
							permissionMode: "default",
						},
						null,
						() => runtimeMode,
					);
					const head = yield* provider.events(sid).pipe(
						Stream.filterMap((envelope) =>
							envelope.scope === "turn" &&
							envelope.turnId === turnId &&
							envelope.event._tag === "AssistantMessage" &&
							envelope.event.text.trim().length > 0
								? Result.succeed(envelope.event.text)
								: Result.fail(undefined),
						),
						Stream.take(1),
						Stream.runHead,
					);
					return Option.getOrElse(head, () => "");
				}).pipe(
					Effect.ensuring(
						provider.close(sid).pipe(Effect.catch(() => Effect.void)),
					),
					Effect.timeoutOption(`${TITLE_TIMEOUT_MS} millis`),
					Effect.map((maybe) => Option.getOrElse(maybe, () => "")),
					Effect.catch(() => Effect.succeed("")),
				);
				return cleanTitle(text);
			});

		const generate: TitleGeneratorShape["generate"] = (input) =>
			generateText(
				input,
				`${PROMPT_PREFIX}${input.conversationText.slice(0, 4000)}`,
			).pipe(
				Effect.map((cleaned) =>
					cleaned.length > 0
						? cleaned
						: fallbackTitle(input.fallbackText ?? input.conversationText),
				),
			);

		const generateBranch: TitleGeneratorShape["generateBranch"] = (input) =>
			generateText(
				input,
				`${BRANCH_PROMPT_PREFIX}${input.userText.slice(0, 2000)}`,
			).pipe(
				Effect.map((cleaned) =>
					slugify(cleaned.length > 0 ? cleaned : input.userText),
				),
			);

		return { generate, generateBranch } satisfies TitleGeneratorShape;
	}),
);
