import { createAtomStore as create } from "../state/atom-store.ts";
import { useUiStore } from "../store/ui.ts";
import { isHostedProduct } from "./hosted-connect.ts";

type ProjectSetupDialogState = {
	open: boolean;
	setOpen: (open: boolean) => void;
};

export const useProjectSetupDialogStore = create<ProjectSetupDialogState>(
	(set) => ({
		open: false,
		setOpen: (open) => set({ open }),
	}),
);

export const openProjectSetupDialog = (): void => {
	if (isHostedProduct()) {
		useUiStore.getState().setSettingsSection({ kind: "machines" });
		useUiStore.getState().setView("settings");
		return;
	}
	useProjectSetupDialogStore.setState({ open: true });
};
