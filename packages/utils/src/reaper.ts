export class Reaper<K> {
	private readonly deadlines = new Map<K, number>();

	touch(key: K, expiresAt: number): void {
		this.deadlines.set(key, expiresAt);
	}

	remove(key: K): void {
		this.deadlines.delete(key);
	}

	reap(now: number): readonly K[] {
		const expired: K[] = [];
		for (const [key, deadline] of this.deadlines) {
			if (deadline > now) continue;
			this.deadlines.delete(key);
			expired.push(key);
		}
		return expired;
	}
}
