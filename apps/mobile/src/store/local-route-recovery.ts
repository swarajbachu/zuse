// The native route owner rebuilds disposable proxies before RPC retries.
let recover: ((connectionKey: string) => void) | undefined;

export const registerLocalRouteRecovery = (
	handler: (connectionKey: string) => void,
): (() => void) => {
	recover = handler;
	return () => {
		if (recover === handler) recover = undefined;
	};
};

export const recoverLocalRoute = (connectionKey: string): boolean => {
	if (recover === undefined) return false;
	recover(connectionKey);
	return true;
};
