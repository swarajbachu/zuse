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
