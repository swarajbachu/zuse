// Render a 1024×1024 macOS-shaped icon to apps/desktop/build/icon.png.
// electron-builder takes that PNG and generates the .icns at package time.
//
// Source preference: if `apps/desktop/build/icon.source.png` exists, that
// raster is used (resized to 1024 and clipped to the macOS squircle).
// The SVG fallback is regenerated from the shared Zuse mark before rendering.
// macOS uses a ~22.37% corner radius on its app icon mask — apps without it
// look subtly off next to native apps in the Dock/Finder.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SIZE = 1024;
const RADIUS = Math.round(SIZE * 0.2237);

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(here, "..", "build");
const sourcePng = resolve(buildDir, "icon.source.png");
const sourceSvg = resolve(buildDir, "icon.svg");
const outPng = resolve(buildDir, "icon.png");
const markDataPath = resolve(here, "../../../packages/ui/src/zuse-mark.json");
const mark = JSON.parse(await readFile(markDataPath, "utf8"));

const markPath = (fill) =>
	`<path d="${mark.path}" fill="${fill}" transform="${mark.transform}"/>`;

const vectorSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}" width="1254" height="1254">
  ${markPath("#fff")}
</svg>
`;
await writeFile(sourceSvg, vectorSvg);

const fallbackAppIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox}" width="1254" height="1254">
  <defs>
    <linearGradient id="zuse-mark" x1="0" y1="0" x2="0.8" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.72" stop-color="#fafafa"/>
      <stop offset="1" stop-color="#e9e9eb"/>
    </linearGradient>
  </defs>
  <rect width="1254" height="1254" fill="#000000"/>
  ${markPath("url(#zuse-mark)")}
</svg>
`;

const base = existsSync(sourcePng)
	? sharp(await readFile(sourcePng))
	: sharp(Buffer.from(fallbackAppIconSvg), { density: 384 });

const mask = Buffer.from(
	`<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
);

const png = await base
	.resize(SIZE, SIZE, { fit: "cover" })
	.composite([{ input: mask, blend: "dest-in" }])
	.png()
	.toBuffer();

await writeFile(outPng, png);
console.log(`wrote ${png.length} bytes to ${outPng}`);
