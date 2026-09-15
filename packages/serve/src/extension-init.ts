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
	template?: string;
	command?: unknown;
}) {
	const template = options.template ?? "workspace";
	if (template !== "workspace" && template !== "acp")
		throw new Error("Choose --template workspace or acp.");
	const acp = template === "acp";
	const command = options.command;
	if (
		acp &&
		(!Array.isArray(command) ||
			!command.length ||
			command.length > 128 ||
			command.some(
				(v) => typeof v !== "string" || v.includes("\0") || v.length > 8192,
			) ||
			!command[0].trim())
	)
		throw new Error(
			`ACP requires --command as a JSON executable/argument array, for example '["opencode","acp"]'.`,
		);
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
		description: acp
			? "A local ACP coding agent for Zuse"
			: "A local workspace tool for Zuse",
		version: "0.1.0",
		...(!acp ? { client: "src/index.client.tsx" } : {}),
		server: "src/index.server.ts",
		zuseApi: acp ? "^1.2.0" : "^1.1.0",
		contributions: acp
			? ["provider"]
			: ["workspace-panel", "attachment-source"],
		capabilities: acp
			? ["providers", "process"]
			: ["ui", "attachments", "rpc", "filesystem"],
		publisher: { name: options.publisher },
	});
	await json("package.json", {
		name: options.id,
		version: "0.1.0",
		private: true,
		type: "module",
		scripts: { "check-types": "tsc --noEmit" },
		dependencies: {
			"@zuse/extension-sdk": options.sdk ?? "0.3.0",
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
	if (acp) {
		await writeFile(
			join(directory, "src/index.server.ts"),
			`import type { ExtensionServerContext } from "@zuse/extension-sdk/server";

export default function setup(extension: ExtensionServerContext) {
  return extension.addAcpProvider({
    id: ${JSON.stringify(`${options.id}.agent`)},
    displayName: ${JSON.stringify(options.name)},
    command: ${JSON.stringify(command)},
    loginHint: "Sign in using the coding tool's own CLI before starting a conversation.",
  });
}
`,
		);
		await writeFile(
			join(directory, "README.md"),
			`# ${options.name.replace(/[\r\n]/g, " ")}

Install the agent command and sign in using its CLI. Run npm run check-types, then zuse extension install --path . and enable this extension in Settings → Extensions. Select ${options.name.replace(/[\r\n]/g, " ")} in a new chat's model picker.

Edit src/index.server.ts to change the argv command or add native model IDs and mode mappings. Use an absolute executable path if desktop PATH cannot find it. The agent owns authentication and default model selection. No credentials belong in the manifest or source. This trusted extension launches unsandboxed local code.

Text prompts, streamed output, one-time permission requests, cancellation and supported session resume are handled by Zuse. Image/file/skill attachments, forks, client filesystem/terminal RPC, MCP injection and automatic model discovery are not supported by this starter. Paste context into the prompt. Reload after editing; close active chats before reloading. Disable stops its sessions and retains history.
`,
		);
	} else {
		await writeFile(
			join(directory, "src/index.server.ts"),
			`import type { ExtensionServerContext } from '@zuse/extension-sdk';\nimport { registerWorkspaceTool } from '@zuse/extension-sdk/server';\nexport default function setup(e: ExtensionServerContext) {\n return registerWorkspaceTool(e,{extensions:['.md'],read:(text,path)=>[{id:path,title:path,text:\`Source: \${path}\\n\\n\${text}\`}]});\n}\n`,
		);
		await writeFile(
			join(directory, "src/index.client.tsx"),
			`import type { ExtensionClientContext } from '@zuse/extension-sdk';\nimport { workspaceToolSearch } from '@zuse/extension-sdk';\nimport { WorkspaceTool } from '@zuse/extension-sdk/client';\nexport default function setup(e: ExtensionClientContext) {\n e.addWorkspacePanel({id:'main',title:'Project notes',icon:'package',Component:props=><WorkspaceTool {...props} title="Project notes" description="Select Markdown to attach to your conversation." mode="file"/>});\n e.addAttachmentSource({id:'notes',title:'Project notes',icon:'package',pickerTitle:'Project notes',searchPlaceholder:'Search loaded notes',search:workspaceToolSearch});\n return ()=>{};\n}\n`,
		);
	}
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
