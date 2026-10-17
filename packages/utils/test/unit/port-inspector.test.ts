import { describe, expect, it } from "vitest";
import {
	parseLsofListeners,
	parseNetstatListeners,
	parseProcListeners,
	parseSsListeners,
} from "../../src/port-inspector.js";
import { parseWindowsTcpListeners } from "../../src/port-inspector.ts";

describe("listening server parsers", () => {
	it("excludes all runtime ports, including anonymous bridge listeners", () => {
		const output = [
			"LISTEN 0 511 10.0.0.2:34903 0.0.0.0:*",
			'LISTEN 0 511 127.0.0.1:34903 0.0.0.0:* users:(("node",pid=379,fd=1))',
			'LISTEN 0 511 127.0.0.1:3001 0.0.0.0:* users:(("next-server",pid=3812,fd=2))',
		].join("\n");
		expect(parseSsListeners(output, 379)).toEqual([
			{ name: "next-server", port: 3001, loopbackOnly: true },
		]);
	});
	it("parses Linux ss output and deduplicates ports", () => {
		const result = parseSsListeners(
			[
				'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=1))',
				'LISTEN 0 128 [::1]:8080 [::]:* users:(("bun",pid=13,fd=2))',
				'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=3))',
			].join("\n"),
		);
		expect(result).toEqual([
			{ name: "node", port: 3000, loopbackOnly: true },
			{ name: "bun", port: 8080, loopbackOnly: true },
		]);
	});

	it("classifies wildcard binds as reachable beyond loopback", () => {
		const result = parseSsListeners(
			[
				'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=12,fd=1))',
				'LISTEN 0 128 [::]:5173 [::]:* users:(("vite",pid=13,fd=2))',
				'LISTEN 0 128 *:8080 *:* users:(("bun",pid=14,fd=3))',
			].join("\n"),
		);
		expect(result).toEqual([
			{ name: "node", port: 3000, loopbackOnly: false },
			{ name: "vite", port: 5173, loopbackOnly: false },
			{ name: "bun", port: 8080, loopbackOnly: false },
		]);
	});

	it("clears loopbackOnly when any listener on the port is non-loopback", () => {
		const result = parseSsListeners(
			[
				'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=12,fd=1))',
				'LISTEN 0 511 [::]:3000 [::]:* users:(("node",pid=12,fd=2))',
			].join("\n"),
		);
		expect(result).toEqual([{ name: "node", port: 3000, loopbackOnly: false }]);
	});

	it("keeps the existing macOS and Windows parser contracts", () => {
		expect(
			parseLsofListeners(
				"COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 1 u 1u IPv4 1 0t0 TCP 127.0.0.1:4173",
			),
		).toEqual([{ name: "node", port: 4173, loopbackOnly: true }]);
		expect(
			parseLsofListeners(
				"COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 1 u 1u IPv4 1 0t0 TCP *:3000 (LISTEN)",
			),
		).toEqual([{ name: "node", port: 3000, loopbackOnly: false }]);
		expect(
			parseNetstatListeners(
				"  TCP    127.0.0.1:9229    0.0.0.0:0    LISTENING",
			),
		).toEqual([{ name: "localhost", port: 9229, loopbackOnly: true }]);
		expect(
			parseNetstatListeners("  TCP    0.0.0.0:8000    0.0.0.0:0    LISTENING"),
		).toEqual([{ name: "localhost", port: 8000, loopbackOnly: false }]);
	});

	it("parses /proc/net/tcp listeners with loopback classification", () => {
		const tcp = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1",
			"   1: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2",
			"   2: 0100007F:0BB9 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000        0 3",
		].join("\n");
		const tcp6 = [
			"  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 00000000000000000000000001000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4",
			"   1: 00000000000000000000000000000000:22B8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5",
		].join("\n");
		expect(parseProcListeners(`${tcp}\n${tcp6}`)).toEqual([
			{ name: "localhost", port: 3000, loopbackOnly: true },
			{ name: "localhost", port: 5432, loopbackOnly: true },
			{ name: "localhost", port: 8000, loopbackOnly: false },
			{ name: "localhost", port: 8888, loopbackOnly: false },
		]);
	});
});

it("recognizes localized Windows listeners without including established sockets", () => {
	const output = `TCP 127.0.0.1:5733 0.0.0.0:0 ABHÖREN 42
TCP [::]:5733 [::]:0 ÉCOUTE 43
TCP 127.0.0.1:5733 127.0.0.1:6000 ESTABLISHED 44
TCP 127.0.0.1:57330 0.0.0.0:0 LISTENING 45`;
	expect(
		parseWindowsTcpListeners(output)
			.filter((item) => item.port === 5733)
			.map((item) => item.pid),
	).toEqual([42, 43]);
	expect(
		parseNetstatListeners(output).find((item) => item.port === 5733)
			?.loopbackOnly,
	).toBe(false);
});
