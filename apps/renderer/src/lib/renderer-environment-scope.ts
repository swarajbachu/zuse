export const LOCAL_RENDERER_STORAGE_SCOPE = "local";

let activeStorageScope = LOCAL_RENDERER_STORAGE_SCOPE;

export const getActiveEnvironmentStorageScope = (): string =>
	activeStorageScope;

export const setActiveEnvironmentStorageScope = (scope: string): void => {
	activeStorageScope = scope;
};
