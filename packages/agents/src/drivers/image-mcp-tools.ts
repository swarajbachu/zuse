import { readFile, realpath, stat } from "node:fs/promises";
import * as path from "node:path";

export const IMAGE_MCP_SERVER_NAME = "zuse-images";
export const MAX_VIEW_IMAGE_BYTES = 10 * 1024 * 1024;

export const IMAGE_MCP_TOOLS = [
	{
		name: "view_image",
		description:
			"View a PNG, JPEG, GIF, or WebP image from the current workspace. Returns the image as multimodal content.",
		inputSchema: {
			type: "object" as const,
			properties: {
				path: {
					type: "string" as const,
					description: "Workspace-relative or absolute image path.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
] as const;

export interface ImageMcpToolOptions {
	readonly cwd: string;
}

const isWithin = (candidate: string, root: string): boolean =>
	candidate === root || candidate.startsWith(`${root}${path.sep}`);

const imageMime = (bytes: Uint8Array): string | null => {
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return "image/jpeg";
	}
	const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
	if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) {
		return "image/gif";
	}
	if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
		return "image/webp";
	}
	return null;
};

export const viewWorkspaceImage = async (
	options: ImageMcpToolOptions,
	requestedPath: string,
) => {
	if (requestedPath.trim().length === 0) {
		throw new Error("path is required");
	}
	const root = await realpath(options.cwd);
	const candidate = path.resolve(options.cwd, requestedPath);
	const resolved = await realpath(candidate);
	if (!isWithin(resolved, root)) {
		throw new Error(`Path escapes workspace: ${requestedPath}`);
	}
	const metadata = await stat(resolved);
	if (!metadata.isFile()) throw new Error(`Not a file: ${requestedPath}`);
	if (metadata.size > MAX_VIEW_IMAGE_BYTES) {
		throw new Error("Image exceeds the 10 MiB viewing limit");
	}
	const bytes = await readFile(resolved);
	const mimeType = imageMime(bytes);
	if (mimeType === null) {
		throw new Error(
			"Unsupported image format; expected PNG, JPEG, GIF, or WebP",
		);
	}
	return {
		content: [
			{
				type: "image" as const,
				data: bytes.toString("base64"),
				mimeType,
			},
			{
				type: "text" as const,
				text: `Viewed image: ${path.relative(root, resolved) || path.basename(resolved)}`,
			},
		],
	};
};

export const handleImageTool = async (
	name: string,
	args: Record<string, unknown>,
	options: ImageMcpToolOptions,
) => {
	if (name !== "view_image") throw new Error(`Unknown tool: ${name}`);
	if (typeof args.path !== "string") throw new Error("path is required");
	return viewWorkspaceImage(options, args.path);
};
