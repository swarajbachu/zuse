import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import { EnvironmentId } from "@zuse/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
import { environmentBelongsToWorkspace } from "../../src/lib/rpc-client.ts";
import {
	getRendererClientBus,
	rendererResourceCacheNamespace,
	resetSessionTimelineClientBusForTest,
} from "../../src/lib/session-timeline-client-bus.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	observeRendererAccount(null);
	resetSessionTimelineClientBusForTest();
});

it("isolates the hosted virtual project catalog on workspace switches without reassigning a laptop", () => {
	vi.stubEnv("VITE_ZUSE_HOSTED", "1");
	observeRendererAccount("catalog-owner");
	const environmentId = EnvironmentId.make("local");
	const key = makeResourceKey<{ owner: string }>("environment-shell", {
		environmentId,
	});
	const bus = getRendererClientBus();
	const personal = rendererResourceCacheNamespace(environmentId);
	bus.snapshot(key);
	bus.overlay(key, {
		initialData: { owner: "personal" },
		update: () => ({ owner: "personal" }),
	});
	expect(bus.snapshot(key).data).toEqual({ owner: "personal" });
	selectRendererWorkspace({ kind: "organization", organizationId: "org-a" });
	expect(environmentBelongsToWorkspace(environmentId)).toBe(true);
	expect(bus.snapshot(key).data).toBeNull();
	const organization = rendererResourceCacheNamespace(environmentId);
	expect(organization).not.toBe(personal);
	selectRendererWorkspace({ kind: "organization", organizationId: "org-b" });
	expect(rendererResourceCacheNamespace(environmentId)).not.toBe(organization);
	vi.stubEnv("VITE_ZUSE_HOSTED", "0");
	// The desktop's own server serves every workspace; its projects record
	// their owner and reads are scoped per project, not per cache namespace.
	expect(environmentBelongsToWorkspace(environmentId)).toBe(true);
	expect(rendererResourceCacheNamespace(environmentId)).toBeUndefined();
});
