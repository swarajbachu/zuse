import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PermissionKind } from "@zuse/contracts";
import { Schema } from "effect";
import type { AcpPermissionContext } from "../../kernel/acp-permission-context.ts";
import { type FsOp, getFsPolicy } from "../../kernel/policy.ts";

/**
 * ACP FS client implementation.
 *
 * The Grok (and Gemini/Cursor) agent calls fs/* methods to read/write the
 * workspace directly. All advertised capabilities (readTextFile, writeTextFile,
 * createDirectory, deleteFile, moveFile, ...) are now honored.
 *
 * Mutations go through the shared permission policy + PermissionService so
 * that FileWrite requests respect RuntimeMode, sensitive paths, AllowForSession,
 * and plan mode — exactly like Claude/Codex.
 *
 * Security: all paths are forced under the session cwd via ensureUnderCwd.
 */

export type FsHandleContext = AcpPermissionContext;

const AcpFsParams = Schema.Record(Schema.String, Schema.Unknown);
const decodeAcpFsParams = Schema.decodeUnknownSync(AcpFsParams);

export const isUnderCwd = (requested: string, cwd: string): boolean => {
	const abs = path.resolve(requested);
	const root = path.resolve(cwd);
	return abs === root || abs.startsWith(root + path.sep);
};

export const ensureUnderCwd = (p: string, cwd: string): string => {
	const abs = path.resolve(p);
	if (!isUnderCwd(abs, cwd)) {
		throw new Error(`Path escapes workspace: ${p}`);
	}
	return abs;
};

/**
 * Classify an fs/* mutation (or read) into an FsOp for the shared policy,
 * then request permission (or auto-allow) before performing the operation.
 * Throws on Deny so the JSON-RPC reply to the agent becomes an error.
 *
 * When the permission callbacks are not yet wired by the driver (transitional
 * state), we fall back to auto-allow so existing ACP sessions keep working.
 */
async function ensureFsPermission(
	ctx: FsHandleContext,
	op: FsOp,
	targetPath: string,
): Promise<void> {
	const requestPermission = ctx.requestPermission;
	const getRuntimeMode = ctx.getRuntimeMode;
	const getPermissionMode = ctx.getPermissionMode;

	// Transitional: no permission service wired yet → auto-allow everything.
	if (!requestPermission || !getRuntimeMode) {
		return;
	}

	const runtimeMode = getRuntimeMode();
	const permissionMode = getPermissionMode?.();

	const policy = getFsPolicy(op, targetPath, runtimeMode, permissionMode);

	if (policy.kind === "auto-allow") {
		return;
	}
	if (policy.kind === "auto-deny") {
		throw new Error(`Filesystem ${op} blocked in plan mode: ${targetPath}`);
	}

	// Build the canonical FileWrite kind (we treat create/delete/move as
	// "write" style mutations for the permission system in Phase 1).
	const kind: PermissionKind = { _tag: "FileWrite", path: targetPath };

	const decision = await requestPermission(kind, {
		forcePrompt: policy.forcePrompt,
	});

	if (decision._tag === "Deny") {
		throw new Error(`Permission denied for ${op} on ${targetPath}`);
	}
	// AllowOnce / AllowForSession / AlwaysAllow → proceed
}

const toBase64 = (buf: Buffer): string => buf.toString("base64");

async function handleReadTextFile(
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	const p = decodeAcpFsParams(params).path;
	if (typeof p !== "string") throw new Error("fs/read_text_file: missing path");

	const abs = ensureUnderCwd(p, ctx.cwd);
	// Sensitive reads still go through the gate (forcePrompt path).
	await ensureFsPermission(ctx, "read", abs);

	const data = await fs.readFile(abs, "utf8");

	// The Grok agent has been observed to fail deserializing { dataBase64 }.
	// Return the content in multiple common shapes so at least one works.
	return {
		content: data,
		text: data,
		data: data,
		dataBase64: toBase64(Buffer.from(data)),
	};
}

async function handleReadDirectory(
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	const p = decodeAcpFsParams(params).path;
	if (typeof p !== "string") throw new Error("fs/read_directory: missing path");

	const abs = ensureUnderCwd(p, ctx.cwd);
	// Directory listing is read-only; still let the policy run for future
	// "read-sensitive-dir" rules if we ever add them.
	await ensureFsPermission(ctx, "read", abs);

	const entries = await fs.readdir(abs, { withFileTypes: true });

	// Return in shapes that various ACP clients have been seen to accept
	const list = entries.map((ent) => ({
		name: ent.name,
		isDirectory: ent.isDirectory(),
		isFile: ent.isFile(),
		isSymlink: ent.isSymbolicLink(),
	}));

	return {
		entries: list,
		children: list, // some agents look for this
	};
}

async function handleWriteFile(
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	const decoded = decodeAcpFsParams(params);
	const p = decoded.path;
	if (typeof p !== "string") throw new Error("fs/write_file: missing path");

	const abs = ensureUnderCwd(p, ctx.cwd);

	// Permission gate — may prompt the user and block until decision.
	await ensureFsPermission(ctx, "write", abs);

	const dataB64 = decoded.dataBase64;
	const content = decoded.content;
	const text = decoded.text;
	const data = decoded.data;

	let buf: Buffer;
	if (typeof dataB64 === "string" && dataB64.length > 0) {
		buf = Buffer.from(dataB64, "base64");
	} else if (typeof content === "string") {
		buf = Buffer.from(content, "utf8");
	} else if (typeof text === "string") {
		buf = Buffer.from(text, "utf8");
	} else if (typeof data === "string") {
		buf = Buffer.from(data, "utf8");
	} else {
		throw new Error(
			"fs/write_file: missing data (expected dataBase64, content, text or data)",
		);
	}

	await fs.writeFile(abs, buf);
	return {};
}

async function handleCreateDirectory(
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	const p = decodeAcpFsParams(params).path;
	if (typeof p !== "string")
		throw new Error("fs/create_directory: missing path");

	const abs = ensureUnderCwd(p, ctx.cwd);
	await ensureFsPermission(ctx, "create", abs);
	await fs.mkdir(abs, { recursive: true });
	return {};
}

async function handleDeleteFile(
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	const p = decodeAcpFsParams(params).path;
	if (typeof p !== "string") throw new Error("fs/delete_file: missing path");

	const abs = ensureUnderCwd(p, ctx.cwd);
	await ensureFsPermission(ctx, "delete", abs);
	await fs.rm(abs, { recursive: true, force: true });
	return {};
}

async function handleMoveFile(
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	const decoded = decodeAcpFsParams(params);
	const src = decoded.source ?? decoded.from ?? decoded.path;
	const dst = decoded.destination ?? decoded.to ?? decoded.newPath;
	if (typeof src !== "string" || typeof dst !== "string") {
		throw new Error("fs/move_file: missing source/destination");
	}

	const absSrc = ensureUnderCwd(src, ctx.cwd);
	const absDst = ensureUnderCwd(dst, ctx.cwd);
	// For move we gate on the destination (what is being "created" at the target).
	await ensureFsPermission(ctx, "move", absDst);
	await fs.rename(absSrc, absDst);
	return {};
}

export async function handleFsRequest(
	method: string,
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	try {
		switch (method) {
			case "fs/read_text_file":
			case "fs/readFile":
			case "fs/read_file":
				return await handleReadTextFile(params, ctx);

			case "fs/read_directory":
			case "fs/readDirectory":
			case "fs/list_directory":
			case "fs/read_dir":
				return await handleReadDirectory(params, ctx);

			case "fs/write_text_file":
			case "fs/writeTextFile":
			case "fs/write_file":
			case "fs/writeFile":
				return await handleWriteFile(params, ctx);

			case "fs/create_directory":
			case "fs/createDirectory":
			case "fs/mkdir":
				return await handleCreateDirectory(params, ctx);

			case "fs/delete_file":
			case "fs/deleteFile":
			case "fs/remove":
			case "fs/unlink":
				return await handleDeleteFile(params, ctx);

			case "fs/move_file":
			case "fs/moveFile":
			case "fs/move":
			case "fs/rename":
				return await handleMoveFile(params, ctx);

			default:
				throw new Error(`Method not implemented by Zuse ACP client: ${method}`);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(message);
	}
}
