export const rendererProxy = (
	hosted: boolean,
	rpcTarget: string,
): Record<string, { readonly target: string; readonly ws?: boolean }> => ({
	...(hosted ? {} : { "/auth": { target: rpcTarget } }),
	"/assets/attachments": { target: rpcTarget },
	"/assets/site-favicon": { target: rpcTarget },
	"/rpc": { target: rpcTarget, ws: true },
});
