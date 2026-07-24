type VersionedEntity = {
	readonly id: string;
	readonly updatedAt: Date;
};

/**
 * Reconcile RPC receipts and live-stream entities without allowing a slower,
 * older response to overwrite newer state that already reached the renderer.
 */
export const upsertLatestEntity = <Entity extends VersionedEntity>(
	entities: ReadonlyArray<Entity>,
	incoming: Entity,
): ReadonlyArray<Entity> => {
	const existing = entities.find((entity) => entity.id === incoming.id);
	const latest =
		existing !== undefined &&
		existing.updatedAt.getTime() > incoming.updatedAt.getTime()
			? existing
			: incoming;
	return [latest, ...entities.filter((entity) => entity.id !== incoming.id)];
};
