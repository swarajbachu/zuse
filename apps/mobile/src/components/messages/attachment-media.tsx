import type { AttachmentRef, SessionId } from "@zuse/contracts";
import { Effect } from "effect";
import { Image } from "expo-image";
import { router } from "expo-router";
import { FileText } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { cacheMediaBytes, readCachedMedia } from "~/lib/media-cache";
import { readAttachment } from "~/rpc/actions";
import type { WsProtocolOptions } from "~/rpc/ws-protocol";

export function AttachmentMedia({
	attachment,
	connectionKey,
	connection,
	sessionId,
}: {
	attachment: AttachmentRef;
	connectionKey: string;
	connection?: WsProtocolOptions;
	sessionId: SessionId;
}) {
	const [uri, setUri] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const image = attachment.mimeType.startsWith("image/");

	useEffect(() => {
		if (!image || connection === undefined) return;
		let active = true;
		const key = `attachment-${attachment.id}`;
		void (async () => {
			const cached = await readCachedMedia(connectionKey, key);
			if (cached !== null) {
				if (active) setUri(cached.uri);
				return;
			}
			try {
				const result = await Effect.runPromise(
					readAttachment({
						connection,
						sessionId,
						id: attachment.id,
					}),
				);
				const nextUri = await cacheMediaBytes({
					connectionKey,
					key,
					bytes: result.bytes,
					mimeType: result.mimeType,
					originalName: result.originalName,
				});
				if (active) setUri(nextUri);
			} catch {
				if (active) setFailed(true);
			}
		})();
		return () => {
			active = false;
		};
	}, [attachment, connection, connectionKey, image, sessionId]);

	if (!image || failed || connection === undefined) {
		return (
			<View className="min-h-11 flex-row items-center gap-2 rounded-xl bg-background/15 px-3 py-2">
				<FileText size={17} color="#fff" />
				<Text
					numberOfLines={1}
					className="max-w-52 font-sans text-xs text-primary-foreground"
				>
					{attachment.originalName}
				</Text>
			</View>
		);
	}

	if (uri === null) {
		return (
			<View className="h-32 w-52 items-center justify-center">
				<ActivityIndicator color="#fff" />
			</View>
		);
	}

	return (
		<Pressable
			accessibilityRole="imagebutton"
			accessibilityLabel={`Open ${attachment.originalName}`}
			onPress={() =>
				router.push({
					pathname: "/media-viewer",
					params: { uri, name: attachment.originalName },
				})
			}
			className="overflow-hidden rounded-xl active:opacity-80"
		>
			<Image
				source={{ uri }}
				style={{ width: 208, height: 156 }}
				contentFit="cover"
				accessibilityLabel={attachment.originalName}
			/>
		</Pressable>
	);
}
