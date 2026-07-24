import { NameProvenance } from "@zuse/contracts";

export const TitleProvenance = NameProvenance;
export type TitleProvenance = typeof NameProvenance.Type;

export const titleProvenanceOrManual = (
	value: TitleProvenance | undefined,
): TitleProvenance => value ?? "manual";
