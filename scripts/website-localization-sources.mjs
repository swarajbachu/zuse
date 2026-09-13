import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
/** Follow the actual landing-page import graph so new sections enter the copy check. */
export function websiteLocalizationSources() {
	const files = new Set();
	const visit = (file) => {
		if (
			files.has(file) ||
			!file.startsWith(resolve(root, "apps/web/components"))
		)
			return;
		files.add(file);
		const ast = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		);
		for (const statement of ast.statements) {
			if (!ts.isImportDeclaration(statement)) continue;
			const name = statement.moduleSpecifier.text;
			const base = name.startsWith("@/")
				? resolve(root, "apps/web", name.slice(2))
				: name.startsWith(".")
					? resolve(dirname(file), name)
					: null;
			if (!base) continue;
			const next = [
				base,
				`${base}.tsx`,
				`${base}.ts`,
				`${base}/index.tsx`,
				`${base}/index.ts`,
			].find((path) => existsSync(path) && statSync(path).isFile());
			if (next) visit(next);
		}
	};
	for (const path of ["landing/page.tsx", "navbar.tsx", "footer/index.tsx"])
		visit(resolve(root, "apps/web/components", path));
	return [...files]
		.filter((file) => file.endsWith(".tsx"))
		.map((file) => relative(root, file))
		.sort();
}
