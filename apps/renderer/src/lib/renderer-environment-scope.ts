import { hostedAccountId, isHostedProduct } from "./hosted-connect.ts";
export const LOCAL_RENDERER_STORAGE_SCOPE = "local";

let activeStorageScope = LOCAL_RENDERER_STORAGE_SCOPE;

export const getActiveEnvironmentStorageScope = (): string =>
	isHostedProduct()
		? `hosted:${hostedAccountId()}:${activeStorageScope}`
		: activeStorageScope;

export const setActiveEnvironmentStorageScope = (scope: string): void => {
	activeStorageScope = scope;
};
