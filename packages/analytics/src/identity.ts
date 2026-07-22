import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";

const ACCOUNT_NAMESPACE = "zuse:analytics:account:v1:";

/** Deterministic across platforms without exposing the upstream account id. */
export const analyticsAccountId = (accountId: string): string =>
	`account_${bytesToHex(sha256(`${ACCOUNT_NAMESPACE}${accountId}`))}`;

export const createAnonymousAnalyticsId = (
	randomUuid: () => string = () => globalThis.crypto.randomUUID(),
): string => `anonymous_${randomUuid()}`;
