import { useEffect, useState } from "react";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { QrCode } from "lucide-react-native";
import { Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { successTap } from "~/lib/haptics";
import { parsePairingUrl } from "~/offline/cache-utils";
import { useConnectionsStore } from "~/store/connections";

export default function ScanScreen() {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const add = useConnectionsStore((state) => state.add);

  useEffect(() => {
    if (permission !== null && !permission.granted && permission.canAskAgain) {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  if (permission === null || !permission.granted) {
    return (
      <View className="flex-1 bg-background px-4">
        <EmptyState
          icon={QrCode}
          title="Camera permission required"
          detail="The scanner only reads Track C pairing URLs."
        />
        <View style={{ paddingBottom: insets.bottom + 16 }}>
          <Button onPress={requestPermission}>Allow camera</Button>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <CameraView
        className="flex-1"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={
          scanned
            ? undefined
            : async ({ data }) => {
                setScanned(true);
                try {
                  const parsed = parsePairingUrl(data);
                  const record = await add(parsed);
                  successTap();
                  router.replace(`/c/${encodeURIComponent(record.key)}`);
                } catch {
                  setScanned(false);
                }
              }
        }
      />
      <View
        className="border-t border-border bg-background px-4 pt-4"
        style={{ paddingBottom: insets.bottom + 16 }}
      >
        <Text className="text-center font-sans text-sm text-muted-foreground">
          Scan a zuse:// pairing QR code.
        </Text>
      </View>
    </View>
  );
}
