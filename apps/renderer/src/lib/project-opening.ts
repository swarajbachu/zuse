export type ProjectOpenMode = "native-picker" | "remote-path";

/**
 * Native folder dialogs belong to the local Electron host. A selected cloud
 * environment owns a different filesystem, so it must receive an explicit
 * path instead of asking the headless server to open a dialog.
 */
export const projectOpenModeForEnvironment = (
	environmentId: string | null,
): ProjectOpenMode =>
	environmentId === null ? "native-picker" : "remote-path";

export const openProjectForEnvironment = (
	environmentId: string | null,
	actions: {
		readonly openNativePicker: () => void;
		readonly openRemotePathDialog: () => void;
	},
): ProjectOpenMode => {
	const mode = projectOpenModeForEnvironment(environmentId);
	if (mode === "native-picker") actions.openNativePicker();
	else actions.openRemotePathDialog();
	return mode;
};
