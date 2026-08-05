import { MachineOpError } from "@zuse/contracts";

export const checkoutErrorMessage = (cause: unknown): string => {
	if (cause instanceof MachineOpError) {
		switch (cause.code) {
			case "billing-unavailable":
				return "Checkout is temporarily unavailable. Try again in a moment.";
			case "conflict":
				return "This account already has a cloud-machine subscription.";
			case "provider-unavailable":
				return "Checkout could not be created. Please try again.";
			default:
				return "Checkout could not be opened. Please try again.";
		}
	}
	return cause instanceof Error
		? cause.message
		: "Checkout could not be opened. Please try again.";
};

export const visibleCloudMachineError = (
	loadError: string | null,
	actionError: string | null,
): string | null => actionError ?? loadError;
