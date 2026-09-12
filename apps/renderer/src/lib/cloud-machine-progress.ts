import "@zuse/i18n/english/connections";
import type { MachineRecord } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";

const persistentProgressSteps = [
	"Payment confirmed",
	"Creating server",
	"Installing runtime",
	"Developer tools",
	"Starting Zuse",
	"Connecting securely",
	"Ready",
] as const;

export const cloudMachineProgressSteps = () => persistentProgressSteps;

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
): number | null => {
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
): CloudMachineProgress => {
	const activeStep = setupStepFor(
		machine.state,
		machine.statusCode,
		machine.bootPhase,
	);
	switch (machine.statusCode) {
		case "creation-queued":
			return {
				activeStep,
				detail: "Your server is queued and will be created automatically.",
				headline: "Payment confirmed",
				label: uiMessage("connections:cloud_machine_progress_provisioning"),
				tone: "progress",
			};
		case "provider-provisioning":
			return {
				activeStep,
				detail: "The provider is allocating your server now.",
				headline: "Creating your server",
				label: uiMessage("connections:cloud_machine_progress_provisioning"),
				tone: "progress",
			};
		case "provider-unavailable":
			return {
				activeStep,
				detail:
					"The provider connection was interrupted. We are retrying automatically; no action is needed.",
				headline: "Still creating your server",
				label: uiMessage(
					"connections:cloud_machine_progress_retrying_automatically",
				),
				tone: "warning",
			};
		case "bootstrap-pending":
			if (machine.bootPhase === "runtime-installed") {
				return {
					activeStep,
					detail:
						"The runtime is verified. Developer tools are being installed.",
					headline: "Installing developer tools",
					label: uiMessage(
						"connections:cloud_machine_progress_installing_tools",
					),
					tone: "progress",
				};
			}
			if (machine.bootPhase === "developer-tools-installed") {
				return {
					activeStep,
					detail:
						"Git, agent CLIs, and build tools are ready. Zuse is starting.",
					headline: "Starting Zuse",
					label: uiMessage("connections:cloud_machine_progress_starting"),
					tone: "progress",
				};
			}
			return {
				activeStep,
				detail: "The server is online. We are installing and verifying Zuse.",
				headline: "Installing the runtime",
				label: uiMessage("connections:cloud_machine_progress_installing"),
				tone: "progress",
			};
		case "enrollment-pending":
			return {
				activeStep,
				detail: "The runtime is installed. We are securing its connection.",
				headline: "Connecting your machine",
				label: uiMessage("connections:cloud_machine_progress_connecting"),
				tone: "progress",
			};
		case "ready":
			return {
				activeStep,
				detail: "Open it to start working with its files and terminals.",
				headline: "Your cloud machine is ready",
				label: uiMessage("connections:cloud_machine_progress_ready"),
				tone: "success",
			};
		case "bootstrap-failed":
			return {
				activeStep,
				detail:
					"The server was created, but its runtime could not be installed.",
				headline: "Runtime setup needs attention",
				label: uiMessage(
					"connections:cloud_machine_progress_setup_interrupted",
				),
				tone: "error",
			};
		case "enrollment-failed":
			return {
				activeStep,
				detail: "The runtime was installed, but its secure connection failed.",
				headline: "Connection setup needs attention",
				label: uiMessage(
					"connections:cloud_machine_progress_setup_interrupted",
				),
				tone: "error",
			};
		case "reconciliation-failed":
			return {
				activeStep,
				detail:
					"Automatic setup could not continue. Your payment and machine record are safe.",
				headline: "Provisioning needs attention",
				label: uiMessage(
					"connections:cloud_machine_progress_setup_interrupted",
				),
				tone: "error",
			};
		case "suspension-queued":
		case "cancellation-scheduled":
			return {
				activeStep,
				detail: "You can continue using it through the paid period.",
				headline: "Cancellation scheduled",
				label: uiMessage(
					"connections:cloud_machine_progress_cancellation_scheduled",
				),
				tone: "warning",
			};
		case "suspended":
		case "recovery-available":
			return {
				activeStep,
				detail: "Recover it before the deadline to restore access.",
				headline: "Your cloud machine is suspended",
				label: uiMessage("connections:cloud_machine_progress_suspended"),
				tone: "warning",
			};
		case "resume-queued":
			return {
				activeStep,
				detail:
					"Your machine is being restored and will reconnect automatically.",
				headline: "Restoring your machine",
				label: uiMessage("connections:cloud_machine_progress_restoring"),
				tone: "progress",
			};
		case "destruction-queued":
			return {
				activeStep,
				detail: "Access has ended and provider cleanup is in progress.",
				headline: "Removing your machine",
				label: uiMessage("connections:cloud_machine_progress_removing"),
				tone: "warning",
			};
		case "destroyed":
			return {
				activeStep,
				detail: "The server and its access credentials have been removed.",
				headline: "Cloud machine removed",
				label: uiMessage("connections:cloud_machine_progress_removed"),
				tone: "success",
			};
	}
};
