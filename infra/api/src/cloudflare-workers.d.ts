/** Runtime module types without replacing this API package's DOM globals. */
declare module "cloudflare:workers" {
	export const WorkerEntrypoint: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.WorkerEntrypoint;
}
