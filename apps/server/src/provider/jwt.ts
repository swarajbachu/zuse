/** Decode a JWT payload without verifying its signature. Suitable for display hints only. */
export const decodeJwtPayload = (
	jwt: string,
): Record<string, unknown> | null => {
	try {
		const parts = jwt.split(".");
		if (parts.length !== 3 || !parts[1]) return null;
		return JSON.parse(
			Buffer.from(parts[1], "base64url").toString("utf8"),
		) as Record<string, unknown>;
	} catch {
		return null;
	}
};
