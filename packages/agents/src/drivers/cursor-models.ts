import { Cursor } from "@cursor/sdk";

export interface CursorListedModel {
	readonly id: string;
	readonly label: string | null;
}

/**
 * Models the bundled Cursor SDK can run for this API key. Used both by the
 * readiness probe (any model will do) and by the model catalog (the
 * authoritative Cursor inventory).
 */
export const listCursorModels = async (
	apiKey: string,
): Promise<ReadonlyArray<CursorListedModel>> => {
	const models = await Cursor.models.list({ apiKey });
	return models.map((model) => ({
		id: model.id,
		label: model.displayName.length > 0 ? model.displayName : null,
	}));
};
