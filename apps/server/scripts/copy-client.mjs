import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rendererDist = resolve(serverDir, "..", "renderer", "dist");
const clientDist = resolve(serverDir, "dist", "client");

await rm(clientDist, { recursive: true, force: true });
await mkdir(clientDist, { recursive: true });
await cp(rendererDist, clientDist, { recursive: true });
