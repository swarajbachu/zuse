import { Effect } from "effect";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cloudControlClientForWorkspace } from "../../../src/rpc/api-client";
import { createCloudAuthController } from "../../../src/store/cloud-auth";
import {
	cloudCatalogAtom,
	setCloudCatalogAccount,
	setCloudCatalogWorkspace,
} from "../../../src/store/cloud-catalog";
import { appAtomRegistry } from "../../../src/store/registry";

const api = vi.hoisted(() => ({
	provision: vi.fn(),
	configure: vi.fn(),
	start: vi.fn(),
	poll: vi.fn(),
	cancel: vi.fn(),
	build: vi.fn(),
	seal: vi.fn(),
}));
vi.mock("@zuse/utils/cloud-auth-crypto", () => ({
	sealCloudAuthSecret: api.seal,
}));
vi.mock("~/rpc/api-client", () => ({
	cloudControlClientForWorkspace: vi.fn(() => ({
		"cloud.auth.provision": () => Effect.promise(api.provision),
		"cloud.auth.configure": (input: unknown) =>
			Effect.promise(() => api.configure(input)),
		"cloud.auth.login.start": (input: unknown) =>
			Effect.promise(() => api.start(input)),
		"cloud.auth.login.poll": (input: unknown) =>
			Effect.promise(() => api.poll(input)),
		"cloud.auth.login.cancel": (input: unknown) =>
			Effect.promise(() => api.cancel(input)),
		"cloud.image.build": (input: unknown) =>
			Effect.promise(() => api.build(input)),
	})),
}));
const organizationScope = {
	kind: "organization",
	organizationId: "org_a",
} as const;
const status = {
	authorityState: "ready",
	providers: [],
	encryptionKeyId: "org-key",
	encryptionPublicJwk: { kty: "RSA" },
};
const login = { operationId: "login-1", state: "authorizing" };

describe("workspace-bound Cloud Authentication", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setCloudCatalogAccount(null);
		setCloudCatalogAccount("account-a");
		api.provision.mockReset().mockResolvedValue(status);
		api.configure.mockReset().mockResolvedValue(status);
		api.start.mockReset().mockResolvedValue(login);
		api.poll.mockReset().mockResolvedValue(login);
		api.cancel.mockReset().mockResolvedValue({ ...login, state: "cancelled" });
		api.build.mockReset().mockResolvedValue({ state: "building" });
		api.seal.mockReset().mockResolvedValue("ciphertext");
		appAtomRegistry.update(cloudCatalogAtom, (state) => ({
			...state,
			organizations: [{ id: "org_a", name: "Team A", role: "admin" as const }],
		}));
	});
	test.each([
		{ kind: "personal" } as const,
		organizationScope,
	])("uses the selected scope for every provider and image operation: $kind", async (scope) => {
		setCloudCatalogWorkspace(scope);
		const controller = createCloudAuthController();
		await controller.configure("codex", "subscription", "");
		await controller.poll("login-1");
		await controller.cancel("login-1");
		await controller.updateImage();
		expect(cloudControlClientForWorkspace).toHaveBeenLastCalledWith(scope);
		expect(api.start).toHaveBeenCalledWith({ providerId: "codex" });
		expect(api.poll).toHaveBeenCalledWith({ operationId: "login-1" });
		expect(api.cancel).toHaveBeenCalledWith({ operationId: "login-1" });
		expect(api.build).toHaveBeenCalledWith({
			mode: "update",
			idempotencyKey: expect.any(String),
		});
	});
	test("seals credentials with the organization key and sends no plaintext", async () => {
		setCloudCatalogWorkspace(organizationScope);
		await createCloudAuthController().configure(
			"claude",
			"api-key",
			" secret ",
		);
		expect(api.seal).toHaveBeenCalledWith(status.encryptionPublicJwk, "secret");
		expect(api.configure).toHaveBeenCalledWith({
			providerId: "claude",
			method: "api-key",
			sealedSecret: { keyId: "org-key", ciphertext: "ciphertext" },
		});
	});
	test.each([
		"member",
		"billing",
	] as const)("does not create an authentication client for %s members", (role) => {
		setCloudCatalogWorkspace(organizationScope);
		appAtomRegistry.update(cloudCatalogAtom, (state) => ({
			...state,
			organizations: [{ id: "org_a", name: "Team A", role }],
		}));
		expect(() => createCloudAuthController()).toThrow("access changed");
		expect(cloudControlClientForWorkspace).not.toHaveBeenCalled();
	});
	test("does not configure credentials after switching during encryption, even away and back", async () => {
		setCloudCatalogWorkspace(organizationScope);
		const sealed = Promise.withResolvers<string>();
		api.seal.mockReturnValueOnce(sealed.promise);
		const pending = createCloudAuthController().configure(
			"claude",
			"api-key",
			"secret",
		);
		await vi.waitFor(() => expect(api.seal).toHaveBeenCalled());
		setCloudCatalogWorkspace({ kind: "personal" });
		setCloudCatalogWorkspace(organizationScope);
		sealed.resolve("ciphertext");
		await expect(pending).rejects.toThrow("access changed");
		expect(api.configure).not.toHaveBeenCalled();
	});
	test("a retained controller refuses requests after an administrator is demoted", async () => {
		setCloudCatalogWorkspace(organizationScope);
		const controller = createCloudAuthController();
		appAtomRegistry.update(cloudCatalogAtom, (state) => ({
			...state,
			organizations: [{ id: "org_a", name: "Team A", role: "member" as const }],
		}));
		await expect(controller.updateImage()).rejects.toThrow("access changed");
		await expect(controller.cancel("login-1")).rejects.toThrow(
			"access changed",
		);
		expect(api.build).not.toHaveBeenCalled();
		expect(api.cancel).not.toHaveBeenCalled();
	});
	test("does not encrypt after switching during provisioning", async () => {
		const provisioned = Promise.withResolvers<typeof status>();
		api.provision.mockReturnValueOnce(provisioned.promise);
		const pending = createCloudAuthController().configure(
			"claude",
			"api-key",
			"secret",
		);
		await vi.waitFor(() => expect(api.provision).toHaveBeenCalled());
		setCloudCatalogWorkspace(organizationScope);
		provisioned.resolve(status);
		await expect(pending).rejects.toThrow("access changed");
		expect(api.seal).not.toHaveBeenCalled();
		expect(api.configure).not.toHaveBeenCalled();
	});
	test("rejects late device codes and prevents subsequent polling after an account change", async () => {
		const started = Promise.withResolvers<typeof login>();
		api.start.mockReturnValueOnce(started.promise);
		const controller = createCloudAuthController();
		const pending = controller.configure("codex", "subscription", "");
		await vi.waitFor(() => expect(api.start).toHaveBeenCalled());
		setCloudCatalogAccount("account-b");
		started.resolve(login);
		await expect(pending).rejects.toThrow("access changed");
		await expect(controller.poll("login-1")).rejects.toThrow("access changed");
		expect(api.poll).not.toHaveBeenCalled();
	});
});
