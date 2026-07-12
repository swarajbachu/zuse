import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { chunkSource } from "../../src/chunker/index.ts";

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(eff as Effect.Effect<A, E, never>);

describe("treesitter chunker — typescript", () => {
	it("extracts top-level function symbol + chunk", async () => {
		const src = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
		const result = await run(chunkSource("add.ts", src, "typescript"));
		const symbol = result.symbols.find((s) => s.name === "add");
		expect(symbol).toBeDefined();
		expect(symbol?.kind).toBe("function");
		expect(symbol?.exported).toBe(true);
		const chunk = result.chunks.find((c) => c.symbolName === "add");
		expect(chunk).toBeDefined();
		expect(chunk?.content).toContain("return a + b");
	});

	it("extracts a class plus its methods as nested symbols", async () => {
		const src = `export class Counter {\n  private n = 0;\n  inc() { this.n++; }\n  get value(): number { return this.n; }\n}\n`;
		const result = await run(chunkSource("counter.ts", src, "typescript"));
		const cls = result.symbols.find(
			(s) => s.name === "Counter" && s.kind === "class",
		);
		expect(cls?.exported).toBe(true);
		const inc = result.symbols.find((s) => s.name === "inc");
		expect(inc).toBeDefined();
		expect(inc?.kind).toBe("method");
		expect(inc?.parentIndex).not.toBeNull();
		const methodChunk = result.chunks.find((c) =>
			c.symbolName?.endsWith(".inc"),
		);
		expect(methodChunk).toBeDefined();
	});

	it("extracts interface + type declarations", async () => {
		const src = `export interface Point { x: number; y: number }\nexport type Vector = Point;\n`;
		const result = await run(chunkSource("p.ts", src, "typescript"));
		expect(
			result.symbols.find((s) => s.name === "Point" && s.kind === "interface"),
		).toBeDefined();
		expect(
			result.symbols.find((s) => s.name === "Vector" && s.kind === "type"),
		).toBeDefined();
	});

	it("treats const-arrow as a function symbol", async () => {
		const src = `export const greet = (name: string) => \`hi \${name}\`;\n`;
		const result = await run(chunkSource("g.ts", src, "typescript"));
		const greet = result.symbols.find((s) => s.name === "greet");
		expect(greet).toBeDefined();
		expect(greet?.kind).toBe("function");
		expect(greet?.exported).toBe(true);
	});

	it("falls back to windowed chunks on unknown language", async () => {
		const src = "line 1\nline 2\nline 3\n";
		const result = await run(chunkSource("x.weird", src, "unknown"));
		expect(result.symbols).toHaveLength(0);
		expect(result.chunks.length).toBeGreaterThan(0);
	});

	it("chunks markdown by heading sections", async () => {
		const src = "# Intro\nhello\n# Body\nworld\n## Sub\nmore\n";
		const result = await run(chunkSource("readme.md", src, "markdown"));
		expect(result.chunks.length).toBeGreaterThanOrEqual(2);
		expect(result.chunks[0]?.content).toContain("# Intro");
	});
});
