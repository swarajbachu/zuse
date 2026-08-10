import type { MachineOfferKind, MachineRecord } from "@zuse/contracts";

const persistentProgressSteps = [
	"Payment confirmed",
	"Creating server",
	"Installing runtime",
	"Developer tools",
	"Starting Zuse",
	"Connecting securely",
	"Ready",
] as const;

const sandboxProgressSteps = [
	"Payment confirmed",
	"Creating sandbox",
	"Starting Zuse",
	"Connecting",
	"Ready",
] as const;

export const cloudMachineProgressSteps = (kind: MachineOfferKind) =>
	kind === "sandbox" ? sandboxProgressSteps : persistentProgressSteps;

export type CloudMachineProgress = Readonly<{
	activeStep: number | null;
	detail: string;
	headline: string;
	label: string;
	tone: "progress" | "warning" | "success" | "error";
}>;

const setupStepFor = (
	state: MachineRecord["state"],
	statusCode: MachineRecord["statusCode"],
	bootPhase?: MachineRecord["bootPhase"],
	kind: MachineOfferKind = "persistent",
): number | null => {
	if (kind === "sandbox") {
		switch (state) {
			case "creating":
				return 1;
			case "bootstrapping":
				return 2;
			case "enrolling":
				return 3;
			case "failed":
				return statusCode === "enrollment-failed" ? 3 : 2;
			case "ready":
				return 4;
			default:
				return null;
		}
	}
	switch (state) {
		case "creating":
			return 1;
		case "bootstrapping":
			if (bootPhase === "runtime-installed") return 3;
			if (bootPhase === "developer-tools-installed") return 4;
			if (
				bootPhase === "zuse-started" ||
				bootPhase === "account-setup-available" ||
				bootPhase === "service-started"
			) {
				return 5;
			}
			return 2;
		case "enrolling":
			return 5;
		case "failed":
			if (statusCode === "bootstrap-failed") return 2;
			if (statusCode === "enrollment-failed") return 5;
			return 1;
		case "ready":
			return 6;
		default:
			return null;
	}
};

export const cloudMachineProgress = (
	machine: Pick<MachineRecord, "state" | "statusCode"> &
		Partial<Pick<MachineRecord, "bootPhase">>,
	kind: MachineOfferKind = "persistent",
): CloudMachineProgress => {
	const activeStep = setupStepFor(
		machine.state,
		machine.statusCode,
		machine.bootPhase,
		kind,
	);
	if (kind === "sandbox") {
		switch (machine.statusCode) {
			case "creation-queued":
				return {
					activeStep,
					detail: "Your sandbox is queued and will start automatically.",
					headline: "Payment confirmed",
					label: "Provisioning",
					tone: "progress",
				};
			case "provider-provisioning":
				return {
					activeStep,
					detail: "Your sandbox is starting. This usually takes a few seconds.",
					headline: "Creating your sandbox",
					label: "Provisioning",
					tone: "progress",
				};
			case "bootstrap-pending":
				return {
					activeStep,
					detail: "The sandbox is online and Zuse is starting.",
					headline: "Starting Zuse",
					label: "Starting",
					tone: "progress",
				};
			case "enrollment-pending":
				return {
					activeStep,
					detail: "Zuse is ready. We are securing the connection.",
					headline: "Connecting your sandbox",
					label: "Connecting",
					tone: "progress",
				};
			case "ready":
				return {
					activeStep,
					detail: "Open it to run agents and terminals in seconds.",
					headline: "Your cloud sandbox is ready",
					label: "Ready",
					tone: "success",
				};
		}
	}
	switch (machine.statusCode) {
		case "creation-queued":
			return {
				activeStep,
				detail: "Your server is queued and will be created automatically.",
				headline: "Payment confirmed",
				label: "Provisioning",
				tone: "progress",
			};
		case "provider-provisioning":
			return {
				activeStep,
				detail: "The provider is allocating your server now.",
				headline: "Creating your server",
				label: "Provisioning",
				tone: "progress",
			};
		case "provider-unavailable":
			return {
				activeStep,
				detail:
					"The provider connection was interrupted. We are retrying automatically; no action is needed.",
				headline:
					kind === "sandbox"
						? "Still creating your sandbox"
						: "Still creating your server",
				label: "Retrying automatically",
				tone: "warning",
			};
		case "bootstrap-pending":
			if (machine.bootPhase === "runtime-installed") {
				return {
					activeStep,
					detail:
						"The runtime is verified. Developer tools are being installed.",
					headline: "Installing developer tools",
					label: "Installing tools",
					tone: "progress",
				};
			}
			if (machine.bootPhase === "developer-tools-installed") {
				return {
					activeStep,
					detail:
						"Git, agent CLIs, and build tools are ready. Zuse is starting.",
					headline: "Starting Zuse",
					label: "Starting",
					tone: "progress",
				};
			}
			return {
				activeStep,
				detail: "The server is online. We are installing and verifying Zuse.",
				headline: "Installing the runtime",
				label: "Installing",
				tone: "progress",
			};
		case "enrollment-pending":
			return {
				activeStep,
				detail: "The runtime is installed. We are securing its connection.",
				headline: "Connecting your machine",
				label: "Connecting",
				tone: "progress",
			};
		case "ready":
			return {
				activeStep,
				detail: "Open it to start working with its files and terminals.",
				headline: "Your cloud machine is ready",
				label: "Ready",
				tone: "success",
			};
		case "bootstrap-failed":
			return {
				activeStep,
				detail:
					kind === "sandbox"
						? "The sandbox was created, but Zuse could not start."
						: "The server was created, but its runtime could not be installed.",
				headline: "Runtime setup needs attention",
				label: "Setup interrupted",
				tone: "error",
			};
		case "enrollment-failed":
			return {
				activeStep,
				detail: "The runtime was installed, but its secure connection failed.",
				headline: "Connection setup needs attention",
				label: "Setup interrupted",
				tone: "error",
			};
		case "reconciliation-failed":
			return {
				activeStep,
				detail:
					"Automatic setup could not continue. Your payment and machine record are safe.",
				headline: "Provisioning needs attention",
				label: "Setup interrupted",
				tone: "error",
			};
		case "suspension-queued":
			return {
				activeStep,
				detail: `Your ${kind === "sandbox" ? "sandbox" : "machine"} will stop at the end of its paid period.`,
				headline: "Cancellation scheduled",
				label: "Cancellation scheduled",
				tone: "warning",
			};
		case "suspended":
		case "recovery-available":
			return {
				activeStep,
				detail: "Recover it before the deadline to restore access.",
				headline: `Your cloud ${kind === "sandbox" ? "sandbox" : "machine"} is suspended`,
				label: "Suspended",
				tone: "warning",
			};
		case "resume-queued":
			return {
				activeStep,
				detail: `Your ${kind === "sandbox" ? "sandbox" : "machine"} is being restored and will reconnect automatically.`,
				headline: `Restoring your ${kind === "sandbox" ? "sandbox" : "machine"}`,
				label: "Restoring",
				tone: "progress",
			};
		case "destruction-queued":
			return {
				activeStep,
				detail: "Access has ended and provider cleanup is in progress.",
				headline: `Removing your ${kind === "sandbox" ? "sandbox" : "machine"}`,
				label: "Removing",
				tone: "warning",
			};
		case "destroyed":
			return {
				activeStep,
				detail:
					kind === "sandbox"
						? "The sandbox and its access credentials have been removed."
						: "The server and its access credentials have been removed.",
				headline: `Cloud ${kind === "sandbox" ? "sandbox" : "machine"} removed`,
				label: "Removed",
				tone: "success",
			};
		case "cancellation-scheduled":
			return {
				activeStep,
				detail: "You can continue using it through the paid period.",
				headline: "Cancellation scheduled",
				label: "Cancellation scheduled",
				tone: "warning",
			};
	}
};
