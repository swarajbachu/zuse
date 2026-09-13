import { describe, expect, it } from "vitest";

import {
	containsUnsafeMermaidSource,
	mermaidSecurityConfig,
} from "../../src/mermaid-source-policy.ts";

describe("mermaidSecurityConfig", () => {
	it("locks security settings and returns isolated configuration objects", () => {
		const config = mermaidSecurityConfig();
		expect(config.securityLevel).toBe("strict");
		expect(config.htmlLabels).toBe(false);
		expect(config.suppressErrorRendering).toBe(true);
		expect(config.secure).toEqual(
			expect.arrayContaining([
				"secure",
				"securityLevel",
				"htmlLabels",
				"theme",
				"themeVariables",
				"themeCSS",
			]),
		);
		config.secure.length = 0;
		config.flowchart.htmlLabels = true;
		expect(mermaidSecurityConfig().secure.length).toBeGreaterThan(0);
		expect(mermaidSecurityConfig().flowchart.htmlLabels).toBe(false);
	});
});

describe("containsUnsafeMermaidSource", () => {
	it("rejects constructs that can load external resources", () => {
		const unsafe = [
			'flowchart TD\n  A@{ img: "https://attacker.example/secret.png" }',
			"flowchart TD\n  A@{ icon: 'pack:name' }",
			'%%{init: {"themeCSS": "a { background: url(https://attacker.example) }"}}%%\ngraph TD',
			"graph TD\n  A[url(https://attacker.example)]",
			"graph TD\n  A[@import 'https://attacker.example/style.css']",
			'graph TD\n  A["<img src=https://attacker.example/secret>"]',
			'graph TD\n  A["<style>@import https://attacker.example</style>"]',
			'graph TD\n  A["<i class=resource-bearing>styled</i>"]',
			'graph TD\n  A["</b>"]',
			'graph TD\n  A["&#60;img src=x&#62;"]',
		];

		for (const source of unsafe) {
			expect(containsUnsafeMermaidSource(source), source).toBe(true);
		}
	});

	it("rejects all shape-data forms instead of attempting partial YAML parsing", () => {
		const unsafe = [
			"flowchart TD\n  A@{ shape: rect }",
			'flowchart TD\n  A@{ "img": "https://attacker.example/x" }',
			'flowchart TD\n  A@{ "\\u0069mg": "https://attacker.example/x" }',
			'flowchart TD\n  A@{ "\\u{69}mg": "https://attacker.example/x" }',
			'flowchart TD\n  A@{ "\\x69mg": "https://attacker.example/x" }',
		];

		for (const source of unsafe) {
			expect(containsUnsafeMermaidSource(source), source).toBe(true);
		}
	});

	it("decodes disguised denylisted syntax and fails closed on invalid escapes", () => {
		expect(
			containsUnsafeMermaidSource(
				'%%{init: {"theme\\u0043SS": "body { color: red }"}}%%\ngraph TD',
			),
		).toBe(true);
		expect(
			containsUnsafeMermaidSource('graph TD\n  A["<\\u0069mg src=x>"]'),
		).toBe(true);
		expect(containsUnsafeMermaidSource('graph TD\n  A["\\u{110000}"]')).toBe(
			true,
		);
		expect(() =>
			containsUnsafeMermaidSource('graph TD\n  A["\\UFFFFFFFF"]'),
		).not.toThrow();
		expect(containsUnsafeMermaidSource('graph TD\n  A["\\UFFFFFFFF"]')).toBe(
			true,
		);
	});

	it("allows ordinary diagrams and formatting-only labels", () => {
		const safe = [
			"flowchart TD\n  A[Start] --> B{Choice}",
			'graph TD\n  A["line one<br>line two"]',
			'graph TD\n  A["line one<br/>line two"]',
			'graph TD\n  A["<i>formatted</i>"]',
			"sequenceDiagram\n  Alice->>Bob: a < b and x > y",
			'graph TD\n  A["https://example.com shown as text"]',
		];

		for (const source of safe) {
			expect(containsUnsafeMermaidSource(source), source).toBe(false);
		}
	});
});
