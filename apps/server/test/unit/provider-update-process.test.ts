import { Effect, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { startProviderUpdate } from "../../src/provider/services/update-service.ts";

it.skipIf(process.platform !== "win32").each(["cancellation", "timeout"])(
	"update %s stops its descendant process",
	async (mode) => {
		const schedule = globalThis.setTimeout;
		const timer = vi
			.spyOn(globalThis, "setTimeout")
			.mockImplementation((callback, ms, ...args) =>
				schedule(
					callback,
					mode === "timeout" && ms === 300_000 ? 2_000 : ms,
					...args,
				),
			);
		// The command processor owns a Node launcher, which owns another Node process.
		const script =
			"const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)";
		let descendant: number | undefined;
		try {
			const events = await Effect.runPromise(
				startProviderUpdate(
					"claude",
					`"${process.execPath}" -e "${script}"`,
				).pipe(
					Stream.tap((event) =>
						Effect.sync(() => {
							if (event._tag === "log") descendant = Number(event.text);
						}),
					),
					Stream.take(mode === "cancellation" ? 1 : 2),
					Stream.runCollect,
					Effect.timeout("10 seconds"),
				),
			);
			expect(events[0]?._tag).toBe("log");
			if (mode === "timeout") {
				expect(events[1]).toEqual({
					_tag: "done",
					ok: false,
					reason: "Update timed out after 5 minutes.",
				});
			}
			expect(descendant).toBeGreaterThan(0);
			expect(() => process.kill(descendant ?? 0, 0)).toThrow();
		} finally {
			timer.mockRestore();
			if (descendant) {
				try {
					process.kill(descendant);
				} catch {}
			}
		}
	},
	15_000,
);

it("reports an unavailable update command without starting a process", async () => {
	const events = await Effect.runPromise(
		startProviderUpdate("claude", null).pipe(Stream.runCollect),
	);
	expect(events).toEqual([
		{
			_tag: "done",
			ok: false,
			reason: "No update command is available for claude.",
		},
	]);
});
