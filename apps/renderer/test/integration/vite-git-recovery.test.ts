import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite-plus";
import { expect, it, vi } from "vitest";
import { gitRevisionRecovery } from "../../vite-git-recovery.ts";

it("restarts a real Vite server after successive Git revisions", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-vite-git-"));
	execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root });
	const ref = join(root, ".git/refs/heads/main");
	await writeFile(ref, `${"a".repeat(40)}\n`);
	await writeFile(join(root, "index.html"), "<div>Git recovery fixture</div>");
	const server = await createServer({
		configFile: false,
		root,
		logLevel: "silent",
		plugins: [gitRevisionRecovery()],
		server: { host: "127.0.0.1", port: 0 },
		optimizeDeps: { noDiscovery: true, include: [] },
	});
	try {
		await server.listen();
		for (const revision of ["b", "c"]) {
			const original = server.httpServer;
			await writeFile(ref, `${revision.repeat(40)}\n`);
			await vi.waitFor(() => expect(server.httpServer).not.toBe(original), {
				timeout: 5000,
			});
			await vi.waitFor(
				async () => {
					const address = server.httpServer?.address();
					if (!address || typeof address === "string")
						throw new Error("Server not listening");
					const response = await fetch(`http://127.0.0.1:${address.port}`);
					expect(await response.text()).toContain("Git recovery fixture");
				},
				{ timeout: 5000 },
			);
		}
	} finally {
		await server.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
