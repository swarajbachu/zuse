import { createAtomStore as create } from "../state/atom-store.ts";

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
	useProjectSetupDialogStore.setState({ open: true });
};
