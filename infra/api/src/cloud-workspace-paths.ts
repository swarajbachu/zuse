import type { CloudWorkspaceRecord } from "./cloud-workspace-store.ts";

/** One immutable layout feeds launch, recovery and client access. */
export const cloudWorkspaceLayout = (
	workspace: Pick<CloudWorkspaceRecord, "requestConfig">,
) => {
	const config = workspace.requestConfig;
	const snapshot =
		typeof config.snapshotRevision === "string" ||
		config.providerAuthMode === "snapshot-native";
	if (
		snapshot &&
		(typeof config.runtimeUser !== "string" ||
			!/^[a-z_][a-z0-9_-]{0,31}$/u.test(config.runtimeUser) ||
			config.runtimeUser === "root" ||
			typeof config.runtimeHome !== "string" ||
			!config.runtimeHome.startsWith("/") ||
			/[\0\r\n]/u.test(config.runtimeHome) ||
			typeof config.workspacePath !== "string" ||
			!config.workspacePath.startsWith("/") ||
			/[\0\r\n]/u.test(config.workspacePath))
	)
		throw new Error("Invalid snapshot runtime layout");
	return {
		snapshot,
		user: snapshot ? String(config.runtimeUser) : "zuse",
		home: snapshot ? String(config.runtimeHome) : "/home/zuse",
		sshDirectory: snapshot ? "/var/lib/zuse/ssh" : "/home/zuse/.ssh",
		sshTicket: snapshot
			? "/var/lib/zuse/ssh/ticket"
			: "/home/zuse/.zuse-ssh-ticket",
	};
};

export const cloudWorkspaceRepositoryPath = (
	workspace: Pick<CloudWorkspaceRecord, "requestConfig">,
	repositoryIdentity: string,
) =>
	cloudWorkspaceLayout(workspace).snapshot
		? String(workspace.requestConfig.workspacePath)
		: cloudRepositoryWorkspacePath(repositoryIdentity);

export const cloudWorkspaceLayoutEnvironment = (
	workspace: Pick<CloudWorkspaceRecord, "requestConfig">,
): Readonly<Record<string, string>> => {
	const layout = cloudWorkspaceLayout(workspace);
	return layout.snapshot
		? {
				ZUSE_SNAPSHOT_NATIVE: "1",
				ZUSE_SNAPSHOT_GIT_AUTH_MODE:
					workspace.requestConfig.snapshotGitAuthentication === "zuse"
						? "zuse"
						: "native",
				ZUSE_SSH_DIRECTORY: layout.sshDirectory,
				ZUSE_SSH_TICKET_FILE: layout.sshTicket,
				ZUSE_SSHD_CONFIG_FILE: `${layout.sshDirectory}/sshd_config`,
			}
		: {};
};

export const cloudRepositoryWorkspacePath = (
	repositoryIdentity: string,
): string => {
	const match = /^github\.com\/([^/]+)\/([^/]+)$/iu.exec(repositoryIdentity);
	if (match === null) throw new Error("Unsupported repository identity");
	const owner = match[1] as string;
	const repository = (match[2] as string).replace(/\.git$/iu, "");
	if (
		!/^[-A-Za-z0-9_.]+$/u.test(owner) ||
		!/^[-A-Za-z0-9_.]+$/u.test(repository)
	)
		throw new Error("Unsafe repository identity");
	return `/home/repos/${owner}/${repository}`;
};
