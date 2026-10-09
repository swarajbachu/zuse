import { EnvironmentId, SessionId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	downloadAttachment,
	resolveAttachmentUrl,
	uploadAttachmentBytes,
} from "../../src/lib/attachments.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";

const dispatch = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/download-blob.ts", () => ({ downloadBlob: download }));
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	dispatchSessionWorkspaceCommand: dispatch,
}));
const sessionId = SessionId.make("image-session");
describe("workspace attachment previews", () => {
	beforeEach(() => {
		dispatch.mockReset();
		download.mockReset();
		observeRendererAccount(`test-${crypto.randomUUID()}`);
	});
	it("preserves previews on token refresh but clears them on account changes", async () => {
		const ref = {
			environmentId: EnvironmentId.make("account-preview"),
			sessionId,
		};
		dispatch.mockResolvedValue({
			result: {
				bytes: new Uint8Array([1]),
				mimeType: "image/png",
				originalName: "image.png",
			},
		});
		observeRendererAccount("first");
		await resolveAttachmentUrl(ref, "image");
		observeRendererAccount("first");
		await resolveAttachmentUrl(ref, "image");
		expect(dispatch).toHaveBeenCalledTimes(1);
		observeRendererAccount(null);
		await resolveAttachmentUrl(ref, "image");
		observeRendererAccount("second");
		await resolveAttachmentUrl(ref, "image");
		expect(dispatch).toHaveBeenCalledTimes(3);
	});
	it("rejects previous-account results without deleting the new account's pending read", async () => {
		const ref = {
			environmentId: EnvironmentId.make("account-race"),
			sessionId,
		};
		const result = {
			result: {
				bytes: new Uint8Array([1]),
				mimeType: "image/png",
				originalName: "image.png",
			},
		};
		let resolveOld = () => {};
		let resolveNew = () => {};
		dispatch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = () => resolve(result);
				}),
		);
		const old = resolveAttachmentUrl(ref, "image");
		const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
		observeRendererAccount("next-account");
		dispatch.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveNew = () => resolve(result);
				}),
		);
		const next = resolveAttachmentUrl(ref, "image");
		resolveOld();
		await rejected;
		expect(resolveAttachmentUrl(ref, "image")).toBe(next);
		resolveNew();
		await next;
		expect(dispatch).toHaveBeenCalledTimes(2);
	});
	it("does not deliver a file download across an account change", async () => {
		dispatch.mockImplementation(async () => {
			observeRendererAccount("changed-during-download");
			return {
				result: {
					bytes: new Uint8Array([1]),
					mimeType: "text/plain",
					originalName: "file.txt",
				},
			};
		});
		await expect(
			downloadAttachment(
				{ environmentId: EnvironmentId.make("account-download"), sessionId },
				"file",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(download).not.toHaveBeenCalled();
	});
	it("downloads files from the scoped RPC without caching their authorization", async () => {
		const ref = { environmentId: EnvironmentId.make("files"), sessionId };
		dispatch.mockResolvedValue({
			result: {
				bytes: new Uint8Array([1, 2]),
				mimeType: "application/pdf",
				originalName: "report.pdf",
			},
		});
		await downloadAttachment(ref, "file", new AbortController().signal);
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				ref,
				kind: "attachments.read",
				payload: { sessionId, id: "file" },
			}),
		);
		expect(download).toHaveBeenCalledWith(expect.any(Blob), "report.pdf");
		const blob: unknown = download.mock.calls[0]?.[0];
		if (!(blob instanceof Blob)) throw new Error("Expected a downloaded blob");
		expect(blob.type).toBe("application/pdf");
		expect(new Uint8Array(await blob.arrayBuffer())).toEqual(
			new Uint8Array([1, 2]),
		);
		dispatch.mockRejectedValueOnce(new Error("access denied"));
		await expect(
			downloadAttachment(ref, "file", new AbortController().signal),
		).rejects.toThrow("access denied");
		expect(download).toHaveBeenCalledTimes(1);
	});
	it("does not start a stale download after its session UI is unmounted", async () => {
		const controller = new AbortController();
		dispatch.mockImplementation(async () => {
			controller.abort();
			return {
				result: {
					bytes: new Uint8Array([1]),
					mimeType: "text/plain",
					originalName: "file.txt",
				},
			};
		});
		const ref = {
			environmentId: EnvironmentId.make("cancelled-file"),
			sessionId,
		};
		await expect(
			downloadAttachment(ref, "file", controller.signal),
		).rejects.toThrow();
		expect(download).not.toHaveBeenCalled();
		dispatch.mockClear();
		await expect(
			downloadAttachment(ref, "file", controller.signal),
		).rejects.toThrow();
		expect(dispatch).not.toHaveBeenCalled();
	});
	it("routes every ZIP chunk to the owning cloud session", async () => {
		const ref = { environmentId: EnvironmentId.make("cloud-zip"), sessionId };
		const bytes = new Uint8Array(7 * 1024 * 1024);
		dispatch.mockImplementation(async ({ payload }) => ({
			result:
				payload.offset + payload.bytes.length === bytes.length
					? {
							id: "uploaded-zip",
							mimeType: "application/zip",
							sizeBytes: bytes.length,
							ext: "zip",
						}
					: null,
		}));
		await expect(
			uploadAttachmentBytes(ref, {
				bytes,
				mimeType: "application/zip",
				originalName: "archive.zip",
			}),
		).resolves.toEqual({
			id: "uploaded-zip",
			mimeType: "application/zip",
			originalName: "archive.zip",
		});
		expect(dispatch).toHaveBeenCalledTimes(4);
		for (const [command] of dispatch.mock.calls) {
			expect(command).toMatchObject({
				ref,
				kind: "attachments.uploadChunk",
				payload: { sessionId, originalName: "archive.zip" },
			});
		}
	});
	it("reuses uploaded image bytes without downloading them again", async () => {
		const ref = {
			environmentId: EnvironmentId.make("uploaded-preview"),
			sessionId,
		};
		dispatch.mockResolvedValue({
			result: { id: "uploaded", mimeType: "image/png" },
		});
		await uploadAttachmentBytes(ref, {
			bytes: new Uint8Array([1, 2, 3]),
			mimeType: "image/png",
			originalName: "image.png",
		});
		expect(await resolveAttachmentUrl(ref, "uploaded")).toBe(
			"data:image/png;base64,AQID",
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it("reads identical attachment IDs from their owning environments", async () => {
		dispatch.mockImplementation(async ({ ref }) => ({
			result: {
				bytes: new TextEncoder().encode(ref.environmentId),
				mimeType: "image/png",
				originalName: "image.png",
			},
		}));
		for (const environment of ["local-images", "cloud-images"]) {
			const ref = { environmentId: EnvironmentId.make(environment), sessionId };
			expect(await resolveAttachmentUrl(ref, "same-image")).toBe(
				`data:image/png;base64,${btoa(environment)}`,
			);
			expect(dispatch).toHaveBeenLastCalledWith(
				expect.objectContaining({
					ref,
					kind: "attachments.read",
					payload: { sessionId, id: "same-image" },
				}),
			);
		}
	});
	it("shares concurrent reads and caches immutable previews", async () => {
		dispatch.mockResolvedValue({
			result: {
				bytes: new Uint8Array([1, 2, 3]),
				mimeType: "image/png",
				originalName: "image.png",
			},
		});
		const ref = {
			environmentId: EnvironmentId.make("shared-images"),
			sessionId,
		};
		await Promise.all([
			resolveAttachmentUrl(ref, "image"),
			resolveAttachmentUrl(ref, "image"),
		]);
		await resolveAttachmentUrl(ref, "image");
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
	it("allows retry after a failed read", async () => {
		dispatch
			.mockRejectedValueOnce(new Error("disconnected"))
			.mockResolvedValueOnce({
				result: {
					bytes: new Uint8Array([1]),
					mimeType: "image/png",
					originalName: "image.png",
				},
			});
		const ref = {
			environmentId: EnvironmentId.make("retry-images"),
			sessionId,
		};
		await expect(resolveAttachmentUrl(ref, "image")).rejects.toThrow(
			"disconnected",
		);
		await expect(resolveAttachmentUrl(ref, "image")).resolves.toBe(
			"data:image/png;base64,AQ==",
		);
	});
});
