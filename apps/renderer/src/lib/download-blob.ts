/** Give the browser time to consume the URL before releasing its backing bytes. */
export const downloadBlob = (blob: Blob, fileName: string): void => {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	try {
		document.body.append(anchor);
		anchor.click();
	} finally {
		anchor.remove();
		setTimeout(() => URL.revokeObjectURL(url), 30_000);
	}
};
