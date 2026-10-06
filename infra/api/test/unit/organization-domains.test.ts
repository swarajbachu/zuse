import { ApiPaths } from "@zuse/contracts";
import { Layer, ManagedRuntime, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWorkspaceStoreMemory } from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import {
	routeOrganizationDomainRequest,
	syncDomainAutoJoin,
} from "../../src/organization-domains.ts";
import { routeOrganizationRequest } from "../../src/organizations.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

interface Member {
	id: string;
	user_id: string;
	organization_id: string;
	status: string;
	role: { slug: string };
}
const makeMember = (user: string, org = "org-a", role = "member"): Member => ({
	id: `m-${org}-${user}`,
	user_id: user,
	organization_id: org,
	status: "active",
	role: { slug: role },
});
/** WorkOS users: verified company emails, an unverified one and a personal one. */
const users: Record<string, { email: string; email_verified: boolean }> = {
	user_owner: { email: "owner@acme.dev", email_verified: true },
	user_other_admin: { email: "admin@acme.dev", email_verified: true },
	user_alice: { email: "alice@acme.dev", email_verified: true },
	user_bob: { email: "bob@acme.dev", email_verified: true },
	user_unverified: { email: "eve@acme.dev", email_verified: false },
	user_gmail: { email: "someone@gmail.com", email_verified: true },
};

const makeRuntime = () =>
	ManagedRuntime.make(
		Layer.mergeAll(
			ApiStoreMemory,
			CloudWorkspaceStoreMemory,
			WorkosVerifierTest,
			configurationLayer({
				apiIssuer: "https://api.test",
				workosIssuer: "https://auth.test",
				workosJwksUrl: "unused",
				mintPrivateKey: Redacted.make("unused"),
				mintPublicKey: "unused",
				workosApiKey: Redacted.make("secret"),
				organizationWorkspacesEnabled: true,
			}),
		),
	);

describe("email domain auto-join", () => {
	let runtime: ReturnType<typeof makeRuntime>;
	let members: Member[];
	/** TXT records the fake DNS-over-HTTPS resolver serves. */
	let dnsRecords: Map<string, string>;
	const call = (
		path: string,
		body: unknown,
		accountId = "user_owner",
		org = "org-a",
	) =>
		runtime.runPromise(
			routeOrganizationDomainRequest(
				new Request(`https://api.test${path}`, {
					method: "POST",
					headers: {
						authorization: `Bearer test-token:${accountId}:${org}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			),
		);
	const addDomain = (accountId = "user_owner", org = "org-a") =>
		call(
			ApiPaths.organizationDomainAdd,
			{ organizationId: org, domain: "acme.dev" },
			accountId,
			org,
		);
	/** Publishes the claim's TXT record, then asks Zuse to check it. */
	const verifyDomain = async (
		accountId = "user_owner",
		org = "org-a",
		publish = true,
	) => {
		const settings = await (
			await call(
				ApiPaths.organizationDomains,
				{ organizationId: org },
				accountId,
				org,
			)
		)?.json();
		const claim = settings.domains.find(
			(d: { domain: string }) => d.domain === "acme.dev",
		);
		if (publish) dnsRecords.set(claim.recordName, claim.recordValue);
		return (
			await call(
				ApiPaths.organizationDomainVerify,
				{ organizationId: org, domain: "acme.dev" },
				accountId,
				org,
			)
		)?.json();
	};
	const addVerifiedDomain = async () => {
		await addDomain();
		await verifyDomain();
	};
	const sync = (account: string) =>
		runtime.runPromise(syncDomainAutoJoin(account));
	const active = (account: string) =>
		members.filter((m) => m.user_id === account && m.status === "active");

	beforeEach(() => {
		dnsRecords = new Map();
		members = [
			makeMember("user_owner", "org-a", "admin"),
			makeMember("user_other_admin", "org-b", "admin"),
		];
		runtime = makeRuntime();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string, init?: RequestInit) => {
				const url = new URL(input);
				const method = init?.method ?? "GET";
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				const json = (data: unknown) => new Response(JSON.stringify(data));
				if (url.hostname === "cloudflare-dns.com") {
					const value = dnsRecords.get(url.searchParams.get("name") ?? "");
					return json(
						value === undefined
							? { Status: 3 }
							: { Status: 0, Answer: [{ type: 16, data: `"${value}"` }] },
					);
				}
				if (url.pathname === "/user_management/organization_memberships") {
					if (method === "POST") {
						const member = makeMember(body.user_id, body.organization_id);
						members.push(member);
						return json(member);
					}
					return json({
						data: members.filter(
							(m) =>
								(!url.searchParams.has("user_id") ||
									url.searchParams.get("user_id") === m.user_id) &&
								(!url.searchParams.has("organization_id") ||
									url.searchParams.get("organization_id") ===
										m.organization_id),
						),
						list_metadata: { after: null },
					});
				}
				if (
					url.pathname.startsWith("/user_management/organization_memberships/")
				) {
					const member = members.find(
						(m) => m.id === url.pathname.split("/")[3],
					);
					if (!member) return new Response("{}", { status: 404 });
					if (method === "DELETE") {
						members = members.filter((m) => m !== member);
						return new Response(null, { status: 204 });
					}
					if (url.pathname.endsWith("/deactivate")) member.status = "inactive";
					if (url.pathname.endsWith("/reactivate")) member.status = "active";
					return json(member);
				}
				if (url.pathname === "/user_management/invitations")
					return json({ data: [], list_metadata: { after: null } });
				if (url.pathname.startsWith("/user_management/users/")) {
					const user = users[url.pathname.split("/")[3] ?? ""];
					return user
						? json({ ...user, first_name: null, last_name: null })
						: new Response("{}", { status: 404 });
				}
				if (url.pathname.startsWith("/organizations/"))
					return json({ id: url.pathname.split("/").at(-1), name: "Acme" });
				throw new Error(`Unexpected provider request ${url.pathname}`);
			}),
		);
	});
	afterEach(async () => {
		await runtime.dispose();
		vi.unstubAllGlobals();
	});

	it("lets an admin add their own verified domain and auto-joins teammates once", async () => {
		expect(
			await (
				await call(ApiPaths.organizationDomains, { organizationId: "org-a" })
			)?.json(),
		).toEqual({ domains: [], suggestedDomain: "acme.dev", blockedMembers: [] });
		await addDomain();
		// A claim admits nobody until DNS proves the organization owns the domain.
		await sync("user_alice");
		expect(active("user_alice")).toHaveLength(0);
		expect(await verifyDomain("user_owner", "org-a", false)).toEqual({
			verified: false,
		});
		expect(await verifyDomain()).toEqual({ verified: true });
		await sync("user_alice");
		await sync("user_alice");
		expect(active("user_alice")).toHaveLength(1);
		expect(
			await (
				await call(ApiPaths.organizationDomains, { organizationId: "org-a" })
			)?.json(),
		).toMatchObject({
			domains: [{ domain: "acme.dev", verified: true }],
			suggestedDomain: null,
		});
	});

	it("lets the organization that proves ownership take over an unverified claim", async () => {
		await addDomain("user_other_admin", "org-b");
		await addDomain();
		expect(await verifyDomain()).toEqual({ verified: true });
		await expect(addDomain("user_other_admin", "org-b")).rejects.toMatchObject({
			code: "organization_domain_claimed",
		});
	});

	it("never auto-joins unverified emails or after the domain is turned off", async () => {
		await addVerifiedDomain();
		await sync("user_unverified");
		expect(active("user_unverified")).toHaveLength(0);
		await call(ApiPaths.organizationDomainRemove, {
			organizationId: "org-a",
			domain: "acme.dev",
		});
		await sync("user_alice");
		expect(active("user_alice")).toHaveLength(0);
	});

	it("only allows a domain the admin's verified email proves, once across organizations", async () => {
		await expect(
			call(ApiPaths.organizationDomainAdd, {
				organizationId: "org-a",
				domain: "other.dev",
			}),
		).rejects.toMatchObject({ code: "organization_domain_unverified" });
		await addVerifiedDomain();
		await expect(addDomain("user_other_admin", "org-b")).rejects.toMatchObject({
			code: "organization_domain_claimed",
		});
	});

	it("does not offer or accept personal email domains", async () => {
		members.push(makeMember("user_gmail", "org-a", "admin"));
		expect(
			await (
				await call(
					ApiPaths.organizationDomains,
					{ organizationId: "org-a" },
					"user_gmail",
				)
			)?.json(),
		).toMatchObject({ suggestedDomain: null });
		await expect(
			call(
				ApiPaths.organizationDomainAdd,
				{ organizationId: "org-a", domain: "gmail.com" },
				"user_gmail",
			),
		).rejects.toMatchObject({ code: "organization_domain_unverified" });
	});

	it("blocks rejoining after an admin removal until restored", async () => {
		await addVerifiedDomain();
		await sync("user_alice");
		await runtime.runPromise(
			routeOrganizationRequest(
				new Request(`https://api.test${ApiPaths.organizationRemoveMember}`, {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:user_owner:org-a",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						organizationId: "org-a",
						memberId: "m-org-a-user_alice",
					}),
				}),
			),
		);
		await sync("user_alice");
		expect(active("user_alice")).toHaveLength(0);
		expect(
			await (
				await call(ApiPaths.organizationDomains, { organizationId: "org-a" })
			)?.json(),
		).toMatchObject({
			blockedMembers: [
				{ accountId: "user_alice", displayName: "alice@acme.dev" },
			],
		});
		await call(ApiPaths.organizationDomainRestore, {
			organizationId: "org-a",
			accountId: "user_alice",
		});
		await sync("user_alice");
		expect(active("user_alice")).toHaveLength(1);
	});

	it("skips joining when the organization is full", async () => {
		await addVerifiedDomain();
		for (const user of ["s1", "s2", "s3", "s4"]) members.push(makeMember(user));
		await sync("user_bob");
		expect(active("user_bob")).toHaveLength(0);
	});
});
