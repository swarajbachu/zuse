import { Effect, Schema } from "effect";

export const NameProvenance = Schema.Literals([
	"pending",
	"automatic",
	"manual",
]);
export type NameProvenance = typeof NameProvenance.Type;

export const NameProvenanceField = NameProvenance.pipe(
	Schema.withConstructorDefault(Effect.succeed("manual" as const)),
	Schema.withDecodingDefaultType(Effect.succeed("manual" as const)),
);
