import {
	type MachineOffer,
	type MachineOfferKind,
	PERSISTENT_STANDARD_OFFER_ID,
} from "@zuse/contracts";

export const PERSISTENT_STANDARD_OFFER: MachineOffer = {
	offerId: PERSISTENT_STANDARD_OFFER_ID,
	kind: "persistent",
	displayName: "Persistent Standard",
	architecture: "x86_64",
	vcpuCount: 4,
	memoryMib: 8_192,
	diskGib: 80,
	location: "Germany",
	monthlyPriceCents: 1_900,
	currency: "USD",
	automaticBackups: true,
	available: true,
};

export const MACHINE_OFFERS: ReadonlyArray<MachineOffer> = [
	PERSISTENT_STANDARD_OFFER,
];

export const findMachineOffer = (offerId: string): MachineOffer | undefined =>
	MACHINE_OFFERS.find((offer) => offer.offerId === offerId);

export const offerKind = (offerId: string): MachineOfferKind | undefined =>
	findMachineOffer(offerId)?.kind;

export const offerIdsOfKind = (kind: MachineOfferKind): ReadonlyArray<string> =>
	MACHINE_OFFERS.filter((offer) => offer.kind === kind).map(
		(offer) => offer.offerId,
	);
