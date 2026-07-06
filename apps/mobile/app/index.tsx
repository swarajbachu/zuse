import { useEffect } from "react";
import { Link, router } from "expo-router";
import { Monitor, Plus, QrCode, Server } from "lucide-react-native";
import { ScrollView } from "react-native";

import { EmptyState } from "~/components/ui/empty-state";
import { ListRow, ListSection } from "~/components/ui/list";
import { useConnectionsStore } from "~/store/connections";

export default function ConnectionsScreen() {
  const { connections, hydrated, hydrate } = useConnectionsStore();

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrate, hydrated]);

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 p-4 pb-16"
    >
      <ListSection footer="Sign in with the same account as your Mac to see every linked computer with live presence.">
        <ListRow
          icon={Monitor}
          title="Your computers"
          subtitle="Discover devices on your account"
          onPress={() => router.push("/computers")}
        />
      </ListSection>

      {connections.length > 0 ? (
        <ListSection header="Connections">
          {connections.map((connection) => (
            <ListRow
              key={connection.key}
              icon={Server}
              iconTone="neutral"
              title={connection.label}
              subtitle={
                connection.token ? "Pairing token saved" : "Manual connection"
              }
              onPress={() =>
                router.push(`/c/${encodeURIComponent(connection.key)}`)
              }
            />
          ))}
        </ListSection>
      ) : (
        <EmptyState
          icon={Server}
          title="No connections yet"
          detail="Add a local server to inspect sessions and live messages."
        />
      )}

      <ListSection footer="Enter a host and port, or scan a pairing code shown on your Mac.">
        <ListRow
          icon={Plus}
          iconTone="neutral"
          title="Add manually"
          onPress={() => router.push("/connect/manual")}
        />
        <ListRow
          icon={QrCode}
          iconTone="neutral"
          title="Scan QR code"
          onPress={() => router.push("/connect/scan")}
        />
      </ListSection>

      <Link
        href="/smoke"
        className="text-center font-sans text-xs text-muted-foreground"
      >
        Open Hermes/effect smoke screen
      </Link>
    </ScrollView>
  );
}
