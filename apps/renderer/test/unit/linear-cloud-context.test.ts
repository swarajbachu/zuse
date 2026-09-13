import {
	LinearContextFile,
	LinearContextWarning,
	LinearIssueRef,
} from "@zuse/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/attachments.ts", () => ({
	readAttachment: vi.fn(),
	uploadAttachmentBytes: vi.fn(),
}));
vi.mock("../../src/lib/context-handoff.ts", () => ({
	saveContextText: vi.fn(),
}));
vi.mock("../../src/lib/file-tree-client-bus.ts", () => ({
	dispatchFileTreeCommand: vi.fn(),
}));

const { transferLinearContext } = await import(
	"../../src/lib/linear-cloud-context.ts"
);

const issue = LinearIssueRef.make({
	workspaceId: "workspace-1",
	issueId: "issue-1",
	identifier: "ZUS-1",
});

const prepared = {
	files: [
		LinearContextFile.make({
			issue,
			relPath: ".context/linear/zuse/ZUS-1.md",
			absPath: "/repo/.context/linear/zuse/ZUS-1.md",
		}),
	],
	attachments: [
		{ id: "local-1", mimeType: "image/png", originalName: "mock.png" },
	],
	warnings: [],
};

const io = (
	overrides: Partial<Parameters<typeof transferLinearContext>[1]> = {},
) => ({
	readFile: async () => "# ZUS-1",
	saveText: async () => ({
		relPath: ".context/files/paste-1.md",
		absPath: "/sandbox/.context/files/paste-1.md",
	}),
	readAttachment: async () => ({
		bytes: new Uint8Array([1, 2]),
		mimeType: "image/png",
		originalName: "mock.png",
	}),
	upload: async () => ({
		id: "sandbox-1",
		mimeType: "image/png",
		originalName: "mock.png",
	}),
	...overrides,
});

describe("linear cloud context transfer", () => {
	it("re-points context files and attachments at the target environment", async () => {
		const transferred = await transferLinearContext(prepared, io());

		expect(transferred.files).toEqual([
			LinearContextFile.make({
				issue,
				relPath: ".context/files/paste-1.md",
				absPath: "/sandbox/.context/files/paste-1.md",
			}),
		]);
		expect(transferred.attachments).toEqual([
			{ id: "sandbox-1", mimeType: "image/png", originalName: "mock.png" },
		]);
		expect(transferred.warnings).toEqual([]);
	});

	it("keeps prior warnings and never drops the launch when a file fails", async () => {
		const warning = LinearContextWarning.make({
			issue,
			message: "Comments were unavailable",
		});
		const transferred = await transferLinearContext(
			{ ...prepared, warnings: [warning] },
			io({
				readFile: async () => {
					throw new Error("file vanished");
				},
			}),
		);

		expect(transferred.files).toEqual([]);
		expect(transferred.attachments).toHaveLength(1);
		expect(transferred.warnings).toHaveLength(2);
		expect(transferred.warnings[1]?.message).toContain("file vanished");
	});

	it("warns instead of failing when an image cannot be copied", async () => {
		const transferred = await transferLinearContext(
			prepared,
			io({
				upload: async () => {
					throw new Error("sandbox offline");
				},
			}),
		);

		expect(transferred.attachments).toEqual([]);
		expect(transferred.warnings).toHaveLength(1);
		expect(transferred.warnings[0]?.message).toContain("mock.png");
	});
});
