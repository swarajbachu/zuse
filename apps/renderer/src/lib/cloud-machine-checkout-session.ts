const checkoutSessionKey = (offerId: string): string =>
	`zuse.cloud-machine.checkout.v1:${offerId}`;
const checkoutSessionTtlMs = 30 * 60_000;

type CheckoutSession = Readonly<{
	accountId: string;
	expiresAt: number;
	offerId: string;
	url: string;
}>;

type CheckoutStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export const readCloudMachineCheckoutSession = (
	storage: CheckoutStorage,
	input: {
		readonly accountId: string | null;
		readonly offerId: string;
		readonly nowMs: number;
	},
): string | null => {
	try {
		const raw = storage.getItem(checkoutSessionKey(input.offerId));
		if (raw === null) return null;
		const session = JSON.parse(raw) as Partial<CheckoutSession>;
		if (
			typeof session.accountId !== "string" ||
			typeof session.expiresAt !== "number" ||
			typeof session.offerId !== "string" ||
			typeof session.url !== "string" ||
			session.expiresAt <= input.nowMs
		) {
			storage.removeItem(checkoutSessionKey(input.offerId));
			return null;
		}
		return input.accountId === session.accountId &&
			input.offerId === session.offerId
			? session.url
			: null;
	} catch {
		return null;
	}
};

export const writeCloudMachineCheckoutSession = (
	storage: CheckoutStorage,
	input: {
		readonly accountId: string | null;
		readonly offerId: string;
		readonly nowMs: number;
		readonly url: string;
	},
): void => {
	if (input.accountId === null) return;
	try {
		storage.setItem(
			checkoutSessionKey(input.offerId),
			JSON.stringify({
				accountId: input.accountId,
				expiresAt: input.nowMs + checkoutSessionTtlMs,
				offerId: input.offerId,
				url: input.url,
			} satisfies CheckoutSession),
		);
	} catch {
		// Checkout still works when browser storage is unavailable.
	}
};

export const clearCloudMachineCheckoutSession = (
	storage: CheckoutStorage,
	offerId: string,
): void => {
	try {
		storage.removeItem(checkoutSessionKey(offerId));
	} catch {
		// There is nothing else to clear when browser storage is unavailable.
	}
};
