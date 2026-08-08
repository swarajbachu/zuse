import type {
	AdvertisedEndpoint,
	PairingStartResult,
	RelayLinkStatus,
	TailnetShareState,
} from "@zuse/contracts";
import { describe, expect, test } from "vitest";

import {
	accountPairingEndpoint,
	bestReadyMethod,
	pairingForMethod,
	pairingWithEndpoint,
	readyMethods,
	tailnetStatusLine,
} from "../../src/lib/remote-access.ts";

const pairing = (code = "ABC123"): PairingStartResult =>
	({
		pairingUrl: "ws://192.168.1.20:4820/rpc",
		browserUrl: `http://192.168.1.20:4820/#pair=${encodeURIComponent(code)}`,
		code,
		qrText: `zuse:///connect/pair?pairingUrl=${encodeURIComponent("ws://192.168.1.20:4820/rpc")}#token=${code}`,
		expiresAt: new Date("2026-08-07T00:05:00.000Z"),
	}) as PairingStartResult;

const endpoint = (
	input: Partial<AdvertisedEndpoint> = {},
): AdvertisedEndpoint =>
	({
		id: "tunnel-1",
		label: "Tunnel",
		providerKind: "tunnel",
		httpBaseUrl: "https://env.example.zusehq.com",
		wsBaseUrl: "wss://env.example.zusehq.com/rpc",
		reachability: "tunnel",
		compatibility: { hostedHttpsApp: "compatible" },
		status: "available",
		isDefault: true,
		...input,
	}) as AdvertisedEndpoint;

const relay = (
	endpoints?: ReadonlyArray<AdvertisedEndpoint>,
): RelayLinkStatus =>
	({
		linked: true,
		heartbeatActive: true,
		advertisedEndpoints: endpoints,
	}) as RelayLinkStatus;

const tailnet = (input: Partial<TailnetShareState> = {}): TailnetShareState =>
	({
		availability: "available",
		enabled: false,
		dnsName: null,
		httpsUrl: null,
		backendState: null,
		port: 4820,
		detail: null,
		approvalUrl: null,
		managedBy: null,
		conflict: null,
		...input,
	}) as TailnetShareState;

const ownedTailnet = tailnet({
	enabled: true,
	dnsName: "mac.tail1234.ts.net",
	managedBy: "this-app",
});

describe("pairing wire format", () => {
	test("locks the frozen device and browser link shapes", () => {
		const rewritten = pairingWithEndpoint(
			pairing("abc 123/+"),
			"https://host.ts.net/",
			"wss://host.ts.net/rpc",
		);
		expect(rewritten.qrText).toBe(
			"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fhost.ts.net%2Frpc#token=abc 123/+",
		);
		expect(rewritten.browserUrl).toBe(
			"https://host.ts.net/#pair=abc%20123%2F%2B",
		);
		expect(rewritten.pairingUrl).toBe("wss://host.ts.net/rpc");
		expect(rewritten.code).toBe("abc 123/+");
	});
});

describe("accountPairingEndpoint", () => {
	test("accepts tunnel and public endpoints that are not unavailable", () => {
		expect(accountPairingEndpoint(relay([endpoint()]))?.id).toBe("tunnel-1");
		expect(
			accountPairingEndpoint(
				relay([endpoint({ reachability: "public", status: "unknown" })]),
			)?.id,
		).toBe("tunnel-1");
	});

	test("rejects lan-only, unavailable, and missing endpoints", () => {
		expect(
			accountPairingEndpoint(relay([endpoint({ reachability: "lan" })])),
		).toBeUndefined();
		expect(
			accountPairingEndpoint(relay([endpoint({ status: "unavailable" })])),
		).toBeUndefined();
		expect(accountPairingEndpoint(relay())).toBeUndefined();
		expect(accountPairingEndpoint(null)).toBeUndefined();
	});
});

describe("pairingForMethod", () => {
	test("rewrites the account link against the advertised endpoint", () => {
		const result = pairingForMethod(
			pairing(),
			"account",
			relay([endpoint()]),
			null,
		);
		expect(result?.qrText).toBe(
			"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fenv.example.zusehq.com%2Frpc#token=ABC123",
		);
		expect(result?.browserUrl).toBe(
			"https://env.example.zusehq.com/#pair=ABC123",
		);
	});

	test("returns null for account when no endpoint exists — never the LAN fallback", () => {
		expect(pairingForMethod(pairing(), "account", relay(), null)).toBeNull();
		expect(pairingForMethod(pairing(), "account", null, null)).toBeNull();
	});

	test("rewrites the tailscale link against the tailnet DNS name", () => {
		const result = pairingForMethod(pairing(), "tailscale", null, ownedTailnet);
		expect(result?.browserUrl).toBe("https://mac.tail1234.ts.net/#pair=ABC123");
		expect(result?.qrText).toBe(
			"zuse:///connect/pair?pairingUrl=wss%3A%2F%2Fmac.tail1234.ts.net%2Frpc#token=ABC123",
		);
	});

	test("returns null for tailscale when disabled, unnamed, or managed by zuse serve", () => {
		expect(pairingForMethod(pairing(), "tailscale", null, null)).toBeNull();
		expect(
			pairingForMethod(
				pairing(),
				"tailscale",
				null,
				tailnet({ enabled: true }),
			),
		).toBeNull();
		expect(
			pairingForMethod(
				pairing(),
				"tailscale",
				null,
				tailnet({
					enabled: true,
					dnsName: "mac.tail1234.ts.net",
					managedBy: "zuse-serve",
				}),
			),
		).toBeNull();
	});

	test("returns the server-issued pairing as-is for local", () => {
		const issued = pairing();
		expect(pairingForMethod(issued, "local", null, null)).toBe(issued);
	});
});

describe("bestReadyMethod", () => {
	test("prefers account, then tailscale, then local", () => {
		expect(
			bestReadyMethod({
				status: relay([endpoint()]),
				tailnet: ownedTailnet,
				networkEnabled: true,
			}),
		).toBe("account");
		expect(
			bestReadyMethod({
				status: relay(),
				tailnet: ownedTailnet,
				networkEnabled: true,
			}),
		).toBe("tailscale");
		expect(
			bestReadyMethod({ status: null, tailnet: null, networkEnabled: true }),
		).toBe("local");
		expect(
			bestReadyMethod({ status: null, tailnet: null, networkEnabled: false }),
		).toBeNull();
	});

	test("never offers a zuse-serve-managed tailnet route", () => {
		const managed = tailnet({
			enabled: true,
			dnsName: "mac.tail1234.ts.net",
			managedBy: "zuse-serve",
		});
		expect(
			bestReadyMethod({ status: null, tailnet: managed, networkEnabled: true }),
		).toBe("local");
		expect(
			bestReadyMethod({
				status: null,
				tailnet: managed,
				networkEnabled: false,
			}),
		).toBeNull();
	});

	test("readyMethods lists every ready method in preference order", () => {
		expect(
			readyMethods({
				status: relay([endpoint()]),
				tailnet: ownedTailnet,
				networkEnabled: true,
			}),
		).toEqual(["account", "tailscale", "local"]);
		expect(
			readyMethods({
				status: relay([endpoint({ status: "unavailable" })]),
				tailnet: tailnet({ enabled: true }),
				networkEnabled: false,
			}),
		).toEqual([]);
	});
});

describe("tailnetStatusLine", () => {
	test("enabled and owned by this app", () => {
		expect(tailnetStatusLine(ownedTailnet)).toEqual({
			description: "Private access at mac.tail1234.ts.net.",
			action: "turn-off",
		});
		expect(tailnetStatusLine(tailnet({ enabled: true }))).toEqual({
			description: "Private access is ready.",
			action: "turn-off",
		});
	});

	test("enabled but managed by zuse serve", () => {
		expect(
			tailnetStatusLine(
				tailnet({
					enabled: true,
					dnsName: "mac.tail1234.ts.net",
					managedBy: "zuse-serve",
				}),
			),
		).toEqual({
			description: "On · Managed by zuse serve.",
			action: "details",
		});
	});

	test("distinguishes a switched-off client from a signed-out client", () => {
		expect(
			tailnetStatusLine(
				tailnet({ availability: "signed-out", backendState: "Stopped" }),
			),
		).toEqual({
			description: "Tailscale is off. Turn it on in the Tailscale app.",
			action: null,
		});
		expect(
			tailnetStatusLine(
				tailnet({ availability: "signed-out", backendState: "NeedsLogin" }),
			),
		).toEqual({
			description: "Open Tailscale and sign in to use private access.",
			action: null,
		});
	});

	test("conflict with an unresponsive previous serve route", () => {
		expect(
			tailnetStatusLine(
				tailnet({
					availability: "conflict",
					conflict: {
						reason: "unresponsive-owner",
						targetPort: 7777,
						canReplace: true,
					},
				}),
			),
		).toEqual({
			description:
				"A previous serve route (port 7777) is no longer responding.",
			action: null,
		});
	});

	test("conflict with a foreign app requires confirmation", () => {
		expect(
			tailnetStatusLine(
				tailnet({
					availability: "conflict",
					conflict: {
						reason: "foreign-app",
						targetPort: 443,
						canReplace: true,
					},
				}),
			),
		).toEqual({
			description: "Tailscale Serve is used by another app (port 443).",
			action: null,
		});
	});

	test("conflict with an unrecognized configuration requires confirmation", () => {
		expect(
			tailnetStatusLine(
				tailnet({
					availability: "conflict",
					conflict: {
						reason: "unrecognized-config",
						targetPort: null,
						canReplace: true,
					},
				}),
			),
		).toEqual({
			description:
				"Tailscale Serve has an existing configuration Zuse doesn’t recognize.",
			action: null,
		});
	});

	test("conflict that cannot be replaced hides the action", () => {
		expect(
			tailnetStatusLine(
				tailnet({
					availability: "conflict",
					conflict: {
						reason: "foreign-app",
						targetPort: null,
						canReplace: false,
					},
				}),
			),
		).toEqual({
			description: "Tailscale Serve is used by another app.",
			action: null,
		});
	});

	test("off and available invites set-up", () => {
		expect(tailnetStatusLine(tailnet())).toEqual({
			description: "Connect privately from devices on the same tailnet.",
			action: "set-up",
		});
		expect(tailnetStatusLine(null)).toEqual({
			description: "Connect privately from devices on the same tailnet.",
			action: "set-up",
		});
	});
});
