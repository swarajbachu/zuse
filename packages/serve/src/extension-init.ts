import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** Standalone scaffold: no workspace aliases, private packages, or source-checkout imports. */
export async function initializeExtension(options: {
	directory: string;
	id: string;
	name: string;
	publisher: string;
	sdk?: string;
}) {
	const directory = resolve(options.directory);
	if (!/^[a-z][a-z0-9-]{0,62}$/.test(options.id))
		throw new Error("Extension ID must be a lowercase slug.");
	const existing = await readdir(directory).catch(
		(error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw error;
		},
	);
	if (existing.length)
		throw new Error("Choose an empty directory for the new extension.");
	await mkdir(join(directory, "src"), { recursive: true });
	const json = async (name: string, value: unknown) =>
		writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
			flag: "wx",
		});
	await json("zuse-extension.json", {
		schemaVersion: 1,
		id: options.id,
		name: options.name,
		description: "A local workspace tool for Zuse",
		version: "0.1.0",
		client: "src/index.client.tsx",
		server: "src/index.server.ts",
		zuseApi: "^1.0.0",
		contributions: ["workspace-panel", "attachment-source"],
		capabilities: ["ui", "attachments", "rpc", "filesystem"],
		publisher: { name: options.publisher },
	});
	await json("package.json", {
		name: options.id,
		version: "0.1.0",
		private: true,
		type: "module",
		scripts: { "check-types": "tsc --noEmit" },
		dependencies: {
			"@zuse/extension-sdk": options.sdk ?? "0.1.0",
			effect: "4.0.0-beta.102",
			react: "19.2.0",
		},
		devDependencies: { typescript: "5.9.2", "@types/react": "19.2.2" },
	});
	await json("tsconfig.json", {
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			jsx: "react-jsx",
			strict: true,
			skipLibCheck: true,
			noEmit: true,
			allowImportingTsExtensions: true,
		},
		include: ["src"],
	});
	await writeFile(
		join(directory, "src/index.server.ts"),
		`import type { ExtensionServerContext } from '@zuse/extension-sdk';\nimport { registerWorkspaceTool } from '@zuse/extension-sdk/server';\nexport default function setup(e: ExtensionServerContext) {\n return registerWorkspaceTool(e,{extensions:['.md'],read:(text,path)=>[{id:path,title:path,text:\`Source: \${path}\\n\\n\${text}\`}]});\n}\n`,
	);
	await writeFile(
		join(directory, "src/index.client.tsx"),
		`import type { ExtensionClientContext } from '@zuse/extension-sdk';\nimport { workspaceToolSearch } from '@zuse/extension-sdk';\nimport { WorkspaceTool } from '@zuse/extension-sdk/client';\nexport default function setup(e: ExtensionClientContext) {\n e.addWorkspacePanel({id:'main',title:'Project notes',icon:'package',Component:props=><WorkspaceTool {...props} title="Project notes" description="Select Markdown to attach to your conversation." mode="file"/>});\n e.addAttachmentSource({id:'notes',title:'Project notes',icon:'package',pickerTitle:'Project notes',searchPlaceholder:'Search loaded notes',search:workspaceToolSearch});\n return ()=>{};\n}\n`,
	);
	try {
		await promisify(execFile)(
			"npm",
			["install", "--ignore-scripts", "--no-audit", "--no-fund"],
			{ cwd: directory, timeout: 120_000, maxBuffer: 1024 * 1024 },
		);
		await promisify(execFile)("npm", ["run", "check-types"], {
			cwd: directory,
			timeout: 60_000,
			maxBuffer: 1024 * 1024,
		});
	} catch (cause) {
		throw new Error(
			`Project created at ${directory}, but dependency installation or type checking failed. Resolve the package/network error and run npm install --ignore-scripts && npm run check-types there.`,
			{ cause },
		);
	}
	return { directory, manifestPath: join(directory, "zuse-extension.json") };
}
