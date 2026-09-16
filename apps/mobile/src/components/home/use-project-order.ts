import * as SecureStore from "expo-secure-store";
import { useEffect, useRef, useState } from "react";
import { Alert } from "react-native";

const KEY = "zuse.mobile.project-order.v1";
export function useProjectOrder() {
	const [order, setOrder] = useState<readonly string[]>([]);
	const [ready, setReady] = useState(false);
	const writes = useRef(Promise.resolve());
	useEffect(() => {
		let mounted = true;
		void SecureStore.getItemAsync(KEY)
			.then((raw) => {
				const parsed: unknown = raw ? JSON.parse(raw) : [];
				if (mounted && Array.isArray(parsed))
					setOrder(
						parsed.filter((item): item is string => typeof item === "string"),
					);
			})
			.catch(() => {})
			.finally(() => {
				if (mounted) setReady(true);
			});
		return () => {
			mounted = false;
		};
	}, []);
	const save = (next: readonly string[]) => {
		setOrder(next);
		writes.current = writes.current
			.then(() => SecureStore.setItemAsync(KEY, JSON.stringify(next)))
			.catch(() => {
				Alert.alert(
					"Order couldn't be saved",
					"Your order will last for this session. Try reordering again to save it.",
				);
			});
	};
	return { order, ready, save };
}
