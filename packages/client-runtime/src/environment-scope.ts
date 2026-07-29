export type EnvironmentRoute =
	| {
			readonly environmentId: string;
			readonly kind: "environment";
			readonly resourceId: null;
	  }
	| {
			readonly environmentId: string;
			readonly kind: "chat" | "project";
			readonly resourceId: string;
	  };

const encode = encodeURIComponent;

export const environmentRoute = (
	environmentId: string,
	target?: { readonly threadId?: string; readonly projectId?: string },
): string => {
	const root = `/e/${encode(environmentId)}`;
	if (target?.threadId !== undefined) {
		return `${root}/chat/${encode(target.threadId)}`;
	}
	if (target?.projectId !== undefined) {
		return `${root}/project/${encode(target.projectId)}`;
	}
	return root;
};

export const parseEnvironmentRoute = (
	pathname: string,
): EnvironmentRoute | null => {
	const parts = pathname.split("/").filter(Boolean);
	if (parts[0] !== "e" || parts[1] === undefined) return null;
	const environmentId = decodeURIComponent(parts[1]);
	if (parts.length === 2) {
		return { environmentId, kind: "environment", resourceId: null };
	}
	if (
		(parts[2] === "chat" || parts[2] === "project") &&
		parts[3] !== undefined
	) {
		return {
			environmentId,
			kind: parts[2],
			resourceId: decodeURIComponent(parts[3]),
		};
	}
	return null;
};

export const scopedCacheKey = (
	environmentId: string,
	kind: string,
	id: string,
): string => `${environmentId}:${kind}:${id}`;
