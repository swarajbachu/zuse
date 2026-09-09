import { EnvironmentId, SessionId } from "@zuse/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	resolveAttachmentUrl,
	uploadAttachmentBytes,
} from "../../src/lib/attachments.ts";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/session-timeline-client-bus.ts", () => ({
	dispatchSessionCommand: dispatch,
}));
const sessionId = SessionId.make("image-session");
describe("workspace attachment previews", () => {
	beforeEach(() => {
		dispatch.mockReset();
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
