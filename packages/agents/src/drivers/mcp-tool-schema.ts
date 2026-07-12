export type JsonSchemaObject = Record<string, unknown>;

export const objectSchema = (
	properties: JsonSchemaObject,
	required: ReadonlyArray<string> = [],
): JsonSchemaObject => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

export const stringProp = (description: string): JsonSchemaObject => ({
	type: "string",
	description,
});

export const booleanProp = (description: string): JsonSchemaObject => ({
	type: "boolean",
	description,
});

export const numberProp = (
	description: string,
	maximum?: number,
): JsonSchemaObject => ({
	type: "number",
	description,
	...(maximum === undefined ? {} : { maximum }),
});
