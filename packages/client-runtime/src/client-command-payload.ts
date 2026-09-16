import { MemoizeRpcs } from "@zuse/contracts";
import { Schema } from "effect";

type PayloadCodec = Readonly<{
	isType: (value: unknown) => boolean;
	decode: (value: unknown) => unknown;
}>;

const payloadCodecs = new Map<string, PayloadCodec>();

const payloadCodec = (kind: string): PayloadCodec => {
	const cached = payloadCodecs.get(kind);
	if (cached !== undefined) return cached;

	const rpc = MemoizeRpcs.requests.get(kind);
	if (rpc === undefined) {
		throw new Error(
			`No RPC payload schema is registered for ClientBus command: ${kind}`,
		);
	}
	const codec = {
		isType: Schema.is(rpc.payloadSchema),
		decode: Schema.decodeUnknownSync(rpc.payloadSchema),
	};
	payloadCodecs.set(kind, codec);
	return codec;
};

/**
 * Restores a retained ClientBus command through its authoritative wire schema.
 * Durable stores use structured clone or JSON, both of which erase
 * `Schema.Class` prototypes. Decoding at the shared executor boundary restores
 * every top-level or nested class and validates malformed persisted data before
 * it reaches an RPC encoder. Unknown command kinds fail closed so a new durable
 * command cannot silently bypass this boundary.
 */
export const rehydrateClientCommandPayload = <Payload>(
	kind: string,
	value: Payload,
): Payload => {
	const codec = payloadCodec(kind);
	return (codec.isType(value) ? value : codec.decode(value)) as Payload;
};
