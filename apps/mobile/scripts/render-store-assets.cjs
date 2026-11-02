/** Render store layouts from unaltered simulator captures and licensed device bezels. */
const fs = require("node:fs/promises");
const path = require("node:path");
const sharp = require("sharp");
const root = path.resolve(__dirname, "../../..");
const work = path.join(root, ".context/mobile-release");
const output = path.join(root, "apps/mobile/store-assets/1.1.0/delivery");
const renderAvailable = process.argv.includes("--available");
const requestedSurface = process.argv
	.find((arg) => arg.startsWith("--surface="))
	?.split("=")[1];
const surfaces = {
	ipad: { size: [2064, 2752], inset: [118, 124, 2064, 2752] },
	"duo-outer": { size: [1398, 2034], inset: [88, 80, 1398, 2034] },
	"duo-inner": { size: [2007, 2853], inset: [120, 120, 2007, 2853] },
};
const scenes = [
	["01-projects", ["Every project.", "One place."]],
	["02-conversation", ["Keep the", "conversation moving."]],
	["03-start-work", ["Start your", "next task."]],
	["04-review-changes", ["Review", "every change."]],
];
const escapeXml = (value) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
async function device(surface, orientation, scene) {
	const raw = path.join(
		work,
		"captures",
		`${surface}-${orientation}-${scene}.png`,
	);
	const meta = await sharp(raw).metadata();
	const size = surfaces[surface].size;
	const expected = orientation === "portrait" ? size : [...size].reverse();
	if (meta.width !== expected[0] || meta.height !== expected[1])
		throw new Error(`Wrong capture size: ${raw}: ${meta.width}x${meta.height}`);
	const frame = path.join(work, "bezels", `${surface}-${orientation}.png`);
	const frameMeta = await sharp(frame).metadata();
	const [x, y, w, h] = surfaces[surface].inset;
	const inset = orientation === "portrait" ? [x, y, w, h] : [y, x, h, w];
	// Clip the screen to the exact transparent screen hole, preserving rounded corners.
	const alpha = await sharp(frame)
		.extract({
			left: inset[0],
			top: inset[1],
			width: inset[2],
			height: inset[3],
		})
		.ensureAlpha()
		.extractChannel(3)
		.negate()
		.toBuffer();
	const mask = await sharp({
		create: {
			width: inset[2],
			height: inset[3],
			channels: 3,
			background: "#fff",
		},
	})
		.joinChannel(alpha)
		.png()
		.toBuffer();
	const screen = await sharp(raw)
		.composite([{ input: mask, blend: "dest-in" }])
		.png()
		.toBuffer();
	return sharp({
		create: {
			width: frameMeta.width,
			height: frameMeta.height,
			channels: 4,
			background: "#0000",
		},
	})
		.composite([
			{ input: screen, left: inset[0], top: inset[1] },
			{ input: frame },
		])
		.png()
		.toBuffer();
}
async function background(width, height, creative = false) {
	return sharp(
		path.join(
			root,
			creative
				? "apps/mobile/store-assets/1.1.0/source/engraved-arch-background.png"
				: "apps/mobile/store-assets/1.1.0/source/engraved-ivory-background.png",
		),
	)
		.resize(width, height, { fit: "cover" })
		.composite([
			{
				input: Buffer.from(
					`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#f6f4ec" opacity="${creative ? 0.55 : 0.85}"/></svg>`,
				),
			},
		])
		.toBuffer();
}
async function type(
	width,
	height,
	lines,
	{ landscape = false, creative = false, compact = false } = {},
) {
	const margin = Math.round(width * 0.065);
	const font = Math.round(
		width * (landscape ? 0.046 : compact ? 0.058 : 0.068),
	);
	const top = Math.round(
		height * (creative ? 0.15 : landscape ? 0.27 : compact ? 0.045 : 0.068),
	);
	if (landscape)
		lines = lines.flatMap((line) =>
			line.length > 17 ? line.split(" ") : [line],
		);
	const overlays = [
		{
			input: Buffer.from(
				`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${margin}" y="${Math.round(top - font * 0.35)}" font-family="Helvetica Neue, sans-serif" font-size="${Math.round(font * 0.23)}" font-weight="600" letter-spacing="5" fill="#454940">ZUSE · BUILD FROM ANYWHERE</text></svg>`,
			),
		},
	];
	for (const [index, line] of lines.entries()) {
		let input = await sharp({
			text: {
				text: `<span foreground="#161817">${escapeXml(line)}</span>`,
				font: `Helvetica Neue Bold ${font}`,
				dpi: 72,
				rgba: true,
			},
		})
			.png()
			.toBuffer();
		const meta = await sharp(input).metadata();
		const maxWidth = Math.round(width * (landscape ? 0.28 : 0.87));
		if (meta.width > maxWidth)
			input = await sharp(input).resize({ width: maxWidth }).png().toBuffer();
		overlays.push({
			input,
			left: margin,
			top: Math.round(top + font * (index * 1.08 + 0.24)),
		});
	}
	return sharp({ create: { width, height, channels: 4, background: "#0000" } })
		.composite(overlays)
		.png()
		.toBuffer();
}

async function cropPlacement(input, left, top, width, height) {
	const meta = await sharp(input).metadata();
	if (left < 0 || left + meta.width > width)
		throw new Error("Device extends beyond the horizontal canvas bounds");
	const x = Math.max(0, -left);
	const y = Math.max(0, -top);
	return {
		input: await sharp(input)
			.extract({
				left: x,
				top: y,
				width: Math.min(meta.width - x, width - Math.max(0, left)),
				height: Math.min(meta.height - y, height - Math.max(0, top)),
			})
			.png()
			.toBuffer(),
		left: Math.max(0, left),
		top: Math.max(0, top),
	};
}

async function card(surface, orientation, scene, lines) {
	const portrait = orientation === "portrait";
	const size = surfaces[surface].size;
	const [width, height] = portrait ? size : [...size].reverse();
	const framed = await device(surface, orientation, scene);
	const rendered = await sharp(framed)
		.resize({
			width: Math.round(width * (portrait ? 0.96 : 0.6)),
			height: Math.round(height * (portrait ? 0.98 : 0.95)),
			fit: "inside",
		})
		.toBuffer();
	const m = await sharp(rendered).metadata();
	const left = portrait
		? Math.round((width - m.width) / 2)
		: Math.round(width * 0.36);
	// Let the device continue below the canvas instead of shrinking it to fit.
	const top = Math.round(height - m.height * 0.9);
	const placement = await cropPlacement(rendered, left, top, width, height);
	await sharp(await background(width, height))
		.composite([
			{
				input: await type(width, height, lines, {
					landscape: !portrait,
					compact: portrait,
				}),
			},
			placement,
		])
		.flatten({ background: "#f5f3ea" })
		.removeAlpha()
		.png()
		.toFile(path.join(output, `${surface}-${orientation}-${scene}.png`));
}
async function creative(surface, kind, width, height) {
	const raw = await device(surface, "portrait", "02-conversation");
	const rendered = await sharp(raw)
		.resize({
			width: Math.round(width * 0.5),
			height: Math.round(height * 1.1),
			fit: "inside",
		})
		.toBuffer();
	const m = await sharp(rendered).metadata();
	const lines =
		surface === "ipad"
			? ["More room.", "More momentum."]
			: ["Open up", "your next idea."];
	await sharp(await background(width, height, true))
		.composite([
			{
				input: await type(width, height, lines, {
					landscape: true,
					creative: true,
				}),
			},
			await cropPlacement(
				rendered,
				Math.round(width * 0.7 - m.width / 2),
				Math.round(height - m.height * 0.9),
				width,
				height,
			),
		])
		.flatten({ background: "#f5f3ea" })
		.removeAlpha()
		.png()
		.toFile(
			path.join(output, `${surface === "ipad" ? "ipad" : "duo"}-${kind}.png`),
		);
}
(async () => {
	if (requestedSurface && !(requestedSurface in surfaces))
		throw new Error(`Unknown surface: ${requestedSurface}`);
	const selectedSurfaces = requestedSurface
		? [requestedSurface]
		: Object.keys(surfaces);
	await fs.mkdir(output, { recursive: true });
	const captures = [];
	for (const surface of selectedSurfaces)
		for (const orientation of ["portrait", "landscape"])
			for (const [scene, lines] of scenes) {
				try {
					await fs.access(
						path.join(
							work,
							"captures",
							`${surface}-${orientation}-${scene}.png`,
						),
					);
					captures.push({ surface, orientation, scene, lines });
				} catch (error) {
					if (!renderAvailable) throw error;
				}
			}
	for (const capture of captures)
		await card(
			capture.surface,
			capture.orientation,
			capture.scene,
			capture.lines,
		);
	for (const surface of ["ipad", "duo-inner"].filter(
		(surface) =>
			selectedSurfaces.includes(surface) &&
			captures.some(
				(capture) =>
					capture.surface === surface &&
					capture.orientation === "portrait" &&
					capture.scene === "02-conversation",
			),
	))
		for (const [kind, w, h] of [
			["header", 3840, 1646],
			["search", 3840, 2560],
			["universal", 5244, 2950],
		])
			await creative(surface, kind, w, h);
	const files = await fs.readdir(output);
	const manifest = [];
	for (const file of files.filter((f) => f.endsWith(".png"))) {
		const m = await sharp(path.join(output, file)).metadata();
		if (m.hasAlpha) throw new Error(`Alpha channel: ${file}`);
		manifest.push({
			file,
			width: m.width,
			height: m.height,
			bytes: (await fs.stat(path.join(output, file))).size,
		});
	}
	if (!requestedSurface && !renderAvailable && manifest.length !== 30)
		throw new Error(`Expected 30 images; found ${manifest.length}`);
	await fs.writeFile(
		path.join(output, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	console.log(
		`Rendered and validated ${manifest.length} opaque store images in ${output}`,
	);
})().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
