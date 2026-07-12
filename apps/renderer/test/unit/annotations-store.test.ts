import type { SessionId } from "@zuse/contracts";
import { beforeEach, describe, expect, it } from "vitest";

type StorageLike = {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
	clear: () => void;
};

const makeStorage = (): StorageLike => {
	const entries = new Map<string, string>();
	return {
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => entries.set(key, value),
		removeItem: (key) => entries.delete(key),
		clear: () => entries.clear(),
	};
};

const localStorage = makeStorage();

Object.defineProperty(globalThis, "window", {
	value: { localStorage },
	configurable: true,
});

const { annotationsForSession, useAnnotationsStore } = await import(
	"../../src/store/annotations.ts"
);

const sessionId = "sess1" as SessionId;
const otherSessionId = "sess2" as SessionId;

describe("annotations store", () => {
	beforeEach(() => {
		localStorage.clear();
		useAnnotationsStore.setState({ bySession: {} });
	});

	it("adds annotations by session and returns a generated id", () => {
		const id = useAnnotationsStore.getState().add(sessionId, {
			relPath: "src/app.ts",
			absPath: "/repo/src/app.ts",
			startLine: 3,
			endLine: 5,
			comment: "tighten this branch",
		});

		expect(typeof id).toBe("string");
		expect(annotationsForSession(sessionId)).toEqual([
			{
				id,
				relPath: "src/app.ts",
				absPath: "/repo/src/app.ts",
				startLine: 3,
				endLine: 5,
				comment: "tighten this branch",
			},
		]);
		expect(annotationsForSession(otherSessionId)).toEqual([]);
	});

	it("removes and clears annotations", () => {
		const first = useAnnotationsStore.getState().add(sessionId, {
			relPath: "a.ts",
			absPath: "/repo/a.ts",
			startLine: 1,
			endLine: 1,
			comment: "one",
		});
		useAnnotationsStore.getState().add(sessionId, {
			relPath: "b.ts",
			absPath: "/repo/b.ts",
			startLine: 2,
			endLine: 4,
			comment: "two",
		});

		useAnnotationsStore.getState().remove(sessionId, first);
		expect(annotationsForSession(sessionId).map((a) => a.comment)).toEqual([
			"two",
		]);

		useAnnotationsStore.getState().clear(sessionId);
		expect(annotationsForSession(sessionId)).toEqual([]);
	});

	it("edits annotation comments before send", () => {
		const id = useAnnotationsStore.getState().add(sessionId, {
			relPath: "src/app.ts",
			absPath: "/repo/src/app.ts",
			startLine: 3,
			endLine: 5,
			comment: "initial note",
		});

		useAnnotationsStore
			.getState()
			.updateComment(sessionId, id, "  refined instruction  ");

		expect(annotationsForSession(sessionId)).toMatchObject([
			{
				id,
				comment: "refined instruction",
			},
		]);
	});

	it("adds browser annotations by session", () => {
		const annotation = useAnnotationsStore.getState().addBrowser(sessionId, {
			comment: "this can be improved",
			pageUrl: "https://example.com/",
			pageTitle: "Example Domain",
			elements: [
				{
					tagName: "p",
					selector: "p",
					label: "p",
					rect: { x: 1, y: 2, width: 300, height: 40 },
					textPreview: "This domain is for use in documentation examples",
				},
			],
			regions: [],
			strokes: [],
			screenshotAttachment: {
				id: "shot-1",
				mimeType: "image/png",
				originalName: "browser-annotation.png",
			},
		});

		expect(annotation._tag).toBe("browser");
		expect(annotationsForSession(sessionId)).toMatchObject([
			{
				id: annotation.id,
				_tag: "browser",
				comment: "this can be improved",
				pageUrl: "https://example.com/",
			},
		]);
	});

	it("persists drafts to localStorage", () => {
		useAnnotationsStore.getState().add(sessionId, {
			relPath: "src/app.ts",
			absPath: "/repo/src/app.ts",
			startLine: 7,
			endLine: 7,
			comment: "persist me",
		});

		const raw = localStorage.getItem("zuse.annotations.v1");
		expect(raw).not.toBeNull();
		expect(JSON.parse(raw ?? "{}")).toEqual(
			useAnnotationsStore.getState().bySession,
		);
	});
});
