type RandomUuid = Crypto["randomUUID"];

/**
 * UUID v4 backed by getRandomValues, which browsers expose on plaintext LAN
 * origins even though the convenience randomUUID method is secure-context only.
 */
export const randomUuidV4 = (
	cryptoSource: Pick<Crypto, "getRandomValues">,
): ReturnType<RandomUuid> => {
	const bytes = cryptoSource.getRandomValues(new Uint8Array(16));
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (value) =>
		value.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as ReturnType<RandomUuid>;
};

/** Install the missing secure-context convenience method once for the renderer. */
export const installCryptoRandomUuidCompatibility = (target: Crypto): void => {
	const compatible = target as { randomUUID?: RandomUuid };
	if (typeof compatible.randomUUID === "function") return;
	Object.defineProperty(target, "randomUUID", {
		configurable: true,
		value: () => randomUuidV4(target),
	});
};

installCryptoRandomUuidCompatibility(globalThis.crypto);
