import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { loadOpencode2Inventory } from "../../../src/drivers/opencode2.ts";

afterEach(() => vi.unstubAllEnvs());

it.each([
	"persisted",
	"default",
	"stdout",
])("loads inventory using the %s server password", async (passwordSource) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-opencode2-"));
	try {
		const stateHome =
			passwordSource === "default"
				? join(directory, ".local", "state")
				: directory;
		vi.stubEnv("XDG_STATE_HOME", passwordSource === "default" ? "" : directory);
		vi.stubEnv("HOME", directory);
		if (passwordSource !== "stdout") {
			await mkdir(join(stateHome, "opencode"), { recursive: true });
			await writeFile(
				join(stateHome, "opencode", "password"),
				"fixture-password",
			);
		}
		const binary = join(directory, "opencode2");
		await writeFile(
			binary,
			`#!/usr/bin/env node
const http = require("node:http");
const port = Number(process.argv.find((arg) => arg.startsWith("--port=")).split("=")[1]);
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== "Basic " + Buffer.from("opencode:fixture-password").toString("base64")) {
    res.writeHead(401); res.end(); return;
  }
  const path = new URL(req.url, "http://localhost").pathname;
  const data = path === "/api/provider" ? [{ id: "local", name: "Local" }]
    : path === "/api/model" ? [{ id: "model", providerID: "local", enabled: true, status: "active", capabilities: { tools: true } }]
    : path === "/api/agent" ? [{ id: "build", mode: "primary" }] : [];
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data }));
});
server.listen(port, "127.0.0.1", () => {
  if (${passwordSource === "stdout"}) console.log("server password fixture-password");
  console.log("server listening on http://127.0.0.1:" + port);
});
`,
		);
		await chmod(binary, 0o755);
		const inventory = await Effect.runPromise(
			loadOpencode2Inventory(binary, directory),
		);
		expect(inventory.providers[0]?.models[0]?.id).toBe("local/model");
		expect(inventory.agents).toEqual([{ name: "build", mode: "primary" }]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 20_000);
