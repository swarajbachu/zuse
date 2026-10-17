import type {
	BrowserWindow,
	OpenDialogOptions,
	OpenDialogReturnValue,
} from "electron";
import { describe, expect, it, vi } from "vitest";
import { showOwnedOpenDialog } from "../../src/owned-open-dialog.ts";

const result: OpenDialogReturnValue = {
	canceled: false,
	filePaths: ["C:\\project"],
	bookmarks: [],
};

const makeDialog = () => ({
	showOpenDialog: vi.fn(async () => result),
});

const options: OpenDialogOptions = {
	properties: ["openDirectory"],
};

describe("showOwnedOpenDialog", () => {
	it("parents the native dialog to the main window when one exists", async () => {
		const nativeDialog = makeDialog();
		const owner = {} as BrowserWindow;

		await showOwnedOpenDialog(nativeDialog, owner, options);

		expect(nativeDialog.showOpenDialog).toHaveBeenCalledWith(owner, options);
	});

	it("opens without an owner before the main window exists", async () => {
		const nativeDialog = makeDialog();

		await showOwnedOpenDialog(nativeDialog, null, options);

		expect(nativeDialog.showOpenDialog).toHaveBeenCalledWith(options);
	});
});
