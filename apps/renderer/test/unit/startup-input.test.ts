import type { SessionRef } from "@zuse/client-runtime/resource-ref";
import {
	type AttachmentRef,
	ComposerInput,
	EnvironmentId,
	SessionId,
} from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploadAttachment = vi.fn();
const saveContextFile = vi.fn();
const saveContextText = vi.fn();

vi.mock("../../src/lib/attachments.ts", () => ({
	uploadAttachment: (...args: ReadonlyArray<unknown>) =>
		uploadAttachment(...args),
}));
vi.mock("../../src/lib/context-handoff.ts", () => ({
	saveContextFile: (...args: ReadonlyArray<unknown>) =>
		saveContextFile(...args),
	saveContextText: (...args: ReadonlyArray<unknown>) =>
		saveContextText(...args),
}));

const {
	finalizeStartupInput,
	finalizeStartupInputWhenReady,
	StartupInputError,
	startupInputNeedsPreparation,
} = await import("../../src/composer/startup-input.ts");

const target = {
	ref: {
		environmentId: EnvironmentId.make("workspace-1"),
		sessionId: SessionId.make("session-1"),
	} satisfies SessionRef,
	uploadRoot: null,
};

const emptyOptions = {
	issueMarkdown: null,
	prepareLinear: null,
	pendingContextFiles: [],
	pendingAttachments: [],
};

const inputWith = (
	overrides: Partial<Parameters<typeof ComposerInput.make>[0]> = {},
): ComposerInput =>
	ComposerInput.make({
		text: "ship it",
		attachments: [],
		fileRefs: [],
		skillRefs: [],
		...overrides,
	});

const pendingAttachment = (tempId: string) => ({
	tempId,
	file: new File([new Uint8Array([1])], "shot.png", { type: "image/png" }),
	previewUrl: "",
});

beforeEach(() => {
	uploadAttachment.mockReset();
	saveContextFile.mockReset();
	saveContextText.mockReset();
});

describe("startup input preparation", () => {
	it("only reports preparation when the message references bytes", () => {
		expect(startupInputNeedsPreparation(emptyOptions)).toBe(false);
		expect(
			startupInputNeedsPreparation({
				...emptyOptions,
				issueMarkdown: "# Bug",
			}),
		).toBe(true);
		expect(
			startupInputNeedsPreparation({
				...emptyOptions,
				prepareLinear: async (input) => input,
			}),
		).toBe(true);
		expect(
			startupInputNeedsPreparation({
				...emptyOptions,
				pendingAttachments: [pendingAttachment("pending-1")],
			}),
		).toBe(true);
	});

	it("writes issue, Linear, pasted text, and files into the target session", async () => {
		saveContextFile.mockResolvedValue({
			relPath: ".context/files/issue.md",
			absPath: "/sandbox/.context/files/issue.md",
		});
		saveContextText.mockResolvedValue({
			relPath: ".context/files/paste-1.md",
			absPath: "/sandbox/.context/files/paste-1.md",
		});
		uploadAttachment.mockResolvedValue({
			id: "attachment-1",
			mimeType: "image/png",
			originalName: "shot.png",
		} satisfies AttachmentRef);

		const finalized = await finalizeStartupInput(
			inputWith({
				text: "see @.context/files/paste-pending-1.md",
				attachments: [
					{
						id: "pending-1",
						mimeType: "image/png",
						originalName: "shot.png",
					},
				],
				fileRefs: [
					{
						relPath: ".context/files/paste-pending-1.md",
						absPath: "",
						kind: "file",
					},
				],
			}),
			target,
			{
				issueMarkdown: "# Bug",
				prepareLinear: async (input) =>
					ComposerInput.make({ ...input, text: `${input.text} (linear)` }),
				pendingContextFiles: [
					{
						tempRelPath: ".context/files/paste-pending-1.md",
						text: "pasted",
						ext: "md",
					},
				],
				pendingAttachments: [pendingAttachment("pending-1")],
			},
		);

		expect(saveContextFile).toHaveBeenCalledWith(
			target.ref.environmentId,
			target.ref.sessionId,
			"# Bug",
		);
		expect(uploadAttachment).toHaveBeenCalledWith(
			target.ref,
			expect.any(File),
			undefined,
		);
		expect(finalized.text).toContain("(linear)");
		expect(finalized.text).toContain("@.context/files/paste-1.md");
		expect(finalized.attachments).toEqual([
			{ id: "attachment-1", mimeType: "image/png", originalName: "shot.png" },
		]);
		expect(finalized.fileRefs.map((ref) => ref.relPath)).toEqual([
			".context/files/paste-1.md",
			".context/files/issue.md",
		]);
	});

	it("passes the local workspace root through as the upload fallback", async () => {
		uploadAttachment.mockResolvedValue({
			id: "attachment-1",
			mimeType: "image/png",
			originalName: "shot.png",
		} satisfies AttachmentRef);

		await finalizeStartupInput(
			inputWith({
				attachments: [
					{ id: "pending-1", mimeType: "image/png", originalName: "shot.png" },
				],
			}),
			{ ref: target.ref, uploadRoot: "/repo" },
			{ ...emptyOptions, pendingAttachments: [pendingAttachment("pending-1")] },
		);

		expect(uploadAttachment).toHaveBeenCalledWith(
			target.ref,
			expect.any(File),
			"/repo",
		);
	});

	it("names the stage that failed so the caller can explain it", async () => {
		uploadAttachment.mockRejectedValue(new Error("sandbox offline"));

		await expect(
			finalizeStartupInput(
				inputWith({
					attachments: [
						{
							id: "pending-1",
							mimeType: "image/png",
							originalName: "shot.png",
						},
					],
				}),
				target,
				{
					...emptyOptions,
					pendingAttachments: [pendingAttachment("pending-1")],
				},
			),
		).rejects.toBeInstanceOf(StartupInputError);
	});
});

describe("startup input retry while the target session registers", () => {
	it("retries a write that lost the race with session registration", async () => {
		saveContextFile
			.mockRejectedValueOnce(
				Object.assign(new Error("no session"), {
					_tag: "SessionNotFoundError",
				}),
			)
			.mockResolvedValue({
				relPath: ".context/files/issue.md",
				absPath: "/sandbox/.context/files/issue.md",
			});

		const finalized = await finalizeStartupInputWhenReady(
			inputWith(),
			target,
			{ ...emptyOptions, issueMarkdown: "# Bug" },
			{ attempts: 3, delayMs: 0 },
		);

		expect(saveContextFile).toHaveBeenCalledTimes(2);
		expect(finalized.fileRefs).toHaveLength(1);
	});

	it("does not retry a genuine upload failure", async () => {
		uploadAttachment.mockRejectedValue(new Error("bytes rejected"));

		await expect(
			finalizeStartupInputWhenReady(
				inputWith({
					attachments: [
						{
							id: "pending-1",
							mimeType: "image/png",
							originalName: "shot.png",
						},
					],
				}),
				target,
				{
					...emptyOptions,
					pendingAttachments: [pendingAttachment("pending-1")],
				},
				{ attempts: 3, delayMs: 0 },
			),
		).rejects.toBeInstanceOf(StartupInputError);
		expect(uploadAttachment).toHaveBeenCalledTimes(1);
	});
});
