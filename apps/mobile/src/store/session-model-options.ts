import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./registry";

type ModelOptions = Readonly<Record<string, string>>;

/**
 * Per-chat model options (reasoning/effort) chosen in the composer. Like the
 * desktop composer, they are kept for this app session and sent with each
 * message rather than stored on the session.
 */
export const sessionModelOptionsAtom = Atom.family((_stateKey: string) =>
	Atom.make<ModelOptions | undefined>(undefined).pipe(Atom.keepAlive),
);

export const setSessionModelOptions = (
	stateKey: string,
	modelOptions: ModelOptions | undefined,
): void => appAtomRegistry.set(sessionModelOptionsAtom(stateKey), modelOptions);
