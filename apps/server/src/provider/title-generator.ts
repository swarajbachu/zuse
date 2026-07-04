import { Context, Effect, Layer, Option, Stream } from "effect";
import * as os from "node:os";

import {
  AgentSessionId,
  type BranchNamingStyle,
  type FolderId,
  type ProviderId,
  type RuntimeMode,
} from "@zuse/wire";

import { ProviderService } from "./services/provider-service.ts";

/** Hard ceiling on the one-shot turn; on timeout we fall back to truncation. */
const TITLE_TIMEOUT_MS = 25_000;

const PROMPT_PREFIX = [
  "Summarize the following coding task as a SHORT title of 3 to 5 words in Title Case.",
  "Reply with ONLY the title — no quotes, no punctuation, no preamble, no explanation.",
  "Do NOT use any tools, do NOT read or write files, do NOT run commands. Just output the title text.",
  "",
  "Task:",
  "",
].join("\n");

/* ──────────────────────────── pure helpers ──────────────────────────── */

/**
 * First-line truncation fallback — identical in spirit to the message-store
 * helper of the same shape. Used whenever the model call is unavailable
 * (offline, provider not installed) or returns nothing usable, so a chat is
 * never left on its "New chat" placeholder.
 */
export const fallbackTitle = (firstMessage: string): string => {
  const firstLine = firstMessage.trim().split("\n")[0] ?? "";
  const truncated = firstLine.slice(0, 60).trim();
  return truncated.length > 0 ? truncated : "New chat";
};

/** Strip the model's stray quoting / punctuation and clamp to one tidy line. */
const cleanTitle = (raw: string): string => {
  const firstLine = raw.trim().split("\n")[0] ?? "";
  return firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
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
  /** The user's first message. */
  readonly firstMessage: string;
}

export interface TitleGeneratorShape {
  /**
   * Summarize a chat's first message into a short title by running a single,
   * throwaway turn through the chat's OWN provider (so it reuses whatever
   * auth that provider has). Never fails: any error / timeout / empty
   * response collapses to the first-line truncation fallback.
   */
  readonly generate: (input: GenerateTitleInput) => Effect.Effect<string>;
}

export class TitleGenerator extends Context.Tag("memoize/TitleGenerator")<
  TitleGenerator,
  TitleGeneratorShape
>() {}

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

    const generate: TitleGeneratorShape["generate"] = (input) =>
      Effect.gen(function* () {
        const fallback = fallbackTitle(input.firstMessage);
        const sid = AgentSessionId.make(`title-${crypto.randomUUID()}`);
        const prompt = `${PROMPT_PREFIX}${input.firstMessage.slice(0, 2000)}`;

        const text = yield* Effect.gen(function* () {
          yield* provider.start(
            {
              folderId: input.folderId,
              providerId: input.providerId,
              mode: "sdk",
              sessionId: sid,
              initialPrompt: prompt,
              model: input.model,
              cwdOverride: scratchCwd,
              permissionMode: "default",
            },
            null,
            () => runtimeMode,
          );
          // First non-empty assistant chunk is the title; we don't need the
          // rest of the turn.
          const head = yield* provider.events(sid).pipe(
            Stream.filterMap((event) =>
              event._tag === "AssistantMessage" &&
              event.text.trim().length > 0
                ? Option.some(event.text)
                : Option.none(),
            ),
            Stream.take(1),
            Stream.runHead,
          );
          return Option.getOrElse(head, () => "");
        }).pipe(
          // Always tear the throwaway session down — on success, timeout, or
          // failure — so we never leak a CLI/SDK process.
          Effect.ensuring(
            provider.close(sid).pipe(Effect.catchAll(() => Effect.void)),
          ),
          Effect.timeoutOption(`${TITLE_TIMEOUT_MS} millis`),
          Effect.map((maybe) => Option.getOrElse(maybe, () => "")),
          Effect.catchAll(() => Effect.succeed("")),
        );

        const cleaned = cleanTitle(text);
        return cleaned.length > 0 ? cleaned : fallback;
      });

    return { generate } satisfies TitleGeneratorShape;
  }),
);
