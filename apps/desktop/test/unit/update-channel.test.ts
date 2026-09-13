import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	readUpdateChannel,
	UpdateChannelCoordinator,
	writeUpdateChannel,
} from "../../src/update-channel.ts";

const deferred = () => {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
};

describe("update channels", () => {
	it("defaults existing/corrupt installations to Stable and persists Preview atomically", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-channel-"));
		try {
			expect(await readUpdateChannel(directory)).toBe("stable");
			await writeFile(join(directory, "update-channel.json"), "broken");
			expect(await readUpdateChannel(directory)).toBe("stable");
			await writeFile(
				join(directory, "update-channel.json"),
				'{"channel":"alpha"}',
			);
			expect(await readUpdateChannel(directory)).toBe("stable");
			await writeUpdateChannel(directory, "preview");
			expect(await readUpdateChannel(directory)).toBe("preview");
			expect(await readdir(directory)).toEqual(["update-channel.json"]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("revokes install eligibility immediately but waits for the old transfer before persisting", async () => {
		const download = deferred();
		const persist = vi.fn(async () => {});
		const invalidate = vi.fn();
		const cancel = vi.fn();
		const coordinator = new UpdateChannelCoordinator(persist, invalidate);
		const running = coordinator.run(() => download.promise, cancel);
		await Promise.resolve();
		const changing = coordinator.setChannel("preview");
		expect(coordinator.switching).toBe(true);
		expect(invalidate).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
		expect(persist).not.toHaveBeenCalled();
		download.resolve();
		await running;
		await changing;
		expect(coordinator.channel).toBe("preview");
		expect(coordinator.switching).toBe(false);
	});
	it("serializes competing switches and recovers from a failed preference write", async () => {
		const persist = vi
			.fn(async () => {})
			.mockRejectedValueOnce(new Error("disk full"));
		const coordinator = new UpdateChannelCoordinator(persist, vi.fn());
		await expect(coordinator.setChannel("preview")).rejects.toThrow(
			"disk full",
		);
		expect(coordinator.channel).toBe("stable");
		await Promise.all([
			coordinator.setChannel("preview"),
			coordinator.setChannel("stable"),
		]);
		expect(coordinator.channel).toBe("stable");
		expect(coordinator.switching).toBe(false);
		await expect(coordinator.setChannel("nightly")).rejects.toThrow(
			"Invalid update channel",
		);
	});
});
