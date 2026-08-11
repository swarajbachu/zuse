import {
	CloudWorkspaceOpError,
	ConnectAuthError,
	MachineOpError,
	MemoizeRpcs,
} from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { AccountAccessService } from "../account-access/service.ts";
import {
	type MachineControlError,
	MachineControlService,
} from "./machine-control-service.ts";
import { MachineHostService } from "./machine-host-service.ts";

const toError = (error: MachineControlError): MachineOpError =>
	new MachineOpError({ code: error.code });

const withControl = <A>(
	run: (
		service: MachineControlService["Service"],
	) => Effect.Effect<A, MachineControlError>,
) =>
	Effect.gen(function* () {
		const service = yield* MachineControlService;
		return yield* run(service);
	}).pipe(Effect.mapError(toError));

const withCloudControl = <A>(
	run: (
		service: MachineControlService["Service"],
	) => Effect.Effect<A, MachineControlError>,
) =>
	Effect.gen(function* () {
		const service = yield* MachineControlService;
		return yield* run(service);
	}).pipe(
		Effect.mapError(
			(error) =>
				new CloudWorkspaceOpError({
					code:
						error.code === "invalid-state"
							? "project-not-ready"
							: error.code === "machine-limit-reached" ||
									error.code === "invalid-offer" ||
									error.code === "billing-unavailable" ||
									error.code === "enrollment-expired" ||
									error.code === "enrollment-rejected"
								? "invalid-request"
								: error.code,
				}),
		),
	);

const withHost = <A>(
	run: (
		service: MachineHostService["Service"],
	) => Effect.Effect<A, MachineControlError>,
) =>
	Effect.gen(function* () {
		const service = yield* MachineHostService;
		return yield* run(service);
	}).pipe(Effect.mapError(toError));

const Offers = MemoizeRpcs.toLayerHandler("machines.offers", () =>
	withControl((service) => service.offers()),
);
const CloudProviders = MemoizeRpcs.toLayerHandler("cloud.providers", () =>
	withCloudControl((service) => service.cloudProviders()),
);
const CloudProjects = MemoizeRpcs.toLayerHandler("cloud.projects.list", () =>
	withCloudControl((service) => service.cloudProjects()),
);
const ConnectCloudProject = MemoizeRpcs.toLayerHandler(
	"cloud.projects.connect",
	(input) => withCloudControl((service) => service.connectCloudProject(input)),
);
const PrepareCloudProject = MemoizeRpcs.toLayerHandler(
	"cloud.projects.prepare",
	(input) => withCloudControl((service) => service.prepareCloudProject(input)),
);
const CloudWorkspaces = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.list",
	({ projectId }) =>
		withCloudControl((service) => service.cloudWorkspaces(projectId)),
);
const CloudWorkspace = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.get",
	({ workspaceId }) =>
		withCloudControl((service) => service.cloudWorkspace(workspaceId)),
);
const CloudWorkspaceAgentStarted = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.agentStarted",
	({ workspaceId }) =>
		withCloudControl((service) =>
			service.cloudWorkspaceAction(workspaceId, "agent-started"),
		),
);
const CloudWorkspaceConnected = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.connected",
	({ workspaceId }) =>
		withCloudControl((service) =>
			service.cloudWorkspaceAction(workspaceId, "connected"),
		),
);
const CloudWorkspaceChatCreated = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.chatCreated",
	({ workspaceId }) =>
		withCloudControl((service) =>
			service.cloudWorkspaceAction(workspaceId, "chat-created"),
		),
);
const CreateCloudWorkspace = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.create",
	(input) => withCloudControl((service) => service.createCloudWorkspace(input)),
);
const PauseCloudWorkspace = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.pause",
	({ workspaceId }) =>
		withCloudControl((service) =>
			service.cloudWorkspaceAction(workspaceId, "pause"),
		),
);
const ResumeCloudWorkspace = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.resume",
	({ workspaceId }) =>
		withCloudControl((service) =>
			service.cloudWorkspaceAction(workspaceId, "resume"),
		),
);
const ArchiveCloudWorkspace = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.archive",
	({ workspaceId }) =>
		withCloudControl((service) =>
			service.cloudWorkspaceAction(workspaceId, "archive"),
		),
);
const DeleteCloudWorkspace = MemoizeRpcs.toLayerHandler(
	"cloud.workspaces.delete",
	({ workspaceId }) =>
		withCloudControl((service) =>
			service.cloudWorkspaceAction(workspaceId, "delete"),
		),
);
const CloudCredentials = MemoizeRpcs.toLayerHandler(
	"cloud.credentials.list",
	() => withCloudControl((service) => service.cloudCredentials()),
);
const ImportLocalCloudCredential = MemoizeRpcs.toLayerHandler(
	"cloud.credentials.importLocal",
	({ kind }) =>
		Effect.gen(function* () {
			const accountAccess = yield* AccountAccessService;
			const credential = yield* accountAccess
				.readLocalCredential(kind)
				.pipe(
					Effect.mapError(
						() => new CloudWorkspaceOpError({ code: "invalid-request" }),
					),
				);
			return yield* withCloudControl((service) =>
				service.connectCloudCredential({
					kind,
					credentialType: credential.credentialType,
					secret: credential.secret,
					...(credential.accountLabel === undefined
						? {}
						: { accountLabel: credential.accountLabel }),
				}),
			);
		}),
);
const DisconnectCloudCredential = MemoizeRpcs.toLayerHandler(
	"cloud.credentials.disconnect",
	({ kind }) =>
		withCloudControl((service) => service.disconnectCloudCredential(kind)),
);
const List = MemoizeRpcs.toLayerHandler("machines.list", () =>
	withControl((service) => service.list()),
);
const Get = MemoizeRpcs.toLayerHandler("machines.get", ({ machineId }) =>
	withControl((service) => service.get(machineId)),
);
const Create = MemoizeRpcs.toLayerHandler("machines.create", (input) =>
	withControl((service) => service.create(input)),
);
const Cancel = MemoizeRpcs.toLayerHandler("machines.cancel", ({ machineId }) =>
	withControl((service) => service.cancel(machineId)),
);
const Recover = MemoizeRpcs.toLayerHandler(
	"machines.recover",
	({ machineId }) => withControl((service) => service.recover(machineId)),
);
const Destroy = MemoizeRpcs.toLayerHandler("machines.destroy", (input) =>
	withControl((service) => service.destroy(input)),
);
const Checkout = MemoizeRpcs.toLayerHandler("machines.checkout", (input) =>
	withControl((service) => service.checkout(input)),
);
const BillingPortal = MemoizeRpcs.toLayerHandler("machines.billingPortal", () =>
	withControl((service) => service.billingPortal()),
);
const Entitlements = MemoizeRpcs.toLayerHandler("machines.entitlements", () =>
	withControl((service) => service.entitlements()),
);
const Environments = MemoizeRpcs.toLayerHandler("environments.list", () =>
	withControl((service) => service.environments()).pipe(
		Effect.mapError((error) => new ConnectAuthError({ reason: error.code })),
	),
);
const ConnectEnvironment = MemoizeRpcs.toLayerHandler(
	"environments.connect",
	({ environmentId }) =>
		withControl((service) => service.connectEnvironment(environmentId)).pipe(
			Effect.mapError((error) => new ConnectAuthError({ reason: error.code })),
		),
);

const AddSshKey = MemoizeRpcs.toLayerHandler(
	"machine.sshKeys.add",
	({ publicKey, label }) =>
		withHost((service) => service.addSshKey(publicKey, label)),
);
const ListSshKeys = MemoizeRpcs.toLayerHandler("machine.sshKeys.list", () =>
	withHost((service) =>
		service.listSshKeys().pipe(Effect.map((keys) => ({ keys }))),
	),
);
const RemoveSshKey = MemoizeRpcs.toLayerHandler(
	"machine.sshKeys.remove",
	({ fingerprint }) => withHost((service) => service.removeSshKey(fingerprint)),
);
const EnablePrivateNetwork = MemoizeRpcs.toLayerHandler(
	"machine.privateNetwork.enable",
	({ authKey, sshMode }) =>
		withHost((service) => service.enablePrivateNetwork(authKey, sshMode)),
);
const PrivateNetworkStatus = MemoizeRpcs.toLayerHandler(
	"machine.privateNetwork.status",
	() => withHost((service) => service.privateNetworkStatus()),
);
const SetSshMode = MemoizeRpcs.toLayerHandler(
	"machine.sshMode.set",
	({ mode }) => withHost((service) => service.setSshMode(mode)),
);
const RuntimeTarget = MemoizeRpcs.toLayerHandler("machine.runtime.target", () =>
	withHost((service) => service.runtimeTarget()),
);
const RuntimeStatus = MemoizeRpcs.toLayerHandler(
	"machine.runtime.status",
	({ targetAppVersion }) =>
		withHost((service) => service.runtimeStatus(targetAppVersion)),
);
const RuntimeUpdate = MemoizeRpcs.toLayerHandler(
	"machine.runtime.update",
	({ targetAppVersion }) =>
		withHost((service) => service.requestRuntimeUpdate(targetAppVersion)),
);

export const MachineHandlersLayer = Layer.mergeAll(
	CloudProviders,
	CloudProjects,
	ConnectCloudProject,
	PrepareCloudProject,
	CloudWorkspaces,
	CloudWorkspace,
	CloudWorkspaceAgentStarted,
	CloudWorkspaceConnected,
	CloudWorkspaceChatCreated,
	CreateCloudWorkspace,
	PauseCloudWorkspace,
	ResumeCloudWorkspace,
	ArchiveCloudWorkspace,
	DeleteCloudWorkspace,
	CloudCredentials,
	ImportLocalCloudCredential,
	DisconnectCloudCredential,
	Offers,
	List,
	Get,
	Create,
	Cancel,
	Recover,
	Destroy,
	Checkout,
	BillingPortal,
	Entitlements,
	Environments,
	ConnectEnvironment,
	AddSshKey,
	ListSshKeys,
	RemoveSshKey,
	EnablePrivateNetwork,
	PrivateNetworkStatus,
	SetSshMode,
	RuntimeTarget,
	RuntimeStatus,
	RuntimeUpdate,
);
