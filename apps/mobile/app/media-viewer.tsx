import { Image } from "expo-image";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Download, Share2, X } from "lucide-react-native";
import { useCallback, useRef, useState } from "react";
import {
	Alert,
	Pressable,
	ScrollView,
	Share,
	Text,
	useWindowDimensions,
	View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { saveImageToPhotos } from "../modules/mobile-platform";

export default function MediaViewerScreen() {
	const { width, height } = useWindowDimensions();
	const insets = useSafeAreaInsets();
	const [zoomScale, setZoomScale] = useState(1);
	const lastTapRef = useRef(0);
	const { uri: rawUri, name: rawName } = useLocalSearchParams<{
		uri: string;
		name?: string;
	}>();
	const uri = typeof rawUri === "string" ? rawUri : "";
	const name =
		typeof rawName === "string" && rawName.length > 0 ? rawName : "Image";

	const share = useCallback(async () => {
		try {
			await Share.share({ url: uri, title: name });
		} catch (cause) {
			Alert.alert(
				"Couldn’t share image",
				cause instanceof Error ? cause.message : String(cause),
			);
		}
	}, [name, uri]);

	const save = useCallback(async () => {
		try {
			const saved = await saveImageToPhotos(uri);
			Alert.alert(
				saved ? "Saved to Photos" : "Couldn’t save image",
				saved
					? undefined
					: "Allow photo-library access in iPhone Settings and try again.",
			);
		} catch {
			Alert.alert("Couldn’t save image", "The image could not be saved.");
		}
	}, [uri]);

	const toggleZoomOnDoubleTap = () => {
		const now = Date.now();
		if (now - lastTapRef.current < 300) {
			setZoomScale((current) => (current > 1 ? 1 : 2));
			lastTapRef.current = 0;
			return;
		}
		lastTapRef.current = now;
	};

	return (
		<View className="flex-1 bg-black">
			<Stack.Screen
				options={{
					headerShown: false,
					presentation: "fullScreenModal",
				}}
			/>
			<ScrollView
				style={{ flex: 1 }}
				contentContainerStyle={{
					minWidth: width,
					minHeight: height,
					alignItems: "center",
					justifyContent: "center",
				}}
				centerContent
				maximumZoomScale={5}
				minimumZoomScale={1}
				zoomScale={zoomScale}
				bouncesZoom
				showsHorizontalScrollIndicator={false}
				showsVerticalScrollIndicator={false}
			>
				<Pressable onPress={toggleZoomOnDoubleTap}>
					<Image
						source={{ uri }}
						style={{ width, height }}
						contentFit="contain"
						accessibilityLabel={name}
					/>
				</Pressable>
			</ScrollView>
			<View
				className="absolute left-0 right-0 top-0 flex-row items-center justify-between px-3"
				style={{ paddingTop: insets.top + 6 }}
			>
				<Pressable
					accessibilityRole="button"
					accessibilityLabel="Close image"
					onPress={() => router.back()}
					className="h-11 w-11 items-center justify-center rounded-full bg-black/55"
				>
					<X size={22} color="#fff" />
				</Pressable>
				<Text
					numberOfLines={1}
					className="mx-3 flex-1 text-center font-sans-medium text-sm text-white"
				>
					{name}
				</Text>
				<View className="flex-row gap-2">
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Save image"
						onPress={() => void save()}
						className="h-11 w-11 items-center justify-center rounded-full bg-black/55"
					>
						<Download size={20} color="#fff" />
					</Pressable>
					<Pressable
						accessibilityRole="button"
						accessibilityLabel="Share image"
						onPress={() => void share()}
						className="h-11 w-11 items-center justify-center rounded-full bg-black/55"
					>
						<Share2 size={21} color="#fff" />
					</Pressable>
				</View>
			</View>
		</View>
	);
}
