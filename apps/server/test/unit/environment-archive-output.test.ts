import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ChatId } from "@zuse/contracts";
import { Effect } from "effect";
import { expect, test, vi } from "vitest";

const mock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mock.spawn }));

import { runArchiveScript } from "../../src/conversation/core/conversation-archive-script.ts";

test("archive output masks independent streams and split UTF-8 bytes", async () => {
	const secret = "clé-private";
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: 123 });
	mock.spawn.mockReturnValue(child);
	const result = Effect.runPromise(
		runArchiveScript({
			chatId: ChatId.make("chat"),
			cwd: "/tmp",
			script: "ignored",
			env: { TOKEN: secret },
			secretValues: [secret],
		}),
	);
	await vi.waitFor(() => expect(mock.spawn).toHaveBeenCalled());
	const bytes = Buffer.from(secret);
	stdout.write(bytes.subarray(0, 3));
	stderr.write("diagnostic\n");
	stdout.write(bytes.subarray(3, 7));
	stderr.write(secret);
	stdout.write(bytes.subarray(7));
	stdout.end();
	stderr.end();
	child.emit("close", 0, null);
	const observed = await result;
	expect(observed.output).toBe("diagnostic\n[secret][secret]");
	expect(mock.spawn.mock.calls[0]?.[2].env.TOKEN).toBe(secret);
});
