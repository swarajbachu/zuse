import { connect } from "node:net";
import { expect, it } from "vitest";
import {
	isLocal,
	startPublicProxy,
} from "../../src/html-render/public-proxy.ts";

it.each([
	"127.0.0.1",
	"10.0.0.1",
	"169.254.169.254",
	"100.100.100.200",
	"192.168.1.1",
	"172.16.0.1",
	"0.0.0.0",
])("blocks private IPv4 %s", (ip) => expect(isLocal(ip, 4)).toBe(true));
it.each([
	"::1",
	"::ffff:127.0.0.1",
	"fc00::1",
	"fe80::1",
	"64:ff9b::7f00:1",
	"2002:7f00:1::",
])("blocks local and translated IPv6 %s", (ip) =>
	expect(isLocal(ip, 6)).toBe(true));
it("permits public destinations", () => {
	expect(isLocal("1.1.1.1", 4)).toBe(false);
	expect(isLocal("2606:4700:4700::1111", 6)).toBe(false);
});
it("refuses loopback through a real SOCKS connection", async () => {
	const proxy = await startPublicProxy();
	try {
		const result = await new Promise<number>((resolve, reject) => {
			const socket = connect(proxy.port, "127.0.0.1");
			socket.on("error", reject);
			socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
			let greeted = false;
			socket.on("data", (data) => {
				if (!greeted) {
					greeted = true;
					socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]));
				} else {
					resolve(data[1] ?? -1);
					socket.destroy();
				}
			});
		});
		expect(result).toBe(2);
	} finally {
		await proxy.close();
	}
});
