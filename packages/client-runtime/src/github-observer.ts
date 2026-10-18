import {
	type GitHubObservation,
	type GitHubObserveRequest,
	GitHubTarget,
} from "@zuse/contracts";
import { emptyPr } from "@zuse/git/github-pr-info";
import { GitHubSharedReads } from "@zuse/git/github-shared-read";
import { Schema } from "effect";
import { isRpcAccessDenied, isRpcCredentialExpired } from "./connection.ts";

export type GitHubRead = (
	input: GitHubObserveRequest,
	signal: AbortSignal,
) => Promise<GitHubObservation>;
export type GitHubView = Readonly<{
	value: GitHubObservation | null;
	error: string | null;
	updatedAt: number | null;
	detailsError?: string | null;
	detailsPending?: boolean;
}>;
export const emptyGitHubView: GitHubView = {
	value: null,
	error: null,
	updatedAt: null,
};
type Entry = {
	target: GitHubTarget;
	view: GitHubView;
	listeners: Set<() => void>;
	pending?: Promise<void>;
	controller?: AbortController;
	timer?: ReturnType<typeof setTimeout>;
	failures: number;
	activeSubscribers: number;
	detailsRevision?: string;
};

const abortableRead = <A>(
	signal: AbortSignal,
	read: () => Promise<A>,
): Promise<A> =>
	new Promise((resolve, reject) => {
		signal.throwIfAborted();
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		let pending: Promise<A>;
		try {
			pending = read();
		} catch (error) {
			signal.removeEventListener("abort", onAbort);
			reject(error);
			return;
		}
		void pending
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", onAbort));
	});

/** One account-scoped observer shared by surfaces; its lifetime does not follow a runtime socket. */
export class GitHubObserver {
	private readonly detailsReads = new GitHubSharedReads();
	private readonly entries = new Map<string, Entry>();
	constructor(
		private readonly read: GitHubRead,
		private readonly load?: (target: GitHubTarget) => GitHubObservation | null,
	) {}
	key(target: GitHubTarget): string {
		return JSON.stringify([
			target.host,
			target.owner,
			target.repo,
			target.branch,
			target.headOwner,
			target.number,
			target.headSha,
		]);
	}
	private entry(target: GitHubTarget): Entry {
		const key = this.key(target);
		let entry = this.entries.get(key);
		if (!entry) {
			if (this.entries.size >= 256) {
				for (const [id, candidate] of this.entries) {
					if (candidate.listeners.size === 0 && !candidate.pending) {
						this.entries.delete(id);
						break;
					}
				}
			}
			entry = {
				target,
				view: (() => {
					const cached = this.load?.(target);
					return cached
						? {
								value: { ...cached, pr: { ...cached.pr, stale: true } },
								error: null,
								updatedAt: cached.pr.observedAt?.getTime() ?? null,
							}
						: emptyGitHubView;
				})(),
				listeners: new Set(),
				failures: 0,
				activeSubscribers: 0,
			};
			this.entries.set(key, entry);
		}
		return entry;
	}
	snapshot(target: GitHubTarget): GitHubView {
		return this.entry(target).view;
	}
	subscribe(
		target: GitHubTarget,
		listener: () => void,
		active = true,
	): () => void {
		const entry = this.entry(target);
		entry.listeners.add(listener);
		if (active) entry.activeSubscribers++;
		if (active && !entry.pending && !entry.timer) void this.refresh(target);
		return () => {
			entry.listeners.delete(listener);
			if (active) entry.activeSubscribers--;
			if (!entry.activeSubscribers) {
				clearTimeout(entry.timer);
				entry.timer = undefined;
				entry.controller?.abort();
			}
		};
	}
	refresh(target: GitHubTarget, force = false): Promise<void> {
		const entry = this.entry(target);
		if (entry.pending) return entry.pending;
		clearTimeout(entry.timer);
		entry.timer = undefined;
		const controller = new AbortController();
		entry.controller = controller;
		const timeout = setTimeout(
			() => controller.abort(new Error("GitHub request timed out.")),
			30_000,
		);
		entry.pending = (async () => {
			try {
				const value = await abortableRead(controller.signal, () =>
					this.read({ target, force }, controller.signal),
				);
				if (
					controller.signal.aborted ||
					this.entries.get(this.key(target)) !== entry
				)
					return;
				if (value.pr.stale) {
					const denied =
						value.pr.prCapability === "authentication" ||
						value.pr.prCapability === "access";
					const previous = entry.view.value;
					entry.view = {
						value:
							!denied && previous
								? {
										...previous,
										pr: {
											...previous.pr,
											stale: true,
											prCapability: value.pr.prCapability,
											observationError: value.pr.observationError,
											retryAt: value.pr.retryAt,
										},
									}
								: value,
						error:
							value.pr.observationError ?? "GitHub is temporarily unavailable.",
						updatedAt: entry.view.updatedAt,
					};
					entry.failures++;
				} else {
					entry.view = {
						...entry.view,
						value: {
							...value,
							details:
								entry.view.value?.pr.url === value.pr.url
									? (entry.view.value?.details ?? null)
									: null,
						},
						error: null,
						updatedAt: Date.now(),
					};
					entry.failures = 0;
				}
			} catch (error) {
				if (this.entries.get(this.key(target)) !== entry) return;
				if (
					controller.signal.aborted &&
					controller.signal.reason?.name === "AbortError"
				)
					return;
				const capability = isRpcAccessDenied(error)
					? "access"
					: isRpcCredentialExpired(error)
						? "authentication"
						: controller.signal.aborted
							? "timeout"
							: "unknown";
				const denied =
					capability === "access" || capability === "authentication";
				const message =
					capability === "access"
						? "Zuse denied access to GitHub status."
						: capability === "authentication"
							? "Your Zuse connection has expired. Reconnect to refresh GitHub status."
							: error instanceof Error
								? error.message
								: "GitHub refresh failed. Retry to refresh status.";
				const previous = denied ? null : entry.view.value;
				entry.view = {
					...entry.view,
					error: message,
					value: {
						...(previous ?? { details: null }),
						pr: {
							...(previous?.pr ?? emptyPr(target.branch, capability)),
							stale: true,
							prCapability: capability,
							observationError: message,
							retryAt: null,
						},
					},
				};
				entry.failures++;
			} finally {
				clearTimeout(timeout);
				entry.pending = undefined;
				entry.controller = undefined;
				if (this.entries.get(this.key(target)) === entry) {
					for (const listener of entry.listeners) listener();
					if (entry.activeSubscribers)
						entry.timer = setTimeout(
							() => {
								entry.timer = undefined;
								void this.refresh(target);
							},
							Math.max(
								(entry.view.value?.pr.retryAt?.getTime() ?? 0) - Date.now(),
								entry.failures
									? Math.min(300_000, 30_000 * 2 ** Math.min(entry.failures, 4))
									: 60_000,
							),
						);
				}
			}
		})();
		return entry.pending;
	}
	async details(
		target: GitHubTarget,
		signal: AbortSignal,
		force = false,
	): Promise<GitHubObservation> {
		const entry = this.entry(target);
		const revision = (value: GitHubObservation | null) =>
			JSON.stringify([
				value?.pr.url,
				value?.pr.headSha,
				value?.pr.statusRevision,
				value?.pr.remarksRevision,
			]);
		if (
			!force &&
			entry.view.value?.details &&
			!entry.view.detailsError &&
			entry.detailsRevision === revision(entry.view.value)
		)
			return entry.view.value;
		return this.detailsReads.run(
			`${this.key(target)}:${force}`,
			signal,
			async (sharedSignal) => {
				entry.view = { ...entry.view, detailsPending: true };
				for (const listener of entry.listeners) listener();
				try {
					const requestSignal = AbortSignal.any([
						sharedSignal,
						AbortSignal.timeout(30_000),
					]);
					const result = await abortableRead(requestSignal, () =>
						this.read({ target, details: true, force }, requestSignal),
					);
					if (
						this.entries.get(this.key(target)) !== entry ||
						sharedSignal.aborted
					)
						return result;
					const denied =
						result.pr.prCapability === "authentication" ||
						result.pr.prCapability === "access";
					const previous = entry.view.value;
					if (
						!result.pr.stale &&
						previous &&
						(previous.pr.prCapability === "authentication" ||
							previous.pr.prCapability === "access" ||
							(revision(previous) !== revision(result) &&
								(previous.pr.observedAt?.getTime() ?? 0) >
									(result.pr.observedAt?.getTime() ?? 0)))
					)
						return result;

					entry.view = {
						...entry.view,
						value: denied
							? result
							: {
									...(previous ?? result),
									details: result.pr.stale
										? (previous?.details ?? null)
										: result.details,
								},
						detailsError: result.pr.stale
							? (result.pr.observationError ??
								"GitHub details could not be refreshed.")
							: null,
					};
					if (!result.pr.stale) entry.detailsRevision = revision(result);
					for (const listener of entry.listeners) listener();
					return result;
				} catch (error) {
					if (
						this.entries.get(this.key(target)) === entry &&
						!sharedSignal.aborted
					) {
						entry.view = {
							...entry.view,
							detailsError:
								error instanceof Error
									? error.message
									: "GitHub details could not be refreshed.",
						};
						for (const listener of entry.listeners) listener();
					}
					throw error;
				} finally {
					if (this.entries.get(this.key(target)) === entry) {
						entry.view = { ...entry.view, detailsPending: false };
						for (const listener of entry.listeners) listener();
					}
				}
			},
		);
	}

	clear(): void {
		this.detailsReads.close();
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const entry of entries) {
			clearTimeout(entry.timer);
			entry.controller?.abort();
			for (const listener of entry.listeners) listener();
		}
	}
}
/** Retained cloud metadata lets a first observation run while the sandbox is paused. */
export const githubTargetFromSummary = (
	summary: { repositoryIdentity: string; branch: string } | null | undefined,
): GitHubTarget | null => {
	if (!summary) return null;
	const [host, owner, repo] = summary.repositoryIdentity.split("/");
	try {
		return Schema.decodeUnknownSync(GitHubTarget)({
			host,
			owner,
			repo,
			branch: summary.branch,
		});
	} catch {
		return null;
	}
};
