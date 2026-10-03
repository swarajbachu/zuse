import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const quoted = (value: string) => {
	if (
		[...value].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) ||
		/[<>]/u.test(value)
	)
		throw new Error("invalid_cloud_git_identity");
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};

/** Install an account-scoped default without changing repository overrides. */
export const configureCloudGitIdentity = async (
	directory: string,
	identity: { readonly name: string; readonly email: string } | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> => {
	const path = join(directory, "git-identity.config");
	const contents =
		identity === undefined
			? ""
			: `[user]\n\tname = ${quoted(identity.name)}\n\temail = ${quoted(identity.email)}\n`;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.next`;
	await writeFile(temporary, contents, { mode: 0o600 });
	await rename(temporary, path);
	const options = { env, timeout: 10_000 };
	const includes = await exec(
		"git",
		["config", "--global", "--get-all", "include.path"],
		options,
	).catch((error: unknown) => {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === 1
		)
			return { stdout: "" };
		throw error;
	});
	if (!includes.stdout.split("\n").includes(path))
		await exec(
			"git",
			["config", "--global", "--add", "include.path", path],
			options,
		);
};
