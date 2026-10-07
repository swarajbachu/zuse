import Parser from "tree-sitter";

import type {
	LanguageId,
	ParsedChunk,
	ParsedSymbol,
	ParseResult,
	SymbolKind,
} from "../types.ts";

/**
 * Lazy grammar loader. We don't import the grammar packages at module load
 * because each one pulls a native .node binding — for a workspace that
 * never has any TSX files we'd still pay the dlopen. `getParser` caches
 * a `Parser` per language after the first hit.
 */
const parsers = new Map<LanguageId, Parser>();

const loadParser = (lang: LanguageId): Parser | null => {
	const cached = parsers.get(lang);
	if (cached) return cached;
	const parser = new Parser();
	try {
		switch (lang) {
			case "typescript": {
				const mod = require("tree-sitter-typescript");
				parser.setLanguage(mod.typescript);
				break;
			}
			case "tsx": {
				const mod = require("tree-sitter-typescript");
				parser.setLanguage(mod.tsx);
				break;
			}
			case "javascript":
			case "jsx": {
				const mod = require("tree-sitter-javascript");
				parser.setLanguage(mod);
				break;
			}
			default:
				return null;
		}
	} catch {
		return null;
	}
	parsers.set(lang, parser);
	return parser;
};

interface CollectedSymbol extends ParsedSymbol {
	/** index into `symbols` once flattened */
	readonly _id: number;
	readonly _parentId: number | null;
}

interface CollectedChunk extends ParsedChunk {
	readonly _symbolId: number | null;
}

/**
 * Tree-sitter chunker + symbol extractor for the JS/TS family. One pass
 * over the tree: top-level declarations become chunks, class methods
 * become nested chunks, and an `export` wrapper marks the inner declaration
 * exported. Refs are NOT extracted in Phase A (deferred — `refs` table
 * stays empty; spec says tree-sitter scope queries land in Phase E or
 * later when the LSP-vs-ts-morph question is decided).
 */
export const treesitterChunker = (
	source: string,
	lang: LanguageId,
): ParseResult => {
	const parser = loadParser(lang);
	if (!parser) return { chunks: [], symbols: [] };

	const tree = parser.parse(source);
	const root = tree.rootNode;

	const symbols: CollectedSymbol[] = [];
	const chunks: CollectedChunk[] = [];

	const lineCount = source.split(/\r?\n/).length;

	const addSymbol = (
		name: string,
		kind: SymbolKind,
		signature: string | null,
		startLine: number,
		endLine: number,
		exported: boolean,
		parentId: number | null,
	): number => {
		const id = symbols.length;
		symbols.push({
			_id: id,
			_parentId: parentId,
			name,
			kind,
			signature,
			startLine,
			endLine,
			exported,
			parentIndex: parentId,
		});
		return id;
	};

	const addChunk = (
		kind: ParsedChunk["kind"],
		startLine: number,
		endLine: number,
		content: string,
		symbolId: number | null,
		symbolName: string | undefined,
	) => {
		if (startLine < 1) startLine = 1;
		if (endLine < startLine) endLine = startLine;
		if (endLine > lineCount) endLine = lineCount;
		chunks.push({
			_symbolId: symbolId,
			kind,
			startLine,
			endLine,
			content,
			symbolName,
		});
	};

	const nameOf = (node: Parser.SyntaxNode): string | null => {
		const named = node.childForFieldName("name");
		if (named) return named.text;
		return null;
	};

	const signatureOf = (node: Parser.SyntaxNode, maxLen = 240): string => {
		const params = node.childForFieldName("parameters");
		const ret = node.childForFieldName("return_type");
		const name = nameOf(node) ?? "";
		let sig = name;
		if (params) sig += params.text;
		if (ret) sig += ` ${ret.text}`;
		sig = sig.replace(/\s+/g, " ").trim();
		return sig.length > maxLen ? `${sig.slice(0, maxLen)}…` : sig;
	};

	const visitClassBody = (
		classNode: Parser.SyntaxNode,
		classSymbolId: number,
		className: string,
	) => {
		const body = classNode.childForFieldName("body");
		if (!body) return;
		for (const child of body.namedChildren) {
			if (
				child.type === "method_definition" ||
				child.type === "public_field_definition"
			) {
				const mname = nameOf(child);
				if (!mname) continue;
				const startLine = child.startPosition.row + 1;
				const endLine = child.endPosition.row + 1;
				const kind: SymbolKind =
					child.type === "method_definition" ? "method" : "property";
				const sigText =
					child.type === "method_definition" ? signatureOf(child) : mname;
				const symId = addSymbol(
					mname,
					kind,
					sigText,
					startLine,
					endLine,
					false,
					classSymbolId,
				);
				if (child.type === "method_definition") {
					addChunk(
						"method",
						startLine,
						endLine,
						child.text,
						symId,
						`${className}.${mname}`,
					);
				}
			}
		}
	};

	const unwrapExport = (
		node: Parser.SyntaxNode,
	): { inner: Parser.SyntaxNode; exported: boolean } => {
		if (node.type === "export_statement") {
			const declaration = node.childForFieldName("declaration");
			if (declaration) return { inner: declaration, exported: true };
			const named = node.namedChildren.find(
				(c) =>
					c.type !== "export_clause" &&
					c.type !== "string" &&
					c.type !== "from",
			);
			if (named) return { inner: named, exported: true };
		}
		return { inner: node, exported: false };
	};

	const visitTopLevel = (node: Parser.SyntaxNode) => {
		const { inner, exported } = unwrapExport(node);
		const startLine = node.startPosition.row + 1;
		const endLine = node.endPosition.row + 1;
		const text = node.text;

		switch (inner.type) {
			case "function_declaration":
			case "generator_function_declaration": {
				const name = nameOf(inner);
				if (!name) return;
				const symId = addSymbol(
					name,
					"function",
					signatureOf(inner),
					startLine,
					endLine,
					exported,
					null,
				);
				addChunk("function", startLine, endLine, text, symId, name);
				return;
			}
			case "class_declaration":
			case "abstract_class_declaration": {
				const name = nameOf(inner);
				if (!name) return;
				const symId = addSymbol(
					name,
					"class",
					name,
					startLine,
					endLine,
					exported,
					null,
				);
				addChunk("class", startLine, endLine, text, symId, name);
				visitClassBody(inner, symId, name);
				return;
			}
			case "interface_declaration": {
				const name = nameOf(inner);
				if (!name) return;
				const symId = addSymbol(
					name,
					"interface",
					name,
					startLine,
					endLine,
					exported,
					null,
				);
				addChunk("interface", startLine, endLine, text, symId, name);
				return;
			}
			case "type_alias_declaration": {
				const name = nameOf(inner);
				if (!name) return;
				addSymbol(name, "type", name, startLine, endLine, exported, null);
				return;
			}
			case "enum_declaration": {
				const name = nameOf(inner);
				if (!name) return;
				const symId = addSymbol(
					name,
					"enum",
					name,
					startLine,
					endLine,
					exported,
					null,
				);
				addChunk("class", startLine, endLine, text, symId, name);
				return;
			}
			case "lexical_declaration":
			case "variable_declaration": {
				for (const declarator of inner.namedChildren) {
					if (declarator.type !== "variable_declarator") continue;
					const nameNode = declarator.childForFieldName("name");
					if (nameNode?.type !== "identifier") continue;
					const name = nameNode.text;
					const value = declarator.childForFieldName("value");
					const looksLikeFn =
						value !== null &&
						(value.type === "arrow_function" ||
							value.type === "function_expression");
					const kind: SymbolKind = looksLikeFn ? "function" : "const";
					const symId = addSymbol(
						name,
						kind,
						looksLikeFn && value ? signatureOf(value) : name,
						startLine,
						endLine,
						exported,
						null,
					);
					if (looksLikeFn) {
						addChunk("function", startLine, endLine, text, symId, name);
					}
				}
				return;
			}
			default:
				return;
		}
	};

	for (const child of root.namedChildren) {
		visitTopLevel(child);
	}

	// Flatten internal records into the public ParsedSymbol shape — parentIndex
	// already matches the index in the `symbols` array because we appended in order.
	const finalSymbols: ParsedSymbol[] = symbols.map((s) => ({
		name: s.name,
		kind: s.kind,
		signature: s.signature,
		startLine: s.startLine,
		endLine: s.endLine,
		exported: s.exported,
		parentIndex: s._parentId,
	}));

	const finalChunks: ParsedChunk[] = chunks.map((c) => ({
		kind: c.kind,
		startLine: c.startLine,
		endLine: c.endLine,
		content: c.content,
		symbolName: c.symbolName,
	}));

	return { chunks: finalChunks, symbols: finalSymbols };
};

export interface StaticImport {
	readonly specifier: string;
	readonly line: number;
}

/** Syntactic imports/re-exports only; deliberately makes no dynamic call-graph claim. */
export function extractStaticImports(
	source: string,
	lang: LanguageId,
): readonly StaticImport[] {
	const parser = loadParser(lang);
	if (!parser) return [];
	const tree = parser.parse(source);
	const imports: StaticImport[] = [];
	for (const node of tree.rootNode.namedChildren) {
		if (node.type !== "import_statement" && node.type !== "export_statement")
			continue;
		const value = node.childForFieldName("source");
		if (value?.type !== "string") continue;
		const text = value.text;
		// Escaped specifiers require language resolution; don't invent a target.
		if (text.includes("\\")) continue;
		imports.push({
			specifier: text.slice(1, -1),
			line: node.startPosition.row + 1,
		});
	}
	return imports;
}
