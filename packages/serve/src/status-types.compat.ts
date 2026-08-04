import type { ServeStatusV1 as InternalServeStatusV1 } from "@zuse/contracts";

import type { ServeStatusV1 as PublicServeStatusV1 } from "./status-types.ts";

type Assert<T extends true> = T;
type IsExact<A, B> = A extends B ? (B extends A ? true : false) : false;

export type ServeStatusV1ContractCompatibility = Assert<
	IsExact<PublicServeStatusV1, InternalServeStatusV1>
>;
