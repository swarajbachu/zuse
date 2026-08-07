import type { AccountAccessProvider } from "@zuse/contracts";

const INTENT_KEY = "zuse.cloudAccountAccess.intent";
const INTENT_EVENT = "zuse:cloud-account-access-intent";
const supportedProviders = new Set<AccountAccessProvider>([
	"github",
	"claude",
	"codex",
]);

export const requestCloudAccountAccess = (
	storage: Storage,
	target: EventTarget,
	providerId: AccountAccessProvider,
): void => {
	storage.setItem(INTENT_KEY, providerId);
	target.dispatchEvent(new Event(INTENT_EVENT));
};

export const consumeCloudAccountAccessIntent = (
	storage: Storage,
): AccountAccessProvider | null => {
	const persisted = storage.getItem(INTENT_KEY);
	storage.removeItem(INTENT_KEY);
	return supportedProviders.has(persisted as AccountAccessProvider)
		? (persisted as AccountAccessProvider)
		: null;
};

export const subscribeToCloudAccountAccessIntent = (
	storage: Storage,
	target: EventTarget,
	listener: (providerId: AccountAccessProvider) => void,
): (() => void) => {
	const consume = () => {
		const providerId = consumeCloudAccountAccessIntent(storage);
		if (providerId !== null) listener(providerId);
	};
	target.addEventListener(INTENT_EVENT, consume);
	consume();
	return () => target.removeEventListener(INTENT_EVENT, consume);
};
