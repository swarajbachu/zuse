import { useEffect, useMemo, useState } from "react";
import { Link, router } from "expo-router";
import { QrCode, Server } from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";

import { ConnectionCard } from "~/components/connection-card";
import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { Input } from "~/components/ui/input";
import { Sheet } from "~/components/ui/sheet";
import { useConnectionsStore } from "~/store/connections";

export default function ConnectionsScreen() {
  const { connections, hydrated, hydrate, add } = useConnectionsStore();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("8787");
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrate, hydrated]);

  const canAdd = useMemo(() => host.trim().length > 0 && Number(port) > 0, [host, port]);

  const submit = async () => {
    if (!canAdd) return;
    const record = await add({ host, port: Number(port), token });
    setSheetOpen(false);
    router.push(`/c/${encodeURIComponent(record.key)}`);
  };

  return (
    <View className="flex-1 bg-background">
      {connections.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No connections"
          detail="Add a local server to inspect sessions and live messages."
        />
      ) : (
        <ScrollView contentContainerClassName="gap-3 p-4">
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.key}
              connection={connection}
              onPress={() => router.push(`/c/${encodeURIComponent(connection.key)}`)}
            />
          ))}
        </ScrollView>
      )}

      <View className="gap-3 border-t border-border p-4">
        <View className="flex-row gap-3">
          <Button className="flex-1" onPress={() => setSheetOpen(true)}>
            Add connection
          </Button>
          <Button variant="secondary" onPress={() => router.push("/connect/scan")}>
            <QrCode size={16} color="hsl(72 4% 92%)" /> Scan
          </Button>
        </View>
        <Link href="/smoke" className="text-center font-sans text-xs text-muted-foreground">
          Open Hermes/effect smoke screen
        </Link>
      </View>

      <Sheet visible={sheetOpen} title="Add connection" onClose={() => setSheetOpen(false)}>
        <View className="gap-3">
          <Text className="font-sans-medium text-sm text-foreground">Host</Text>
          <Input value={host} onChangeText={setHost} autoCapitalize="none" autoCorrect={false} />
          <Text className="font-sans-medium text-sm text-foreground">Port</Text>
          <Input value={port} onChangeText={setPort} keyboardType="number-pad" />
          <Text className="font-sans-medium text-sm text-foreground">Token</Text>
          <Input
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Optional until Track C"
          />
          <Button disabled={!canAdd} onPress={submit}>
            Save
          </Button>
        </View>
      </Sheet>
    </View>
  );
}
