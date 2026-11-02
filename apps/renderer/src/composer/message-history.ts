import type { ComposerDraftSnapshot } from "../store/composer-drafts.ts";

/** An editor owns one cursor; snapshots stay fixed while browsing the history. */
export class ComposerMessageHistory {
	private index = -1;
	private draft: ComposerDraftSnapshot | null = null;
	private entries: readonly ComposerDraftSnapshot[] = [];

	get browsing(): boolean {
		return this.index >= 0;
	}
	get unsentDraft(): ComposerDraftSnapshot | null {
		return this.browsing ? this.draft : null;
	}

	reset(): void {
		this.index = -1;
		this.draft = null;
		this.entries = [];
	}

	navigate(
		direction: -1 | 1,
		current: ComposerDraftSnapshot,
		messages: readonly ComposerDraftSnapshot[],
	): ComposerDraftSnapshot | null {
		if (this.index === -1) {
			if (direction === 1 || messages.length === 0) return null;
			this.draft = current;
			this.entries = [...messages].reverse();
		}
		const next = this.index - direction;
		if (next >= this.entries.length) return null;
		const snapshot = next < 0 ? this.draft : this.entries[next];
		if (!snapshot) return null;
		this.index = next;
		return snapshot;
	}
}
