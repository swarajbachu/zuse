import { checkRunFromRollup, type PrCheckRollupEntry } from "./check-runs.ts";
import {
	type GitHubClient,
	type GitHubCredential,
	GitHubFailure,
	type GitHubRepository,
} from "./github-client.ts";
import { GitHubSharedReads } from "./github-shared-read.ts";

type Connection<T> = {
	nodes: T[];
	totalCount?: number;
	pageInfo: { hasNextPage: boolean; endCursor: string | null };
};
type RawCheck = PrCheckRollupEntry & {
	__typename?: string;
	checkSuite?: { app?: { name: string; logoUrl: string } };
};
type CheckConnection = Connection<RawCheck> & {
	checkRunCountsByState?: Array<{ state: string; count: number }>;
	statusContextCountsByState?: Array<{ state: string; count: number }>;
};

export type GitHubPr = {
	id: string;
	number: number;
	state: string;
	url: string;
	additions: number;
	deletions: number;
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	baseRefOid: string;
	isDraft: boolean;
	mergeable: string;
	mergeStateStatus: string;
	isMergeQueueEnabled: boolean;
	autoMergeRequest: { enabledAt: string } | null;
	viewerCanDeleteHeadRef: boolean;
	headRepository: {
		nameWithOwner: string;
		url: string;
		defaultBranchRef: { name: string } | null;
	} | null;
	headRepositoryOwner: { login: string } | null;
	isCrossRepository: boolean;
	baseRepository?: { mergeQueue: { id: string } | null };
	title: string;
	body: string;
	updatedAt: string;
	author: { login: string; avatarUrl: string } | null;
	comments: Connection<{ lastEditedAt: string | null }>;
	reviews: Connection<{ lastEditedAt: string | null }>;
	reviewThreads: { totalCount: number };
	commits: {
		nodes: Array<{
			commit: {
				oid?: string;
				statusCheckRollup: { contexts: CheckConnection } | null;
			};
		}>;
	};
	statusCheckRollup: RawCheck[];
	statusRevision: string;
	remarksRevision: string;
	observedAt: number;
	checksComplete: boolean;
	changedFiles?: number;
};

const IDENTITY = `id number state url headRefName headRefOid baseRefName baseRefOid isDraft
 headRepository { nameWithOwner url defaultBranchRef { name } } headRepositoryOwner { login } isCrossRepository`;
const CHECK_NODES = `__typename ... on CheckRun { name status conclusion detailsUrl checkSuite { app { name logoUrl(size:40) } } }
 ... on StatusContext { context state targetUrl }`;
const EDITS = `comments(first:100,orderBy:{field:UPDATED_AT,direction:DESC}) { totalCount nodes { lastEditedAt } }
 reviews(last:100) { totalCount nodes { lastEditedAt } } reviewThreads { totalCount }`;
const COUNTS = `checkRunCountsByState { state count } statusContextCountsByState { state count }`;
const FINGERPRINT = `${IDENTITY} mergeable mergeStateStatus autoMergeRequest { enabledAt } updatedAt ${EDITS}
 commits(last:1) { nodes { commit { statusCheckRollup { contexts { ${COUNTS} } } } } }`;
const CORE = `${IDENTITY} additions deletions changedFiles title body updatedAt author { login avatarUrl(size:40) }
 mergeable mergeStateStatus isMergeQueueEnabled autoMergeRequest { enabledAt } viewerCanDeleteHeadRef ${EDITS}
 commits(last:1) { nodes { commit { oid statusCheckRollup { contexts(first:100) { ${COUNTS} nodes { ${CHECK_NODES} } pageInfo { hasNextPage endCursor } } } } } }`;

type BatchEntry = {
	signal: AbortSignal;
	selection: string;
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
};

/** Aliases are grouped only under one pinned host/account and priority. */
class GitHubBatch {
	private readonly controllers = new Set<AbortController>();
	private readonly queues = new Map<
		string,
		{
			credential: GitHubCredential;
			entries: BatchEntry[];
			timer: ReturnType<typeof setTimeout>;
			interactive: boolean;
		}
	>();
	constructor(private readonly client: GitHubClient) {}
	read<T>(
		credential: GitHubCredential,
		selection: string,
		signal: AbortSignal,
		interactive: boolean,
		kind: "head" | "pr",
	): Promise<T> {
		const key = `${credential.fingerprint}\0${interactive}\0${kind}`;
		return new Promise<T>((resolve, reject) => {
			const abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			const finish = (value: unknown) => {
				signal.removeEventListener("abort", abort);
				resolve(value as T);
			};
			const fail = (error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			};
			let queue = this.queues.get(key);
			if (!queue) {
				queue = {
					credential,
					entries: [],
					interactive,
					timer: setTimeout(
						() => this.flush(key),
						kind === "pr" ? 10 : interactive ? 50 : 500,
					),
				};
				this.queues.set(key, queue);
			}
			queue.entries.push({ signal, selection, resolve: finish, reject: fail });
			if (queue.entries.length >= (kind === "head" && interactive ? 50 : 25))
				this.flush(key);
		});
	}
	private flush(key: string): void {
		const queue = this.queues.get(key);
		if (!queue) return;
		clearTimeout(queue.timer);
		this.queues.delete(key);
		queue.entries = queue.entries.filter((entry) => !entry.signal.aborted);
		if (!queue.entries.length) return;
		const controller = new AbortController();
		this.controllers.add(controller);
		const abort = () => {
			if (queue.entries.every((entry) => entry.signal.aborted))
				controller.abort();
		};
		for (const entry of queue.entries)
			entry.signal.addEventListener("abort", abort, { once: true });
		const query = `query { ${queue.entries.map((entry, i) => `p${i}: ${entry.selection}`).join("\n")} }`;
		void this.client
			.graphql<Record<string, unknown>>(
				queue.credential,
				query,
				{},
				controller.signal,
				queue.interactive,
			)
			.then(
				(data) =>
					queue.entries.forEach((entry, i) => {
						if (!data || !(`p${i}` in data))
							entry.reject(
								new GitHubFailure(
									"unknown",
									"GitHub returned an incomplete batch.",
								),
							);
						else entry.resolve(data[`p${i}`]);
					}),
				(error) => {
					for (const entry of queue.entries) entry.reject(error);
				},
			)
			.finally(() => {
				this.controllers.delete(controller);
				for (const entry of queue.entries)
					entry.signal.removeEventListener("abort", abort);
			});
	}
	close(): void {
		for (const controller of this.controllers) controller.abort();
		this.controllers.clear();
		for (const queue of this.queues.values()) {
			clearTimeout(queue.timer);
			for (const entry of queue.entries)
				entry.reject(new GitHubFailure("offline", "GitHub client stopped."));
		}
		this.queues.clear();
	}
}

const repositorySelection = (repo: GitHubRepository, inner: string): string =>
	`repository(owner:${JSON.stringify(repo.owner)},name:${JSON.stringify(repo.repo)}) { ${inner} }`;
const prefix = (repo: GitHubRepository): string =>
	`repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;

export function prRevisions(pr: GitHubPr): {
	statusRevision: string;
	remarksRevision: string;
} {
	const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
	return {
		statusRevision: JSON.stringify([
			pr.state,
			pr.isDraft,
			pr.mergeable,
			pr.mergeStateStatus,
			pr.autoMergeRequest,
			pr.headRefOid,
			pr.baseRefOid,
			pr.updatedAt,
			contexts?.checkRunCountsByState,
			contexts?.statusContextCountsByState,
		]),
		remarksRevision: JSON.stringify([
			pr.updatedAt,
			pr.comments,
			pr.reviews,
			pr.reviewThreads,
		]),
	};
}

type CachedPr = {
	value: GitHubPr;
	at: number;
	fingerprintAt: number;
	etags: Map<string, string>;
	supported: boolean;
};

export class GitHubPullRequests {
	private readonly batch: GitHubBatch;
	private readonly discovery = new Map<
		string,
		{ number: number | null; at: number }
	>();
	private readonly cache = new Map<string, CachedPr>();
	private readonly reads = new GitHubSharedReads();
	private epoch = 0;
	private readonly authorities = new Map<string, symbol>();
	private readonly fileCache = new Map<
		string,
		Array<{ path: string; additions: number; deletions: number }>
	>();
	private readonly activity = new Map<
		string,
		{
			revision: string;
			at: number;
			value: Awaited<ReturnType<GitHubPullRequests["readFeedback"]>>;
		}
	>();
	constructor(readonly client: GitHubClient) {
		this.batch = new GitHubBatch(client);
	}
	private trim(): void {
		for (const map of [
			this.discovery,
			this.cache,
			this.activity,
			this.authorities,
		])
			while (map.size > 512) map.delete(map.keys().next().value ?? "");
	}

	async discover(
		repo: GitHubRepository,
		branch: string,
		signal: AbortSignal,
		interactive = true,
		force = false,
		headOwner?: string,
	): Promise<number | null> {
		const credential = await this.client.credential(repo, signal);
		const key = `${credential.fingerprint}\0${repo.owner}/${repo.repo}\0${branch}\0${headOwner ?? ""}`;
		return this.reads.run(
			`discover:${key}:${interactive}:${force}`,
			signal,
			async (signal) => {
				const cached = this.discovery.get(key);
				if (!force && cached && this.client.now - cached.at < 120_000)
					return cached.number;
				const result = await this.batch
					.read<{
						pullRequests: Connection<GitHubPr>;
					} | null>(
						credential,
						repositorySelection(
							repo,
							`pullRequests(headRefName:${JSON.stringify(branch)},states:[OPEN,CLOSED,MERGED],first:100,orderBy:{field:CREATED_AT,direction:DESC}) { nodes { ${IDENTITY} } pageInfo { hasNextPage endCursor } }`,
						),
						signal,
						interactive,
						"head",
					)
					.catch(async (error) => {
						// Only discovery has a compatible REST shape. Mutations never enter this path.
						if (
							!(error instanceof GitHubFailure) ||
							(error.kind !== "rate_limited" &&
								!/doesn.t exist|undefinedField|unknown field/i.test(
									error.message,
								))
						)
							throw error;
						const pulls = await this.client.pages<{
							number: number;
							state: string;
							merged_at: string | null;
							head: { ref: string; user: { login: string } | null };
						}>(
							credential,
							`repos/${repo.owner}/${repo.repo}/pulls?state=all&sort=created&direction=desc&head=${encodeURIComponent(`${headOwner ?? repo.owner}:${branch}`)}`,
							signal,
						);
						return {
							pullRequests: {
								nodes: pulls.map(
									(pull) =>
										({
											number: pull.number,
											state:
												pull.state === "open"
													? "OPEN"
													: pull.merged_at
														? "MERGED"
														: "CLOSED",
											headRepositoryOwner: pull.head.user,
										}) as GitHubPr,
								),
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						};
					});
				if (!result)
					throw new GitHubFailure(
						"access",
						"GitHub repository is unavailable to this account.",
					);
				const nodes = result.pullRequests.nodes.filter(
					(pr) =>
						!headOwner ||
						pr.headRepositoryOwner?.login.toLowerCase() ===
							headOwner.toLowerCase(),
				);
				const number =
					(nodes.find((pr) => pr.state === "OPEN") ?? nodes[0])?.number ?? null;
				if (number === null && result.pullRequests.pageInfo.hasNextPage)
					throw new GitHubFailure(
						"unknown",
						"GitHub branch discovery is incomplete.",
					);
				this.discovery.set(key, { number, at: this.client.now });
				this.trim();
				return number;
			},
		);
	}

	async fingerprint(
		repo: GitHubRepository,
		number: number,
		credential: GitHubCredential,
		signal: AbortSignal,
		interactive: boolean,
	): Promise<GitHubPr> {
		const result = await this.batch.read<{
			pullRequest: GitHubPr | null;
		} | null>(
			credential,
			repositorySelection(
				repo,
				`pullRequest(number:${number}) { ${FINGERPRINT} }`,
			),
			signal,
			interactive,
			"pr",
		);
		if (!result?.pullRequest)
			throw new GitHubFailure(
				"access",
				"GitHub pull request is unavailable to this account.",
			);
		return result.pullRequest;
	}

	async read(
		repo: GitHubRepository,
		number: number,
		signal: AbortSignal,
		options: { interactive?: boolean; force?: boolean } = {},
	): Promise<GitHubPr> {
		const credential = await this.client.credential(repo, signal);
		const key = `${credential.fingerprint}\0${repo.owner}/${repo.repo}\0${number}`;
		const interactive = options.interactive ?? true;
		return this.reads.run(
			`${key}\0${interactive}\0${options.force ?? false}`,
			signal,
			(readSignal) =>
				this.readPinned(
					repo,
					number,
					credential,
					readSignal,
					key,
					interactive,
					options.force ?? false,
				),
		);
	}

	private async readPinned(
		repo: GitHubRepository,
		number: number,
		credential: GitHubCredential,
		signal: AbortSignal,
		key: string,
		interactive: boolean,
		force: boolean,
	): Promise<GitHubPr> {
		const epoch = this.epoch;
		const authority = Symbol("github-pr-read");
		this.authorities.set(key, authority);
		let cached = this.cache.get(key);
		if (!force && cached) {
			if (this.client.now - cached.fingerprintAt >= 120_000) {
				const fingerprint = await this.fingerprint(
					repo,
					number,
					credential,
					signal,
					interactive,
				);
				const revisions = prRevisions(fingerprint);
				cached.fingerprintAt = this.client.now;
				if (revisions.statusRevision !== cached.value.statusRevision)
					cached = undefined;
				else {
					cached.value = {
						...cached.value,
						...revisions,
						observedAt: this.client.now,
					};
					if (
						!interactive &&
						cached.value.mergeable !== "UNKNOWN" &&
						!cached.value.statusCheckRollup.some(
							(c) => checkRunFromRollup(c).status !== "completed",
						)
					)
						return cached.value;
				}
			}
			if (
				cached &&
				cached.value.mergeable !== "UNKNOWN" &&
				!cached.value.statusCheckRollup.some(
					(check) => checkRunFromRollup(check).status !== "completed",
				) &&
				this.client.now - cached.at < 5 * 60_000 &&
				(await this.revalidate(
					repo,
					number,
					credential,
					signal,
					cached,
					interactive,
				))
			)
				return { ...cached.value, observedAt: this.client.now };
		}
		const result = await this.batch.read<{
			pullRequest: GitHubPr | null;
		} | null>(
			credential,
			repositorySelection(repo, `pullRequest(number:${number}) { ${CORE} }`),
			signal,
			interactive,
			"pr",
		);
		if (!result?.pullRequest)
			throw new GitHubFailure(
				"access",
				"GitHub pull request is unavailable to this account.",
			);
		const pr = result.pullRequest;
		const context = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
		if (context && (!Array.isArray(context.nodes) || !context.pageInfo))
			throw new GitHubFailure(
				"unknown",
				"GitHub returned incomplete check data.",
			);
		const checks = [...(context?.nodes ?? [])];
		let cursor = context?.pageInfo;
		for (let page = 1; cursor?.hasNextPage; page++) {
			if (page >= 100 || !cursor.endCursor)
				throw new GitHubFailure(
					"unknown",
					"GitHub checks pagination is incomplete.",
				);
			const next = await this.client.graphql<{
				repository: {
					pullRequest: { headRefOid: string };
					object: { statusCheckRollup: { contexts: Connection<RawCheck> } };
				};
			}>(
				credential,
				`query($owner:String!,$repo:String!,$number:Int!,$oid:GitObjectID!,$cursor:String!) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { headRefOid } object(oid:$oid) { ... on Commit { statusCheckRollup { contexts(first:100,after:$cursor) { nodes { ${CHECK_NODES} } pageInfo { hasNextPage endCursor } } } } } } }`,
				{
					owner: repo.owner,
					repo: repo.repo,
					number,
					oid: pr.headRefOid,
					cursor: cursor.endCursor,
				},
				signal,
				interactive,
			);
			if (next.repository.pullRequest.headRefOid !== pr.headRefOid)
				throw new GitHubFailure(
					"unknown",
					"Pull request head changed while reading checks. Refresh to retry.",
				);
			const connection = next.repository.object.statusCheckRollup.contexts;
			checks.push(...connection.nodes);
			cursor = connection.pageInfo;
		}
		const value = {
			...pr,
			...prRevisions(pr),
			statusCheckRollup: checks,
			checksComplete: true,
			observedAt: this.client.now,
		};
		signal.throwIfAborted();
		if (epoch !== this.epoch || this.authorities.get(key) !== authority)
			throw new GitHubFailure(
				"unknown",
				"GitHub observation was superseded. Refresh to retry.",
			);
		const expectedChecks = [
			...(context?.checkRunCountsByState ?? []),
			...(context?.statusContextCountsByState ?? []),
		].reduce((count, group) => count + group.count, 0);
		if (
			(context && expectedChecks !== checks.length) ||
			(pr.commits.nodes[0]?.commit.oid &&
				pr.commits.nodes[0]?.commit.oid !== pr.headRefOid)
		)
			throw new GitHubFailure(
				"unknown",
				"GitHub check data changed during pagination. Refresh to retry.",
			);
		this.cache.set(key, {
			value,
			at: this.client.now,
			fingerprintAt: this.client.now,
			etags:
				cached?.value.headRefOid === value.headRefOid
					? cached.etags
					: new Map(),
			supported: cached?.supported ?? true,
		});
		this.trim();
		return value;
	}

	private async revalidate(
		repo: GitHubRepository,
		number: number,
		credential: GitHubCredential,
		signal: AbortSignal,
		cached: CachedPr,
		interactive: boolean,
	): Promise<boolean> {
		if (!cached.supported) return false;
		let unchanged = true;
		const paths = [
			`${prefix(repo)}/pulls/${number}`,
			`${prefix(repo)}/commits/${cached.value.headRefOid}/check-runs?filter=all`,
			`${prefix(repo)}/commits/${cached.value.headRefOid}/status`,
		];
		try {
			for (const [index, path] of paths.entries()) {
				for (let page = 1; page <= 100; page++) {
					const endpoint =
						index === 0
							? path
							: `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
					const response = await this.client.request({
						credential,
						api: "rest",
						path: endpoint,
						etag: cached.etags.get(endpoint),
						signal,
						interactive,
					});
					if (response.status !== 304) unchanged = false;
					const etag = response.headers.get("etag");
					if (!etag) {
						cached.supported = false;
						return false;
					}
					cached.etags.set(endpoint, etag);
					if (
						index === 0 &&
						response.status !== 304 &&
						JSON.parse(response.body).head?.sha !== cached.value.headRefOid
					) {
						cached.etags.clear();
						return false;
					}
					// The Link header is not guaranteed on a 304: retain page shape with validators.
					const nextKey = `${endpoint}\0next`;
					if (response.status !== 304)
						cached.etags.set(
							nextKey,
							/rel="next"/.test(response.headers.get("link") ?? "")
								? "yes"
								: "no",
						);
					if (index === 0 || cached.etags.get(nextKey) !== "yes") break;
					if (page === 100)
						throw new GitHubFailure(
							"unknown",
							"GitHub checks pagination is incomplete.",
						);
				}
			}
			return unchanged;
		} catch (error) {
			if (
				error instanceof GitHubFailure &&
				[404, 405, 410, 415, 422].includes(error.status ?? 0)
			) {
				cached.supported = false;
				return false;
			}
			throw error;
		}
	}

	async feedback(
		repo: GitHubRepository,
		pr: GitHubPr,
		signal: AbortSignal,
	): Promise<Awaited<ReturnType<GitHubPullRequests["readFeedback"]>>> {
		const credential = await this.client.credential(repo, signal);
		const key = `${credential.fingerprint}\0${repo.owner}/${repo.repo}\0${pr.number}`;
		const cached = this.activity.get(key);
		if (
			cached?.revision === pr.remarksRevision &&
			this.client.now - cached.at < 30 * 60_000
		)
			return cached.value;
		const value = await this.readFeedback(repo, pr.number, credential, signal);
		this.activity.set(key, {
			value,
			revision: pr.remarksRevision,
			at: this.client.now,
		});
		this.trim();
		return value;
	}

	private async readFeedback(
		repo: GitHubRepository,
		number: number,
		credential: GitHubCredential,
		signal: AbortSignal,
	) {
		const root = `${prefix(repo)}`;
		const [comments, inline, reviews, threads] = await Promise.all([
			this.client.pages(
				credential,
				`${root}/issues/${number}/comments`,
				signal,
			),
			this.client.pages(credential, `${root}/pulls/${number}/comments`, signal),
			this.client.pages(credential, `${root}/pulls/${number}/reviews`, signal),
			this.graphqlPages(
				repo,
				credential,
				`query($owner:String!,$repo:String!,$number:Int!,$endCursor:String) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) { reviewThreads(first:100,after:$endCursor) { nodes { isResolved isOutdated comments(first:1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } } }`,
				{ number },
				(data) =>
					(
						data as {
							repository: {
								pullRequest: { reviewThreads: Connection<unknown> };
							};
						}
					).repository.pullRequest.reviewThreads,
				signal,
			),
		]);
		return { comments, inline, reviews, threads };
	}

	async graphqlPages(
		repo: GitHubRepository,
		credential: GitHubCredential,
		query: string,
		variables: Record<string, unknown>,
		connection: (data: unknown) => Connection<unknown>,
		signal: AbortSignal,
	): Promise<unknown[]> {
		const pages: unknown[] = [];
		let endCursor: string | null = null;
		for (let page = 0; page < 100; page++) {
			const data: unknown = await this.client.graphql(
				credential,
				query,
				{ owner: repo.owner, repo: repo.repo, ...variables, endCursor },
				signal,
			);
			pages.push({ data });
			const info: Connection<unknown>["pageInfo"] = connection(data).pageInfo;
			if (!info.hasNextPage) return pages;
			if (!info.endCursor || info.endCursor === endCursor) break;
			endCursor = info.endCursor;
		}
		throw new GitHubFailure("unknown", "GitHub pagination is incomplete.");
	}

	async files(
		repo: GitHubRepository,
		pr: GitHubPr,
		signal: AbortSignal,
	): Promise<Array<{ path: string; additions: number; deletions: number }>> {
		const credential = await this.client.credential(repo, signal);
		const key = `${credential.fingerprint}\0${repo.owner}/${repo.repo}\0${pr.number}\0${pr.headRefOid}\0${pr.baseRefOid}`;
		const cached = this.fileCache.get(key);
		if (cached) return cached;
		const files = await this.client.pages<{
			filename: string;
			additions: number;
			deletions: number;
		}>(credential, `${prefix(repo)}/pulls/${pr.number}/files`, signal);
		if (pr.changedFiles !== undefined && files.length !== pr.changedFiles)
			throw new GitHubFailure(
				"unknown",
				"GitHub files pagination is incomplete.",
			);
		const head = await this.client.rest<{ head: { sha: string } }>(
			credential,
			`${prefix(repo)}/pulls/${pr.number}`,
			signal,
		);
		if (head.head.sha !== pr.headRefOid)
			throw new GitHubFailure(
				"unknown",
				"Pull request head changed while reading files. Refresh to retry.",
			);
		const value = files.map((file) => ({ ...file, path: file.filename }));
		if (value.length <= 1000) {
			if (this.fileCache.size >= 128)
				this.fileCache.delete(this.fileCache.keys().next().value ?? "");
			this.fileCache.set(key, value);
		}
		return value;
	}

	async list(
		repo: GitHubRepository,
		type: "pr" | "issue",
		signal: AbortSignal,
	): Promise<unknown[]> {
		const credential = await this.client.credential(repo, signal);
		const field = type === "pr" ? "pullRequests" : "issues";
		const selection =
			type === "pr"
				? `${IDENTITY} title updatedAt author { login }`
				: `number title state updatedAt author { login } labels(first:100) { nodes { name } }`;
		const result = await this.client.graphql<{
			repository: Record<
				string,
				{ nodes: Array<{ labels?: { nodes: unknown[] } }> }
			>;
		}>(
			credential,
			`query($owner:String!,$repo:String!) { repository(owner:$owner,name:$repo) { ${field}(first:50,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}) { nodes { ${selection} } } } }`,
			{ owner: repo.owner, repo: repo.repo },
			signal,
		);
		if (!result.repository)
			throw new GitHubFailure(
				"access",
				"GitHub repository is unavailable to this account.",
			);
		return (result.repository[field]?.nodes ?? []).map((row) => ({
			...row,
			...(row.labels ? { labels: row.labels.nodes } : {}),
		}));
	}

	invalidate(): void {
		this.epoch++;
		this.authorities.clear();
		this.discovery.clear();
		this.cache.clear();
		this.activity.clear();
		this.fileCache.clear();
	}
	close(): void {
		this.reads.close();
		this.batch.close();
		this.invalidate();
	}
}
