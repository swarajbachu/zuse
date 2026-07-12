/** Provider-neutral capabilities offered by Zuse's ACP client. */
export const ACP_CLIENT_CAPABILITIES = {
	fs: {
		readTextFile: true,
		writeTextFile: true,
		readDirectory: true,
		createDirectory: true,
		deleteFile: true,
		moveFile: true,
	},
	terminal: true,
	experimentalApi: true,
} as const;
