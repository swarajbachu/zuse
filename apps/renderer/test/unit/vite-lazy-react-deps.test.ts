/// <reference types="node" />

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const rendererFile = (path: string): string =>
	readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("renderer dependency optimization", () => {
	it("freezes the dependency graph before mounting React", () => {
		const viteConfig = rendererFile("vite.config.ts");

		expect(viteConfig).toContain("noDiscovery: true");
		expect(viteConfig).toContain("holdUntilCrawlEnd: true");
		expect(viteConfig).not.toContain('"codemirror"');
	});

	it("keeps the lazy chat list in the initial React dependency graph", () => {
		const chatView = rendererFile("src/components/chat-view.tsx");
		const viteConfig = rendererFile("vite.config.ts");

		expect(chatView).toContain('from "@legendapp/list/react"');
		expect(viteConfig).toContain('"@legendapp/list/react"');
		expect(viteConfig).toContain('"react-dom"');
		expect(viteConfig).toContain('dedupe: ["react", "react-dom"]');
	});

	it("pins i18n and first-paint tooltip into the initial React dependency graph", () => {
		const viteConfig = rendererFile("vite.config.ts");
		const i18nReact = rendererFile("../../packages/i18n/src/react.tsx");
		const tooltip = rendererFile("src/components/ui/tooltip.tsx");

		expect(i18nReact).toContain('from "react-i18next"');
		expect(tooltip).toContain('from "@base-ui/react/tooltip"');
		expect(viteConfig).toContain('"react-i18next"');
		expect(viteConfig).toContain('"i18next"');
		expect(viteConfig).toContain('"@base-ui/react/**"');
	});

	it("prebundles runtime dependencies from renderer and shared UI sources", () => {
		const config = rendererFile("vite.config.ts");
		const include = config.match(/include:\s*\[([\s\S]*?)\]/)?.[1] ?? "";
		const patterns = [...include.matchAll(/"([^"]+)"/g)].flatMap((match) =>
			match[1] ? [match[1]] : [],
		);
		const missing = new Set<string>();
		for (const relativeRoot of [
			"src",
			"../../packages/ui/src",
			"../../packages/i18n/src",
		]) {
			const root = new URL(`../../${relativeRoot}/`, import.meta.url);
			for (const file of readdirSync(root, { recursive: true }) as string[]) {
				if (
					!/\.tsx?$/.test(file) ||
					/\.(test|spec)\./.test(file) ||
					file.endsWith(".d.ts")
				)
					continue;
				const source = ts.createSourceFile(
					file,
					readFileSync(new URL(file, root), "utf8"),
					ts.ScriptTarget.Latest,
					true,
				);
				const check = (specifier: ts.Expression) => {
					if (!ts.isStringLiteral(specifier)) return;
					const name = specifier.text;
					if (
						/^(\.|\/|~|@zuse\/|@repo\/|node:)/.test(name) ||
						/\.(css|woff2?)$/.test(name)
					)
						return;
					if (
						!patterns.some((pattern) =>
							pattern.endsWith("/**")
								? name.startsWith(pattern.slice(0, -2))
								: name === pattern,
						)
					)
						missing.add(`${name} (${resolve(root.pathname, file)})`);
				};
				const visit = (node: ts.Node) => {
					if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
						const bindings = node.importClause?.namedBindings;
						if (
							!(
								bindings &&
								ts.isNamedImports(bindings) &&
								!node.importClause?.name &&
								bindings.elements.every((item) => item.isTypeOnly)
							)
						)
							check(node.moduleSpecifier);
					}
					if (
						ts.isExportDeclaration(node) &&
						!node.isTypeOnly &&
						node.moduleSpecifier
					)
						check(node.moduleSpecifier);
					if (
						ts.isCallExpression(node) &&
						node.expression.kind === ts.SyntaxKind.ImportKeyword &&
						node.arguments[0]
					)
						check(node.arguments[0]);
					ts.forEachChild(node, visit);
				};
				visit(source);
			}
		}
		expect([...missing]).toEqual([]);
	});
});
