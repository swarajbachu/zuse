import { ConnectAuthError, MachineOpError, MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

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

export const MachineHandlersLayer = Layer.mergeAll(
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
);
