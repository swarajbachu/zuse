import type {
	AgentEvent,
	AgentItemId,
	FolderId,
	ProviderId,
} from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { HiddenAgentRunner } from "../../src/provider/hidden-agent-run.ts";
import {
	buildNamingPrompt,
	cleanTitle,
	fallbackTitle,
	limitNamingMessage,
	MAX_GENERATED_TITLE_LENGTH,
	parseNamingReply,
	TitleGenerator,
	TitleGeneratorLive,
} from "../../src/provider/title-generator.ts";

describe("generated title length", () => {
	it.each([
		["model title", (text: string) => cleanTitle(text)],
		["fallback title", (text: string) => fallbackTitle(text)],
	])("caps a %s at 60 characters", (_label, makeTitle) => {
		const title = makeTitle("A".repeat(100));
		expect(title).toHaveLength(MAX_GENERATED_TITLE_LENGTH);
		expect(title).toBe("A".repeat(60));
	});

	it("cuts long titles at a word boundary", () => {
		const request =
			"Please look into why the cloud terminal keeps disconnecting after the laptop sleeps";
		const title = fallbackTitle(request);
		expect(title.length).toBeLessThanOrEqual(MAX_GENERATED_TITLE_LENGTH);
		expect(request.startsWith(`${title} `)).toBe(true);
	});
});

describe("fallbackTitle", () => {
	it("skips links, mentions, and markdown to find a readable subject", () => {
		expect(
			fallbackTitle(
				"https://github.com/o/r/pull/1\n## **Fix** @src/a.ts login flow.",
			),
		).toBe("Fix login flow");
	});

	it("keeps the placeholder when nothing readable remains", () => {
		expect(fallbackTitle("https://example.com")).toBe("New chat");
	});
});

describe("cleanTitle", () => {
	it("strips labels, quotes, markdown, and trailing punctuation", () => {
		expect(cleanTitle('\n**Title:** "Fix Cloud Terminal Reconnect."')).toBe(
			"Fix Cloud Terminal Reconnect",
		);
	});
});

describe("parseNamingReply", () => {
	it("reads JSON wrapped in prose or a code fence", () => {
		expect(
			parseNamingReply(
				'Sure!\n```json\n{"title": "Redesign Setup Card", "branch": "redesign-setup-card"}\n```',
			),
		).toEqual({ title: "Redesign Setup Card", branch: "redesign-setup-card" });
	});

	it("never names from a plain-text reply such as a provider error", () => {
		expect(parseNamingReply("Limit reached")).toEqual({
			title: "",
			branch: "",
		});
	});

	it("does not title a chat after malformed JSON", () => {
		expect(parseNamingReply('{"title": ')).toEqual({ title: "", branch: "" });
	});
});

describe("buildNamingPrompt", () => {
	it("asks only for the names that are still pending", () => {
		const titleOnly = buildNamingPrompt("Fix login", {
			title: true,
			branch: false,
		});
		expect(titleOnly).toContain('keys "title".');
		expect(titleOnly).not.toContain("Branch rules");

		const both = buildNamingPrompt("Fix login", { title: true, branch: true });
		expect(both).toContain('keys "title" and "branch"');
		expect(both).toContain("<message>\nFix login\n</message>");
	});

	it("keeps the head and tail of very long requests", () => {
		const limited = limitNamingMessage(`start ${"x".repeat(10_000)} end`, 100);
		expect(limited.startsWith("start")).toBe(true);
		expect(limited.endsWith("end")).toBe(true);
		expect(limited).toContain("[Content truncated]");
	});
});

describe("TitleGeneratorLive", () => {
	const generateFrom = (
		events: ReadonlyArray<AgentEvent>,
		fallback = false,
	) => {
		const runner = {
			run: (_input: unknown, consume: (events: never) => never) =>
				consume(Stream.fromIterable(events) as never),
		};
		return Effect.runPromise(
			Effect.gen(function* () {
				const titles = yield* TitleGenerator;
				return yield* titles.generate({
					folderId: "folder" as FolderId,
					providerId: "claude" as ProviderId,
					model: "claude-opus-5-5",
					userText: "for some reason the app is not updating, fix it",
					title: true,
					branch: true,
					fallback,
				});
			}).pipe(
				Effect.provide(
					TitleGeneratorLive.pipe(
						Layer.provide(Layer.succeed(HiddenAgentRunner, runner as never)),
					),
				),
			),
		);
	};

	it("names the chat from the finished reply, not its first streamed fragment", async () => {
		const reply =
			'{"title": "Fix App Update Check", "branch": "fix-app-update"}';
		const itemId = "msg:text:0" as AgentItemId;
		const names = await generateFrom([
			{
				_tag: "AssistantMessage",
				itemId,
				text: reply.slice(0, 4),
				checkpoint: { revision: 1, final: false },
			},
			{
				_tag: "AssistantMessage",
				itemId,
				text: reply.slice(0, 30),
				checkpoint: { revision: 2, final: false },
			},
			{
				_tag: "AssistantMessage",
				itemId,
				text: reply,
				checkpoint: { revision: 3, final: true },
			},
		]);
		expect(names).toEqual({
			title: "Fix App Update Check",
			branch: "fix-app-update",
		});
	});

	it("reads a reply that arrives as one unstreamed message", async () => {
		const names = await generateFrom([
			{
				_tag: "AssistantMessage",
				itemId: "msg" as AgentItemId,
				text: '{"title": "Fix App Update Check", "branch": "fix-app-update"}',
			},
		]);
		expect(names.title).toBe("Fix App Update Check");
	});

	it("leaves names unset when a failing provider answers in plain text", async () => {
		const reply: ReadonlyArray<AgentEvent> = [
			{
				_tag: "AssistantMessage",
				itemId: "msg" as AgentItemId,
				text: "Limit reached",
			},
		];
		expect(await generateFrom(reply)).toEqual({ title: null, branch: null });
		expect(await generateFrom(reply, true)).toEqual({
			title: "for some reason the app is not updating, fix it",
			branch: "for-some-reason-the-app-is-not-updating",
		});
	});
});
