/** Local-only activation protocol for Boxd's memory-preserving account images. */
export const BOXD_RUNTIME_PROTOCOL = 1;
export const BOXD_RUNTIME_DIRECTORY = "/run/zuse-prepared";
export const BOXD_RUNTIME_SOCKET = `${BOXD_RUNTIME_DIRECTORY}/runtime.sock`;
export const BOXD_RUNTIME_COMMAND = "boxd-prepared-runtime";

export interface BoxdRuntimeFile {
	readonly path: string;
	readonly sha256: string;
}

export interface BoxdRuntimeActivation {
	readonly version: typeof BOXD_RUNTIME_PROTOCOL;
	readonly action: "activate";
	readonly env: Readonly<Record<string, string>>;
	readonly bootstrap: string;
	readonly files: ReadonlyArray<BoxdRuntimeFile>;
}

export const BOXD_RUNTIME_COMPILE_CACHE = "/home/zuse/.cache/zuse-node";
