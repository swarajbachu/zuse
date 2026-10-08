import QuickCrypto from "react-native-quick-crypto";

type AlgorithmLike = string | { readonly name?: string } | undefined;
type BufferLike = ArrayBuffer | ArrayBufferView;

const isHmac = (algorithm: AlgorithmLike): boolean =>
	(typeof algorithm === "string"
		? algorithm
		: algorithm?.name
	)?.toUpperCase() === "HMAC";

const bytes = (data: BufferLike): Uint8Array =>
	data instanceof ArrayBuffer
		? new Uint8Array(data)
		: new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

const nodeHash = (key: CryptoKey): string => {
	const hash = (key.algorithm as { hash?: { name?: string } }).hash?.name;
	return (hash ?? "SHA-256").replace("-", "").toLowerCase();
};

/**
 * react-native-quick-crypto 0.7's `subtle.sign`/`verify` reject HMAC (the
 * case is commented out upstream), so durable cloud commands — whose keyed
 * fingerprint is HMAC-SHA256 — could never be enqueued on iOS. Keep the raw
 * key from `importKey` and sign with the native `createHmac` instead.
 */
export const installWebCryptoHmac = (): void => {
	const subtle = globalThis.crypto?.subtle;
	if (subtle === undefined) return;
	const rawKeys = new WeakMap<CryptoKey, Uint8Array>();
	const importKey = subtle.importKey.bind(subtle);
	const sign = subtle.sign.bind(subtle);
	const verify = subtle.verify.bind(subtle);
	const hmac = (key: CryptoKey, data: BufferLike): ArrayBuffer | undefined => {
		const raw = rawKeys.get(key);
		if (raw === undefined) return undefined;
		const digest = QuickCrypto.createHmac(nodeHash(key), raw)
			.update(bytes(data))
			.digest();
		return Uint8Array.from(digest).buffer;
	};
	const patched = {
		importKey: async (...args: Parameters<SubtleCrypto["importKey"]>) => {
			const [format, keyData, algorithm] = args;
			const key = await (importKey as (...a: unknown[]) => Promise<CryptoKey>)(
				...args,
			);
			if (format === "raw" && isHmac(algorithm as AlgorithmLike))
				rawKeys.set(key, Uint8Array.from(bytes(keyData as BufferLike)));
			return key;
		},
		sign: async (
			algorithm: AlgorithmLike,
			key: CryptoKey,
			data: BufferLike,
		): Promise<ArrayBuffer> =>
			(isHmac(algorithm) ? hmac(key, data) : undefined) ??
			(sign as (...a: unknown[]) => Promise<ArrayBuffer>)(algorithm, key, data),
		verify: async (
			algorithm: AlgorithmLike,
			key: CryptoKey,
			signature: BufferLike,
			data: BufferLike,
		): Promise<boolean> => {
			const expected = isHmac(algorithm) ? hmac(key, data) : undefined;
			if (expected === undefined)
				return (verify as (...a: unknown[]) => Promise<boolean>)(
					algorithm,
					key,
					signature,
					data,
				);
			const actual = bytes(signature);
			const want = new Uint8Array(expected);
			if (actual.length !== want.length) return false;
			let diff = 0;
			for (let index = 0; index < want.length; index += 1)
				diff |= (actual[index] ?? 0) ^ (want[index] ?? 0);
			return diff === 0;
		},
	};
	for (const [name, implementation] of Object.entries(patched))
		Object.defineProperty(subtle, name, {
			value: implementation,
			configurable: true,
			writable: true,
		});
};
