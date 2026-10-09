/** Private authority transport. Provider credentials never leave as plaintext. */
export const AUTH_GRANT_SERVICE_PORT = 47839;

export const AUTH_GRANT_SERVICE_SOURCE = `
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const home = process.env.ZUSE_CLOUD_AUTH_HOME ?? "/home/zuse/.zuse/cloud-auth";
const token = randomBytes(32).toString("base64url");
const incarnation = (await readFile(home + "/storage-incarnation-id", "utf8")).trim();
const descriptorPath = home + "/grant-service.json";
let pending = 0;
// Share the existing OS lock with older API workers and CLI grant callers.
const withProviderLock = async (providerId, run) => {
  const child = spawn("flock", ["-x", "-w", "25", home + "/" + providerId + "-refresh.lock", "sh", "-c", "printf ready; cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {});
  try {
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("lock_unavailable")));
      child.stdout.once("data", resolve);
    });
    return await run();
  } finally { child.stdin.end(); }
};
const server = createServer(async (request, response) => {
  response.setHeader("cache-control", "no-store");
  const supplied = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from("Bearer " + token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    response.writeHead(401).end(); return;
  }
  if (request.method !== "POST" || request.url !== "/grant") { response.writeHead(404).end(); return; }
  if (pending >= 32) { response.writeHead(503).end(); return; }
  pending++;
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 32768) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const { version, input } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const providerId = input?.providerId ?? "codex";
    if (!/^[a-f0-9]{64}$/.test(version) || !["claude", "codex", "cursor", "grok"].includes(providerId) || !/^[0-9a-f-]{36}$/i.test(input?.requestId ?? "")) {
      response.writeHead(400).end(); return;
    }
    if (input.authorityIncarnationId !== incarnation) { response.writeHead(409).end(); return; }
    const result = await withProviderLock(providerId, async () => {
      const { issueGrant } = await import(pathToFileURL(home + "/bootstrap/grant-" + version + ".mjs").href);
      const cachePath = home + "/grant-cache/" + (input.providerId === undefined ? "" : providerId + "-") + input.requestId + ".json";
      return issueGrant(input, cachePath);
    });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
  } catch { response.writeHead(503).end(); }
  finally { pending--; }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(Number(process.env.ZUSE_AUTH_GRANT_PORT ?? 47839), "0.0.0.0", resolve);
});
await writeFile(descriptorPath + ".tmp", JSON.stringify({ token, incarnation, port: server.address().port }), { mode: 0o600 });
await rename(descriptorPath + ".tmp", descriptorPath);
`;
