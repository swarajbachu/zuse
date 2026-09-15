export type GitPrProjectionSnapshot<Value> = Readonly<{
	value: Value;
	nextPollAt: number;
}>;

type CheckoutProjectionEntry<Value> = {
	projectionVersion: number;
	prSnapshot: GitPrProjectionSnapshot<Value> | undefined;
	prRefreshAuthority: symbol;
	lastAccessedAt: number;
};

export type GitPrRefreshToken = Readonly<{
	identity: string;
	authority: symbol;
}>;

type GitCheckoutProjectionStateOptions = Readonly<{
	idleTtlMs?: number;
	maxEntries?: number;
	now?: () => number;
}>;

const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 512;

/** Collision-safe identity for an explicit repository checkout. */
export const gitCheckoutIdentity = (
	folderId: string,
	worktreeId: string | null | undefined,
): string => JSON.stringify([folderId, worktreeId ?? null]);

/**
 * Bounded, idle-expiring state for the server's Git workspace projection.
 *
 * Projection versions and PR polling state deliberately share one lifecycle:
 * an inactive checkout cannot leave either map behind, while touching an entry
 * moves it to the end of the Map so the hard bound evicts true LRU state.
 */
export class GitCheckoutProjectionState<Value> {
	private readonly entries = new Map<string, CheckoutProjectionEntry<Value>>();
	private readonly idleTtlMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor(options: GitCheckoutProjectionStateOptions = {}) {
		this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.now = options.now ?? Date.now;
		if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs <= 0) {
			throw new Error("Git checkout projection idle TTL must be positive");
		}
		if (!Number.isInteger(this.maxEntries) || this.maxEntries <= 0) {
			throw new Error("Git checkout projection entry limit must be positive");
		}
	}

	get entryCount(): number {
		this.pruneExpired(this.now());
		return this.entries.size;
	}

	getPrSnapshot(identity: string): GitPrProjectionSnapshot<Value> | undefined {
		return this.touchExisting(identity)?.prSnapshot;
	}

	setPrSnapshot(
		identity: string,
		snapshot: GitPrProjectionSnapshot<Value>,
	): void {
		const entry = this.touchOrCreate(identity);
		entry.prRefreshAuthority = Symbol("git-pr-snapshot");
		entry.prSnapshot = snapshot;
	}

	beginPrRefresh(identity: string): GitPrRefreshToken {
		const entry = this.touchOrCreate(identity);
		const authority = Symbol("git-pr-refresh");
		entry.prRefreshAuthority = authority;
		return { identity, authority };
	}

	commitPrRefresh(
		token: GitPrRefreshToken,
		snapshot: GitPrProjectionSnapshot<Value>,
	): boolean {
		const entry = this.touchExisting(token.identity);
		if (entry === undefined || entry.prRefreshAuthority !== token.authority) {
			return false;
		}
		// Consume the token so one completed RPC can commit at most once.
		entry.prRefreshAuthority = Symbol("git-pr-refresh-settled");
		entry.prSnapshot = snapshot;
		return true;
	}

	nextProjectionVersion(identity: string): number {
		const entry = this.touchOrCreate(identity);
		entry.projectionVersion += 1;
		return entry.projectionVersion;
	}

	private touchExisting(
		identity: string,
	): CheckoutProjectionEntry<Value> | undefined {
		const now = this.now();
		this.pruneExpired(now);
		const entry = this.entries.get(identity);
		if (entry === undefined) return undefined;
		entry.lastAccessedAt = now;
		this.entries.delete(identity);
		this.entries.set(identity, entry);
		return entry;
	}

	private touchOrCreate(identity: string): CheckoutProjectionEntry<Value> {
		const existing = this.touchExisting(identity);
		if (existing !== undefined) return existing;
		const entry: CheckoutProjectionEntry<Value> = {
			projectionVersion: 0,
			prSnapshot: undefined,
			prRefreshAuthority: Symbol("git-pr-snapshot-empty"),
			lastAccessedAt: this.now(),
		};
		this.entries.set(identity, entry);
		this.enforceBound();
		return entry;
	}

	private pruneExpired(now: number): void {
		for (const [identity, entry] of this.entries) {
			if (now - entry.lastAccessedAt < this.idleTtlMs) continue;
			this.entries.delete(identity);
		}
	}

	private enforceBound(): void {
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) return;
			this.entries.delete(oldest);
		}
	}
}
