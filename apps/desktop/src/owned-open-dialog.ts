import type {
	BrowserWindow,
	OpenDialogOptions,
	OpenDialogReturnValue,
} from "electron";

type NativeDialog = {
	showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
	showOpenDialog(
		browserWindow: BrowserWindow,
		options: OpenDialogOptions,
	): Promise<OpenDialogReturnValue>;
};

export const showOwnedOpenDialog = (
	nativeDialog: NativeDialog,
	owner: BrowserWindow | null,
	options: OpenDialogOptions,
) =>
	owner === null
		? nativeDialog.showOpenDialog(options)
		: nativeDialog.showOpenDialog(owner, options);
