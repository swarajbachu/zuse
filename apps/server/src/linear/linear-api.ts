import { Schema } from "effect";

const GraphqlEnvelope = Schema.Struct({
	data: Schema.optional(Schema.Unknown),
	errors: Schema.optional(
		Schema.Array(
			Schema.Struct({
				message: Schema.String,
			}),
		),
	),
});

export type LinearFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export class LinearApiError extends Error {
	readonly status: number | null;

	constructor(message: string, status: number | null = null) {
		super(message);
		this.name = "LinearApiError";
		this.status = status;
	}
}

const ISSUE_SUMMARY_FIELDS = `
  nodes {
    id identifier title priority updatedAt url
    state { name type color }
    assignee { name avatarUrl }
    labels { nodes { name } }
  }
  pageInfo { hasNextPage endCursor }
`;

const ASSIGNED_ISSUES_DOCUMENT = `query ZuseLinearIssues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    ${ISSUE_SUMMARY_FIELDS}
  }
}`;

const SEARCH_ISSUES_DOCUMENT = `query ZuseLinearIssueSearch($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    ${ISSUE_SUMMARY_FIELDS}
  }
}`;

export interface LinearIssueListRequest {
	readonly document: string;
	readonly rootField: "issues";
	readonly variables: Readonly<Record<string, unknown>>;
}

export const makeLinearIssueListRequest = (input: {
	readonly query: string;
	readonly viewerId: string;
	readonly after: string | null;
}): LinearIssueListRequest => {
	const query = input.query.trim();
	if (query.length > 0) {
		return {
			document: SEARCH_ISSUES_DOCUMENT,
			rootField: "issues",
			variables: {
				first: 50,
				after: input.after,
				filter: { searchableContent: { contains: query } },
			},
		};
	}
	return {
		document: ASSIGNED_ISSUES_DOCUMENT,
		rootField: "issues",
		variables: {
			first: 50,
			after: input.after,
			filter: {
				assignee: { id: { eq: input.viewerId } },
				state: { type: { nin: ["completed", "canceled"] } },
			},
		},
	};
};

export const linearGraphql = async <A>(
	fetcher: LinearFetch,
	accessToken: string,
	query: string,
	variables: Readonly<Record<string, unknown>>,
): Promise<A> => {
	const request = () =>
		fetcher("https://api.linear.app/graphql", {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
		});
	let response = await request();
	if (response.status === 429) {
		const retryAfterSeconds = Number(response.headers.get("retry-after") ?? 1);
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(Math.max(retryAfterSeconds, 0), 60) * 1_000),
		);
		response = await request();
	}
	const raw = await response.text();
	if (!response.ok) {
		throw new LinearApiError(
			`Linear request failed (${response.status}).`,
			response.status,
		);
	}
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		throw new LinearApiError("Linear returned invalid JSON.", response.status);
	}
	const envelope = Schema.decodeUnknownSync(GraphqlEnvelope)(json);
	if (envelope.errors !== undefined && envelope.errors.length > 0) {
		throw new LinearApiError(
			envelope.errors.map((error) => error.message).join("; "),
			response.status,
		);
	}
	if (envelope.data === undefined) {
		throw new LinearApiError("Linear returned no data.", response.status);
	}
	return envelope.data as A;
};

export interface LinearIssueDocument {
	readonly identifier: string;
	readonly title: string;
	readonly url: string;
	readonly workspaceName: string;
	readonly state: string;
	readonly priorityLabel: string;
	readonly assignee: string | null;
	readonly labels: ReadonlyArray<string>;
	readonly project: string | null;
	readonly cycle: string | null;
	readonly description: string;
	readonly relations: ReadonlyArray<{
		readonly type: string;
		readonly identifier: string;
		readonly title: string;
	}>;
	readonly comments: ReadonlyArray<{
		readonly author: string;
		readonly createdAt: string;
		readonly body: string;
	}>;
	readonly warnings: ReadonlyArray<string>;
}

const metadataLine = (label: string, value: string | null): string | null =>
	value === null || value.length === 0 ? null : `**${label}:** ${value}`;

export const renderLinearIssueMarkdown = (
	issue: LinearIssueDocument,
): string => {
	const lines = [`# ${issue.identifier} — ${issue.title}`, ""];
	const metadata = [
		metadataLine("Workspace", issue.workspaceName),
		metadataLine("URL", issue.url),
		metadataLine("State", issue.state),
		metadataLine("Priority", issue.priorityLabel),
		metadataLine("Assignee", issue.assignee),
		metadataLine(
			"Labels",
			issue.labels.length > 0 ? issue.labels.join(", ") : null,
		),
		metadataLine("Project", issue.project),
		metadataLine("Cycle", issue.cycle),
	].filter((line): line is string => line !== null);
	lines.push(metadata.join(" · "), "");
	if (issue.warnings.length > 0) {
		lines.push("> [!WARNING]", `> ${issue.warnings.join(" ")}`, "");
	}
	lines.push(
		"## Description",
		"",
		issue.description.trim() || "_(no description)_",
		"",
	);
	if (issue.relations.length > 0) {
		lines.push("## Relations", "");
		for (const relation of issue.relations) {
			lines.push(
				`- ${relation.type}: **${relation.identifier}** — ${relation.title}`,
			);
		}
		lines.push("");
	}
	for (const comment of issue.comments) {
		lines.push(
			`## Comment by ${comment.author}`,
			"",
			`_${comment.createdAt}_`,
			"",
			comment.body.trim() || "_(empty comment)_",
			"",
		);
	}
	return `${lines
		.join("\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trimEnd()}\n`;
};

export interface RewrittenMarkdown {
	readonly markdown: string;
	readonly warnings: ReadonlyArray<string>;
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/gu;

export const rewriteMarkdownImages = async (
	markdown: string,
	download: (url: string) => Promise<string | null>,
): Promise<RewrittenMarkdown> => {
	const urls = Array.from(
		markdown.matchAll(MARKDOWN_IMAGE),
		(match) => match[2],
	)
		.filter((url): url is string => url !== undefined)
		.filter((url, index, all) => all.indexOf(url) === index);
	const localByUrl = new Map<string, string | null>();
	const warnings: string[] = [];
	for (const url of urls) {
		try {
			const local = await download(url);
			localByUrl.set(url, local);
			if (local === null) warnings.push(`Could not download image: ${url}`);
		} catch {
			localByUrl.set(url, null);
			warnings.push(`Could not download image: ${url}`);
		}
	}
	return {
		markdown: markdown.replace(
			MARKDOWN_IMAGE,
			(original, alt: string, url: string) => {
				const local = localByUrl.get(url);
				return local === undefined || local === null
					? original
					: `![${alt}](${local})`;
			},
		),
		warnings,
	};
};
