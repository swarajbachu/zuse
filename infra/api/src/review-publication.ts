import { ReviewFinding, ReviewResult, ReviewSnapshot } from "@zuse/contracts";
import { Schema } from "effect";
import type { ReviewRunRecord } from "./review-domain.ts";
import { reviewMarker } from "./review-domain.ts";
import type { ReviewPublication } from "./review-store.ts";

export interface ReviewGithubRequest {
	readonly method: "GET" | "POST" | "PATCH";
	readonly path: string;
	readonly body?: Readonly<Record<string, unknown>>;
}

export interface ReviewPublicationDependencies {
	/** A control-plane transport with a repository-scoped installation token. */
	readonly request: (request: ReviewGithubRequest) => Promise<unknown>;
	readonly appId: number;
	readonly botUserId: number;
	/** Revalidate lease, enrollment version, delegation, membership and installation. */
	readonly assertCurrent: (
		run: ReviewRunRecord,
		publication: ReviewPublication,
	) => Promise<boolean>;
	/** Trusted output screening; errors and negative verdicts prevent publication. */
	readonly screenOutput: (text: string) => Promise<boolean>;
	/** Trusted HTTPS landing route, never a URL supplied by an agent. */
	readonly fixUrl: (runId: string, findingId?: string) => string;
}

export type ReviewPublicationOutcome =
	| { readonly kind: "delivered"; readonly githubId: string }
	| { readonly kind: "stale"; readonly githubId?: string }
	| { readonly kind: "ambiguous" }
	| { readonly kind: "rejected" };

const record = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
const numericId = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: null;

/** Findings are plain text. Only control-plane templates may introduce Markdown. */
export function reviewPlainText(value: string, maxLength = 4000): string {
	return value
		.slice(0, maxLength)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/&/gu, "&amp;")
		.replace(/</gu, "&lt;")
		.replace(/>/gu, "&gt;")
		.replace(/([\\`*_{}[\]()#+.!|~-])/gu, "\\$1")
		.replace(/@/gu, "@\u200b")
		.replace(/:/gu, ":\u200b");
}

function trustedLink(
	deps: ReviewPublicationDependencies,
	runId: string,
	findingId?: string,
): string {
	const value = deps.fixUrl(runId, findingId);
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		value.length > 2048 ||
		/[\s<>\\()]/u.test(value)
	)
		throw new Error("Invalid review landing URL");
	return value;
}

function sameSnapshot(snapshot: ReviewSnapshot, run: ReviewRunRecord): boolean {
	return (
		snapshot.repositoryId === run.repositoryId &&
		snapshot.baseRef === run.baseRef &&
		snapshot.baseSha === run.baseSha &&
		snapshot.headSha === run.headSha &&
		snapshot.mergeBaseSha === run.mergeBaseSha
	);
}

function prepare(
	publication: ReviewPublication,
	run: ReviewRunRecord,
	deps: ReviewPublicationDependencies,
) {
	if (
		publication.runId !== run.id ||
		publication.marker !== reviewMarker(run.id, publication.id) ||
		run.state !== "publishing" ||
		!run.result ||
		run.fork
	)
		throw new Error("Invalid review publication binding");
	const payload = record(publication.payload);
	const canonical = Schema.decodeUnknownSync(ReviewResult)(run.result);
	if (!sameSnapshot(canonical.snapshot, run))
		throw new Error("Invalid result snapshot");
	if (payload?.kind === "summary") {
		const result = Schema.decodeUnknownSync(ReviewResult)(payload.result);
		if (JSON.stringify(result) !== JSON.stringify(canonical))
			throw new Error("Result does not match durable run");
		const coverage = result.coverage;
		const title =
			result.status === "partial"
				? "Review incomplete"
				: `${result.findings.length} verified findings`;
		const summary = `${result.status === "partial" ? "Partial review" : "Review completed"}. Reviewed ${coverage.reviewedFiles} of ${coverage.eligibleFiles} eligible files; ${coverage.excludedFiles} excluded.\n\n[Open in Zuse](${trustedLink(deps, run.id)})\n\n${publication.marker}`;
		return {
			kind: "summary" as const,
			body: {
				name: "Zuse Review",
				head_sha: run.headSha,
				external_id: publication.id,
				status: "completed",
				conclusion: "neutral",
				output: { title, summary },
			},
			text: summary,
		};
	}
	if (payload?.kind !== "finding") throw new Error("Unknown publication kind");
	const finding = Schema.decodeUnknownSync(ReviewFinding)(payload.finding);
	if (!/^[A-Za-z0-9_-]{1,256}$/u.test(finding.id))
		throw new Error("Invalid finding identity");
	const findingMarker = `<!-- zuse-review-finding:${finding.id} -->`;
	const snapshot = Schema.decodeUnknownSync(ReviewSnapshot)(payload.snapshot);
	if (
		!sameSnapshot(snapshot, run) ||
		!canonical.findings
			.slice(0, 5)
			.some((entry) => JSON.stringify(entry) === JSON.stringify(finding))
	)
		throw new Error("Finding does not match durable run");
	const location = finding.location;
	if (
		location.endLine < location.startLine ||
		location.path.startsWith("/") ||
		location.path.includes("\\") ||
		location.path
			.split("/")
			.some((part) => !part || part === "." || part === "..") ||
		/\p{Cc}/u.test(location.path)
	)
		throw new Error("Invalid finding location");
	const text = `**${reviewPlainText(finding.severity)}: ${reviewPlainText(finding.title, 240)}**\n\n${reviewPlainText(finding.explanation)}\n\nTrigger: ${reviewPlainText(finding.trigger, 2000)}\n\nConsequence: ${reviewPlainText(finding.consequence, 2000)}\n\nReviewed commit: ${run.headSha}. Current location: ${reviewPlainText(location.path)} lines ${location.startLine}–${location.endLine}. Existing discussion anchors are retained across commits.\n\n[Fix in Zuse](${trustedLink(deps, run.id, finding.id)})\n\n${findingMarker}\n${publication.marker}`;
	return {
		kind: "finding" as const,
		findingMarker,
		text,
		body: {
			body: text,
			commit_id: run.headSha,
			path: location.path,
			line: location.endLine,
			side: location.side,
			...(location.startLine !== location.endLine
				? { start_line: location.startLine, start_side: location.side }
				: {}),
		},
	};
}

/** One outbox item per call. Retrying publication has no access to analysis. */
export async function publishReviewPublication(
	publication: ReviewPublication,
	run: ReviewRunRecord,
	deps: ReviewPublicationDependencies,
): Promise<ReviewPublicationOutcome> {
	let prepared: ReturnType<typeof prepare>;
	try {
		prepared = prepare(publication, run, deps);
	} catch {
		return { kind: "rejected" };
	}
	if (
		!numericId(deps.appId) ||
		!numericId(deps.botUserId) ||
		!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(run.repositoryFullName) ||
		!numericId(run.pullNumber)
	)
		return { kind: "rejected" };
	if (!(await deps.screenOutput(prepared.text))) return { kind: "rejected" };
	const repository = `/repos/${run.repositoryFullName}`;
	const comments = `${repository}/pulls/${run.pullNumber}/comments`;
	const current = async () => {
		if (!(await deps.assertCurrent(run, publication))) return false;
		const pull = record(
			await deps.request({
				method: "GET",
				path: `${repository}/pulls/${run.pullNumber}`,
			}),
		);
		const base = record(pull?.base);
		const head = record(pull?.head);
		return (
			pull?.state === "open" &&
			head?.sha === run.headSha &&
			base?.sha === run.baseSha &&
			base?.ref === run.baseRef &&
			record(base?.repo)?.id === run.repositoryId &&
			record(head?.repo)?.id === run.repositoryId
		);
	};
	const reconcile = async (): Promise<{
		id?: string;
		complete: boolean;
		needsUpdate?: boolean;
	}> => {
		for (let page = 1; page <= 20; page++) {
			const path =
				prepared.kind === "summary"
					? `${repository}/commits/${run.headSha}/check-runs?check_name=Zuse%20Review&filter=all&per_page=100&page=${page}`
					: `${comments}?per_page=100&page=${page}`;
			const response = await deps.request({ method: "GET", path });
			const entries =
				prepared.kind === "summary" ? record(response)?.check_runs : response;
			if (!Array.isArray(entries)) return { complete: false };
			const matches = entries.flatMap((entry: unknown) => {
				const item = record(entry);
				const id = numericId(item?.id);
				const own =
					prepared.kind === "summary"
						? record(item?.app)?.id === deps.appId &&
							item?.external_id === publication.id &&
							item?.head_sha === run.headSha &&
							item?.name === "Zuse Review"
						: record(item?.user)?.id === deps.botUserId &&
							typeof item?.body === "string" &&
							(item.body.endsWith(publication.marker) ||
								item.body.includes(`\n${prepared.findingMarker}\n`));
				return id !== null && own
					? [
							{
								id: String(id),
								needsUpdate:
									prepared.kind === "finding" &&
									typeof item?.body === "string" &&
									!item.body.endsWith(publication.marker),
							},
						]
					: [];
			});
			if (matches.length > 1) return { complete: false };
			if (matches[0]) return { ...matches[0], complete: true };
			if (entries.length < 100) return { complete: true };
		}
		return { complete: false };
	};
	if (!(await current())) return { kind: "stale" };
	const remote = await reconcile();
	if (remote.id && !remote.needsUpdate)
		return (await current())
			? { kind: "delivered", githubId: remote.id }
			: { kind: "stale", githubId: remote.id };
	if (
		!remote.complete ||
		(!remote.needsUpdate &&
			(!publication.mayCreate || publication.githubId !== null))
	)
		return { kind: "ambiguous" };
	if (!(await current())) return { kind: "stale" };
	let githubId: string | undefined;
	try {
		const created = record(
			await deps.request({
				method: remote.needsUpdate ? "PATCH" : "POST",
				path: remote.needsUpdate
					? `${repository}/pulls/comments/${remote.id}`
					: prepared.kind === "summary"
						? `${repository}/check-runs`
						: comments,
				body: remote.needsUpdate ? { body: prepared.text } : prepared.body,
			}),
		);
		const id = numericId(created?.id);
		if (id !== null) githubId = String(id);
	} catch {
		// A failed response can follow a successful write; reconcile instead of POSTing again.
	}
	if (!githubId) {
		const recovered = await reconcile();
		if (!recovered.needsUpdate) githubId = recovered.id;
	}
	if (!githubId) return { kind: "ambiguous" };
	return (await current())
		? { kind: "delivered", githubId }
		: { kind: "stale", githubId };
}
