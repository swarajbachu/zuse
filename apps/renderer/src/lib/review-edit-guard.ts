type SaveDraft = () => Promise<boolean>;

let dirty = false;
let saveDraft: SaveDraft | null = null;

export const configureReviewEditGuard = (
	hasUnsavedDraft: boolean,
	save: SaveDraft | null,
): void => {
	dirty = hasUnsavedDraft;
	saveDraft = save;
};

/** Runs `leave` immediately, after save, or after an explicit discard. */
export const requestReviewLeave = (leave: () => void): void => {
	if (!dirty) {
		leave();
		return;
	}
	if (window.confirm("Save the current file edit before leaving the review?")) {
		const save = saveDraft;
		if (save !== null) {
			void save().then((saved) => {
				if (saved) leave();
			});
		}
		return;
	}
	if (
		window.confirm(
			"Discard the unsaved file edit? Choose Cancel to keep editing.",
		)
	) {
		dirty = false;
		saveDraft = null;
		leave();
	}
};
