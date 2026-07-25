import { randomBytes } from "node:crypto";

import keytar from "keytar";

const KEYCHAIN_SERVICE = "zuse-secure-storage";
const KEYCHAIN_ACCOUNT = "vault-master-key-v1";

let keyPromise: Promise<Buffer> | null = null;

export const secureStorageMasterKey = (
	createIfMissing = true,
): Promise<Buffer> => {
	if (keyPromise !== null) return keyPromise;
	keyPromise = (async () => {
		const existing = await keytar.getPassword(
			KEYCHAIN_SERVICE,
			KEYCHAIN_ACCOUNT,
		);
		if (existing !== null) {
			const decoded = Buffer.from(existing, "base64url");
			if (decoded.byteLength !== 32)
				throw new Error("The secure storage key is invalid.");
			return decoded;
		}
		if (!createIfMissing)
			throw new Error(
				"Secure storage cannot be opened because its master key is missing.",
			);
		const created = randomBytes(32);
		await keytar.setPassword(
			KEYCHAIN_SERVICE,
			KEYCHAIN_ACCOUNT,
			created.toString("base64url"),
		);
		return created;
	})().catch((cause) => {
		keyPromise = null;
		throw cause;
	});
	return keyPromise;
};
