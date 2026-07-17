import { Duration } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { appAtomRegistry } from "./registry.tsx";

type SetState<State> = (
	patch: Partial<State> | State | ((state: State) => Partial<State> | State),
	replace?: boolean,
) => void;

type StoreInitializer<State> = (
	set: SetState<State>,
	get: () => State,
) => State;

export type AtomStore<State> = {
	<Selected = State>(selector?: (state: State) => Selected): Selected;
	getState: () => State;
	getInitialState: () => State;
	setState: SetState<State>;
	subscribe: (listener: (state: State, previous: State) => void) => () => void;
	atom: Atom.Writable<State>;
};

/**
 * Compatibility surface for the renderer's existing domain hooks while their
 * storage is moved to Effect atoms. Updates are shallow by default, matching
 * the prior hooks, and selector snapshots suppress unrelated React renders.
 */
export function createAtomStore<State>(
	initializer: StoreInitializer<State>,
): AtomStore<State> {
	let stateAtom: Atom.Writable<State>;
	let pendingInitial: State | undefined;
	const get = (): State =>
		stateAtom === undefined
			? (pendingInitial as State)
			: appAtomRegistry.get(stateAtom);
	const set: SetState<State> = (patch, replace = false) => {
		appAtomRegistry.update(stateAtom, (previous) => {
			const resolved =
				typeof patch === "function"
					? (patch as (state: State) => Partial<State> | State)(previous)
					: patch;
			return replace ? (resolved as State) : { ...previous, ...resolved };
		});
	};
	pendingInitial = initializer(set, get);
	const initialState = pendingInitial;
	// Application stores outlive any one mounted selector. Keep their writable
	// atoms alive so a temporarily unmounted pane cannot reset domain state.
	stateAtom = Atom.make(initialState).pipe(Atom.setIdleTTL(Duration.infinity));

	const useStore = (<Selected = State>(
		selector: (state: State) => Selected = (state) =>
			state as unknown as Selected,
	): Selected => {
		const selectorRef = useRef(selector);
		selectorRef.current = selector;
		const cacheRef = useRef<{
			state: State;
			selector: (state: State) => Selected;
			selection: Selected;
		} | null>(null);
		const snapshot = useCallback(() => {
			const state = appAtomRegistry.get(stateAtom);
			const currentSelector = selectorRef.current;
			const cached = cacheRef.current;
			if (cached?.state === state && cached.selector === currentSelector) {
				return cached.selection;
			}
			const selected = currentSelector(state);
			if (cached !== null && Object.is(cached.selection, selected)) {
				cacheRef.current = {
					state,
					selector: currentSelector,
					selection: cached.selection,
				};
				return cached.selection;
			}
			cacheRef.current = {
				state,
				selector: currentSelector,
				selection: selected,
			};
			return selected;
		}, []);
		const subscribe = useCallback(
			(listener: () => void) =>
				appAtomRegistry.subscribe(stateAtom, listener, { immediate: false }),
			[],
		);
		return useSyncExternalStore(subscribe, snapshot, snapshot);
	}) as AtomStore<State>;

	useStore.getState = () => appAtomRegistry.get(stateAtom);
	useStore.getInitialState = () => initialState;
	useStore.setState = set;
	useStore.subscribe = (listener: (state: State, previous: State) => void) => {
		let previous = appAtomRegistry.get(stateAtom);
		return appAtomRegistry.subscribe(
			stateAtom,
			(state) => {
				const before = previous;
				previous = state;
				listener(state, before);
			},
			{ immediate: false },
		);
	};
	useStore.atom = stateAtom;
	return useStore;
}
