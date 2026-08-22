export interface ServeServiceDefinitionInput {
	readonly nodeExecutable: string;
	readonly executable: string;
	readonly dataDir: string;
	readonly logDir?: string;
	readonly relayUrl?: string;
	readonly sshManaged?: boolean;
	readonly tailscale?: boolean;
	readonly noAccount?: boolean;
	readonly lan?: boolean;
	readonly host?: string;
	readonly port?: number;
}

/** Start flags the daemon re-parses; order mirrors the CLI help. */
const serveStartFlags = (
	input: ServeServiceDefinitionInput,
): ReadonlyArray<string> => [
	...(input.sshManaged === true ? ["--ssh-managed"] : []),
	...(input.tailscale === true ? ["--tailscale"] : []),
	...(input.noAccount === true ? ["--no-account"] : []),
	...(input.lan === true
		? ["--lan"]
		: input.host !== undefined
			? ["--host", input.host]
			: []),
	...(input.port !== undefined ? ["--port", String(input.port)] : []),
];

/** Account linking runs unless the mode explicitly opts out. */
const autoLinkEnabled = (input: ServeServiceDefinitionInput): boolean =>
	input.sshManaged !== true && input.noAccount !== true;

export interface LaunchAgentDefinition {
	readonly label: "sh.zuse.serve";
	readonly contents: string;
}

export interface SystemdUserDefinition {
	readonly unitName: "zuse-serve.service";
	readonly contents: string;
}

const escapeXml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");

const quoteSystemd = (value: string): string =>
	`"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export const launchAgentDefinition = (
	input: ServeServiceDefinitionInput,
): LaunchAgentDefinition => {
	const logDir = input.logDir ?? `${input.dataDir}/logs`;
	const relayUrl = input.relayUrl ?? "https://relay.stuff.md";
	return {
		label: "sh.zuse.serve",
		contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>sh.zuse.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(input.nodeExecutable)}</string>
    <string>${escapeXml(input.executable)}</string>
    <string>serve</string>
    <string>--foreground</string>
    ${serveStartFlags(input)
			.map((flag) => `<string>${escapeXml(flag)}</string>`)
			.join("\n    ")}
    <string>--data-dir</string>
    <string>${escapeXml(input.dataDir)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>EnvironmentVariables</key>
  <dict>
	${autoLinkEnabled(input) ? "<key>ZUSE_SERVE_AUTO_LINK</key>\n    <string>1</string>" : ""}
    <key>ZUSE_RELAY_URL</key>
    <string>${escapeXml(relayUrl)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(`${logDir}/serve.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(`${logDir}/serve.error.log`)}</string>
</dict>
</plist>
`,
	};
};

export const systemdUserDefinition = (
	input: ServeServiceDefinitionInput,
): SystemdUserDefinition => {
	const relayUrl = input.relayUrl ?? "https://relay.stuff.md";
	return {
		unitName: "zuse-serve.service",
		contents: `[Unit]
Description=Zuse Serve
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(input.nodeExecutable)} ${quoteSystemd(input.executable)} serve --foreground${serveStartFlags(
			input,
		)
			.map((flag) => ` ${quoteSystemd(flag)}`)
			.join("")} --data-dir ${quoteSystemd(input.dataDir)}
${autoLinkEnabled(input) ? "Environment=ZUSE_SERVE_AUTO_LINK=1" : ""}
Environment=ZUSE_RELAY_URL=${quoteSystemd(relayUrl)}
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${quoteSystemd(input.dataDir)}

[Install]
WantedBy=default.target
`,
	};
};
