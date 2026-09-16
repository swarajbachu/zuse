export function orderProjects<T>(
	items: readonly T[],
	order: readonly string[],
	key: (item: T) => string,
): T[] {
	const rank = new Map(order.map((id, index) => [id, index]));
	return [...items].sort(
		(a, b) =>
			(rank.get(key(a)) ?? order.length) - (rank.get(key(b)) ?? order.length),
	);
}

export function moveProject(
	keys: readonly string[],
	from: number,
	offset: number,
): string[] {
	const next = [...keys];
	if (from < 0 || from >= next.length) return next;
	const [key] = next.splice(from, 1);
	if (key === undefined) return next;
	next.splice(Math.max(0, Math.min(next.length, from + offset)), 0, key);
	return next;
}
