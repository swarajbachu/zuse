import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startExtensionProcess } from "../../src/runtime.ts";

it("rejects raw secret IPC without a credentials grant before touching storage", async () => {
	const root = await mkdtemp(join(tmpdir(), "extension-secrets-"));
	const secretStore = {
		get: vi.fn(async () => "private"),
		set: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
	};
	await mkdir(join(root, "state"));
	const runtime = await startExtensionProcess({
		id: "ungranted",
		storagePath: join(root, "state"),
		capabilities: ["rpc"],
		now: () => new Date(),
		onExit: () => {},
		secretStore,
		compiled: {
			clientBundle: "",
			clientCss: "",
			serverBundle: `require => ({ default: e => {
                const { Schema } = require("effect");
                e.handle({name:"probe", input:Schema.String, output:Schema.String}, operation => new Promise(resolve => {
                    const requestId = "raw-" + operation;
                    const receive = message => {
                        if (message.type !== "secret-result" || message.requestId !== requestId) return;
                        process.off("message", receive);
                        resolve(message.error || "unexpected access");
                    };
                    process.on("message", receive);
                    process.send({type:"secret", operation, requestId, key:"token", value:"replacement"});
                }));
                return () => {};
            } })`,
		},
	});
	try {
		runtime.activate();
		for (const operation of ["get", "set", "delete"])
			expect(await runtime.invoke("probe", operation)).toContain(
				"credentials capability",
			);
		expect(secretStore.get).not.toHaveBeenCalled();
		expect(secretStore.set).not.toHaveBeenCalled();
		expect(secretStore.delete).not.toHaveBeenCalled();
	} finally {
		await runtime.stop();
		await rm(root, { recursive: true, force: true });
	}
}, 20000);
