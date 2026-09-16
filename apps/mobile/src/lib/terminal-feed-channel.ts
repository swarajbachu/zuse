type TerminalFeedLease = { valid: boolean };
const terminalFeedLease = Symbol("terminal-feed-lease");

export type TerminalFeed = Readonly<{
	terminalId: string;
	sequence: number;
	value: string;
	readonly [terminalFeedLease]: TerminalFeedLease;
}>;

type TerminalFeedPublication = Readonly<{
	feed: TerminalFeed;
	/** Resolves after React commits this publication to the native view. */
	committed: Promise<void>;
}>;

/** A feed was detached before its bytes reached the matching native surface. */
export class TerminalFeedRevokedError extends Error {
	readonly _tag = "TerminalFeedRevokedError";

	constructor(readonly terminalId: string) {
		super(`Terminal feed was revoked before native commit: ${terminalId}`);
		this.name = "TerminalFeedRevokedError";
	}
}

const TERMINAL_FEED_QUEUE_CHARACTER_LIMIT = 1024 * 1024;

export type TerminalFeedChannel = Readonly<{
	/** Commit-phase authority transition for the native terminal selection. */
	commitSelection: (terminalId: string | null) => void;
	/** Revoke one lease's uncommitted bytes while preserving the selection. */
	revoke: (terminalId: string) => boolean;
	append: (terminalId: string, bytes: string) => TerminalFeedPublication;
	/** Acknowledge bytes only after their feed prop has reached the native view. */
	acknowledge: (feed: TerminalFeed | null) => TerminalFeed | null;
}>;

type PendingFeed = {
	readonly bytes: string;
	readonly sequence: number;
	readonly resolve: () => void;
	readonly reject: (cause: TerminalFeedRevokedError) => void;
};

export const makeTerminalFeedChannel = (
	options: Readonly<{ maxQueuedCharacters?: number }> = {},
): TerminalFeedChannel => {
	const maxQueuedCharacters = Math.max(
		1,
		Math.floor(
			options.maxQueuedCharacters ?? TERMINAL_FEED_QUEUE_CHARACTER_LIMIT,
		),
	);
	let activeTerminalId: string | null = null;
	let activeLease: TerminalFeedLease = { valid: false };
	let sequence = 0;
	let queuedCharacters = 0;
	const pending: PendingFeed[] = [];

	const currentFeed = (): TerminalFeed | null => {
		if (activeTerminalId === null || pending.length === 0) return null;
		const latest = pending.at(-1);
		if (latest === undefined) return null;
		return {
			terminalId: activeTerminalId,
			sequence: latest.sequence,
			value: `${latest.sequence}\u0000${pending
				.map((item) => item.bytes)
				.join("")}`,
			[terminalFeedLease]: activeLease,
		};
	};

	const revokePending = (terminalId: string): void => {
		for (const item of pending.splice(0)) {
			item.reject(new TerminalFeedRevokedError(terminalId));
		}
		queuedCharacters = 0;
	};

	return {
		commitSelection: (terminalId) => {
			if (terminalId === activeTerminalId) return;
			// A detached publication was not rendered by the matching native view.
			// Rejecting its acknowledgement prevents the resource cursor from advancing.
			if (activeTerminalId !== null) revokePending(activeTerminalId);
			activeLease.valid = false;
			activeTerminalId = terminalId;
			activeLease = { valid: terminalId !== null };
			sequence = 0;
		},
		revoke: (terminalId) => {
			if (terminalId !== activeTerminalId) return false;
			revokePending(terminalId);
			activeLease.valid = false;
			activeLease = { valid: true };
			return true;
		},
		append: (terminalId, bytes) => {
			if (terminalId !== activeTerminalId) {
				throw new TerminalFeedRevokedError(terminalId);
			}
			if (queuedCharacters + bytes.length > maxQueuedCharacters) {
				throw new Error("Terminal feed queue capacity exceeded");
			}
			sequence += 1;
			let resolve!: () => void;
			let reject!: (cause: TerminalFeedRevokedError) => void;
			const committed = new Promise<void>((complete, fail) => {
				resolve = complete;
				reject = fail;
			});
			pending.push({ bytes, sequence, resolve, reject });
			queuedCharacters += bytes.length;
			return {
				feed: currentFeed() as TerminalFeed,
				committed,
			};
		},
		acknowledge: (feed) => {
			if (
				feed === null ||
				feed.terminalId !== activeTerminalId ||
				feed[terminalFeedLease] !== activeLease ||
				!activeLease.valid
			) {
				return currentFeed();
			}
			while (true) {
				const next = pending[0];
				if (next === undefined || next.sequence > feed.sequence) break;
				const item = pending.shift();
				if (item === undefined) break;
				queuedCharacters -= item.bytes.length;
				item.resolve();
			}
			return currentFeed();
		},
	};
};

/**
 * React runs a previous resource effect's cleanup before its replacement
 * setup. Stop the old driver first, then revoke exactly its still-active feed
 * lease so queued state cannot reach the replacement native surface.
 */
export const makeTerminalFeedLeaseCleanup = (options: {
	readonly channel: TerminalFeedChannel;
	readonly terminalId: string;
	readonly stopResource: () => void;
	readonly clearFeed: () => void;
}): (() => void) => {
	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		try {
			options.stopResource();
		} finally {
			if (options.channel.revoke(options.terminalId)) options.clearFeed();
		}
	};
};

export const terminalFeedValue = (
	feed: TerminalFeed | null,
	terminalId: string | null,
): string | undefined =>
	feed?.terminalId === terminalId && feed[terminalFeedLease].valid
		? feed.value
		: undefined;
