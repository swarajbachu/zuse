import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PermissionKind } from "@zuse/contracts";
import { Schema } from "effect";
import type { AcpPermissionContext } from "../../kernel/acp-permission-context.ts";
import { type FsOp, type FsPolicy, getFsPolicy } from "../../kernel/policy.ts";

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
 * Security: paths are forced under the session cwd, except for an optional
 * exact plan-file scope that is active only while the session is in plan mode.
 * Containment is decided on canonical realpaths, so symlinks inside the
 * workspace cannot smuggle operations outside it.
 */

export type FsHandleContext = AcpPermissionContext;

export interface FsRequestScope {
	/**
	 * Exact provider-owned plan file that may be read or written while the
	 * session is in plan mode. No sibling path or directory access is implied.
	 */
	readonly planFilePath?: string;
}

const AcpFsParams = Schema.Record(Schema.String, Schema.Unknown);
const decodeAcpFsParams = Schema.decodeUnknownSync(AcpFsParams);

/**
 * Lexical-only containment check: normalizes `..` and compares prefixes.
 * Does NOT follow symlinks — a workspace entry like `link -> /outside` passes
 * this check while pointing outside the workspace. Security-sensitive callers
 * must use {@link resolveInsideCwd}, which resolves symlinks via realpath.
 * These helpers remain exported for callers that only need lexical
 * normalization (and for backwards compatibility).
 */
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

export interface ResolvedWorkspacePath {
	/** Lexical absolute path (symlinks NOT resolved). */
	readonly lexical: string;
	/** Canonical path with symlinks resolved by the filesystem. */
	readonly resolved: string;
}

/** Same bound the kernel applies (MAXSYMLINKS) before failing with ELOOP. */
const MAX_SYMLINK_SUBSTITUTIONS = 40;

/**
 * Fully resolve `candidate`, following symlinks. When the tail of the path
 * does not exist yet — e.g. a file about to be created — realpath the nearest
 * existing ancestor and append the remaining segments, so containment is
 * still decided on real filesystem paths rather than the lexical guess.
 *
 * A component that is itself a symlink to a non-existent target (a dangling
 * symlink) is NOT treated as missing: its target is resolved instead. This
 * matters because operations like writeFile follow the link — treating it as
 * "missing" would let a write create the file outside the workspace.
 */
const realpathNearestExisting = async (candidate: string): Promise<string> => {
	const missing: string[] = [];
	let current = candidate;
	let symlinks = 0;
	for (;;) {
		try {
			const real = await fs.realpath(current);
			return missing.length === 0 ? real : path.join(real, ...missing);
		} catch (err) {
			const code = (err as { code?: unknown } | null | undefined)?.code;
			// ENOENT: component missing. ENOTDIR: a non-directory component sits
			// where a directory was expected — the ancestor walk still lands on
			// the real parent, so the containment check stays meaningful.
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
		}

		// `current` could not be canonicalized. If it exists as a dangling
		// symlink, substitute the link target and keep resolving; otherwise it
		// is a genuinely missing component and we resolve its parent instead.
		let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
		try {
			stat = await fs.lstat(current);
		} catch (err) {
			const code = (err as { code?: unknown } | null | undefined)?.code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
		}

		if (stat?.isSymbolicLink()) {
			let target: string | undefined;
			try {
				target = await fs.readlink(current);
			} catch (err) {
				const code = (err as { code?: unknown } | null | undefined)?.code;
				if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
				// The link vanished between lstat and readlink — treat as missing.
			}
			if (target !== undefined) {
				if (++symlinks > MAX_SYMLINK_SUBSTITUTIONS) {
					throw new Error(
						`Too many symbolic link levels while resolving: ${candidate}`,
					);
				}
				current = path.resolve(path.dirname(current), target);
				continue;
			}
		}

		const parent = path.dirname(current);
		if (parent === current) {
			// Reached the filesystem root; nothing else to resolve.
			return candidate;
		}
		missing.unshift(path.basename(current));
		current = parent;
	}
};

/**
 * Resolve `p` under `cwd` following symlinks, returning both the lexical and
 * canonical paths — or null when the canonical path escapes the workspace.
 * Fails closed: if the workspace root itself cannot be resolved, nothing can
 * be verified as contained.
 */
const tryResolveInsideCwd = async (
	p: string,
	cwd: string,
): Promise<ResolvedWorkspacePath | null> => {
	let root: string;
	try {
		root = await fs.realpath(cwd);
	} catch {
		return null;
	}
	const lexical = path.resolve(cwd, p);
	const resolved = await realpathNearestExisting(lexical);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return null;
	}
	return { lexical, resolved };
};

/**
 * Like {@link ensureUnderCwd}, but follows symlinks: a workspace containing
 * `link -> /outside` can no longer smuggle reads, writes, recursive deletes,
 * or process working directories outside the session cwd. Throws
 * `Path escapes workspace` unless the canonical path is the root itself or
 * under it.
 */
export const resolveInsideCwd = async (
	p: string,
	cwd: string,
): Promise<ResolvedWorkspacePath> => {
	const result = await tryResolveInsideCwd(p, cwd);
	if (result === null) {
		throw new Error(`Path escapes workspace: ${p}`);
	}
	return result;
};

const resolveFilePath = async (
	p: string,
	ctx: FsHandleContext,
	scope: FsRequestScope,
): Promise<{
	readonly path: string;
	readonly lexicalPath: string;
	readonly isScopedPlanFile: boolean;
}> => {
	const lexical = path.resolve(ctx.cwd, p);
	const planFilePath = scope.planFilePath;
	const planAbs =
		planFilePath !== undefined ? path.resolve(planFilePath) : undefined;
	const planMode = ctx.getPermissionMode?.() === "plan";

	// The provider-owned plan file may bypass the workspace scope in plan
	// mode. The lexical check runs first so the exception still applies when
	// the workspace root itself cannot be resolved.
	if (planMode && planAbs !== undefined && lexical === planAbs) {
		return { path: lexical, lexicalPath: lexical, isScopedPlanFile: true };
	}

	const contained = await tryResolveInsideCwd(p, ctx.cwd);
	if (contained !== null) {
		return {
			path: contained.resolved,
			lexicalPath: contained.lexical,
			isScopedPlanFile: false,
		};
	}

	// The path escapes (or could not be verified inside) the workspace. The
	// plan file may still match once symlinks are resolved — e.g. aliased
	// /var -> /private/var prefixes on macOS.
	if (planMode && planAbs !== undefined) {
		const [resolvedTarget, resolvedPlan] = await Promise.all([
			realpathNearestExisting(lexical),
			realpathNearestExisting(planAbs),
		]);
		if (resolvedTarget === resolvedPlan) {
			return {
				path: resolvedTarget,
				lexicalPath: lexical,
				isScopedPlanFile: true,
			};
		}
	}

	throw new Error(`Path escapes workspace: ${p}`);
};

/**
 * Merge two policy verdicts for the same operation, biased toward denial:
 * auto-deny wins over everything, then prompt (forcePrompt OR-ed), and only
 * two auto-allows produce an auto-allow.
 */
const mergeFsPolicy = (a: FsPolicy, b: FsPolicy): FsPolicy => {
	if (a.kind === "auto-deny" || b.kind === "auto-deny") {
		return { kind: "auto-deny" };
	}
	if (a.kind === "prompt" || b.kind === "prompt") {
		return {
			kind: "prompt",
			forcePrompt:
				(a.kind === "prompt" && a.forcePrompt) ||
				(b.kind === "prompt" && b.forcePrompt),
		};
	}
	return { kind: "auto-allow" };
};

/**
 * Classify an fs/* mutation (or read) into an FsOp for the shared policy,
 * then request permission (or auto-allow) before performing the operation.
 * Throws on Deny so the JSON-RPC reply to the agent becomes an error.
 *
 * The policy runs on BOTH the agent-supplied lexical path and the resolved
 * canonical path: a symlink can hide a sensitive real target (e.g. an
 * in-workspace `link -> .env`) that the lexical path does not reveal, while
 * the lexical path can still look sensitive on its own.
 *
 * When the permission callbacks are not yet wired by the driver (transitional
 * state), we fall back to auto-allow so existing ACP sessions keep working.
 */
async function ensureFsPermission(
	ctx: FsHandleContext,
	op: FsOp,
	requestedPath: string,
	resolvedPath: string,
): Promise<void> {
	const requestPermission = ctx.requestPermission;
	const getRuntimeMode = ctx.getRuntimeMode;
	const getPermissionMode = ctx.getPermissionMode;

	// Fail closed: with no permission service wired there is nobody to ask,
	// so mutations must not silently pass. Reads may still proceed — they
	// cannot escalate without a mutation anyway.
	if (!requestPermission || !getRuntimeMode) {
		if (op !== "read") {
			throw new Error(
				`Filesystem ${op} blocked: no permission service is wired`,
			);
		}
		return;
	}

	const runtimeMode = getRuntimeMode();
	const permissionMode = getPermissionMode?.();

	const policy = mergeFsPolicy(
		getFsPolicy(op, requestedPath, runtimeMode, permissionMode),
		getFsPolicy(op, resolvedPath, runtimeMode, permissionMode),
	);

	if (policy.kind === "auto-allow") {
		return;
	}
	if (policy.kind === "auto-deny") {
		throw new Error(`Filesystem ${op} blocked in plan mode: ${requestedPath}`);
	}

	// Build the canonical FileWrite kind (we treat create/delete/move as
	// "write" style mutations for the permission system in Phase 1). The
	// resolved path is reported so the prompt shows the real target.
	const kind: PermissionKind = { _tag: "FileWrite", path: resolvedPath };

	const decision = await requestPermission(kind, {
		forcePrompt: policy.forcePrompt,
	});

	if (decision._tag === "Deny") {
		throw new Error(`Permission denied for ${op} on ${requestedPath}`);
	}
	// AllowOnce / AllowForSession / AlwaysAllow → proceed
}

const toBase64 = (buf: Buffer): string => buf.toString("base64");

async function handleReadTextFile(
	params: unknown,
	ctx: FsHandleContext,
	scope: FsRequestScope,
): Promise<unknown> {
	const p = decodeAcpFsParams(params).path;
	if (typeof p !== "string") throw new Error("fs/read_text_file: missing path");

	const resolved = await resolveFilePath(p, ctx, scope);
	const abs = resolved.path;
	// Sensitive reads still go through the gate (forcePrompt path).
	if (!resolved.isScopedPlanFile) {
		await ensureFsPermission(ctx, "read", resolved.lexicalPath, abs);
	}

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

	const { lexical, resolved: abs } = await resolveInsideCwd(p, ctx.cwd);
	// Directory listing is read-only; still let the policy run for future
	// "read-sensitive-dir" rules if we ever add them.
	await ensureFsPermission(ctx, "read", lexical, abs);

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
	scope: FsRequestScope,
): Promise<unknown> {
	const decoded = decodeAcpFsParams(params);
	const p = decoded.path;
	if (typeof p !== "string") throw new Error("fs/write_file: missing path");

	const resolved = await resolveFilePath(p, ctx, scope);
	const abs = resolved.path;

	// Permission gate — may prompt the user and block until decision.
	if (!resolved.isScopedPlanFile) {
		await ensureFsPermission(ctx, "write", resolved.lexicalPath, abs);
	}

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

	const { lexical, resolved: abs } = await resolveInsideCwd(p, ctx.cwd);
	await ensureFsPermission(ctx, "create", lexical, abs);
	await fs.mkdir(abs, { recursive: true });
	return {};
}

async function handleDeleteFile(
	params: unknown,
	ctx: FsHandleContext,
): Promise<unknown> {
	const p = decodeAcpFsParams(params).path;
	if (typeof p !== "string") throw new Error("fs/delete_file: missing path");

	const { lexical, resolved: abs } = await resolveInsideCwd(p, ctx.cwd);
	await ensureFsPermission(ctx, "delete", lexical, abs);
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

	const absSrc = await resolveInsideCwd(src, ctx.cwd);
	const absDst = await resolveInsideCwd(dst, ctx.cwd);
	// For move we gate on the destination (what is being "created" at the target).
	await ensureFsPermission(ctx, "move", absDst.lexical, absDst.resolved);
	await fs.rename(absSrc.resolved, absDst.resolved);
	return {};
}

export async function handleFsRequest(
	method: string,
	params: unknown,
	ctx: FsHandleContext,
	scope: FsRequestScope = {},
): Promise<unknown> {
	try {
		switch (method) {
			case "fs/read_text_file":
			case "fs/readFile":
			case "fs/read_file":
				return await handleReadTextFile(params, ctx, scope);

			case "fs/read_directory":
			case "fs/readDirectory":
			case "fs/list_directory":
			case "fs/read_dir":
				return await handleReadDirectory(params, ctx);

			case "fs/write_text_file":
			case "fs/writeTextFile":
			case "fs/write_file":
			case "fs/writeFile":
				return await handleWriteFile(params, ctx, scope);

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
