import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, router, Stack } from "expo-router";
import { Monitor, Plus, QrCode, Server } from "lucide-react-native";
import { ScrollView } from "react-native";

import { EmptyState } from "~/components/ui/empty-state";
import { ListRow, ListSection } from "~/components/ui/list";
import { optionsForConnection } from "~/lib/connection-params";
import {
  connectionStatusLabel,
  useConnectionRuntimeStore,
} from "~/store/connection-runtime";
import { useConnectionsStore } from "~/store/connections";

export default function ConnectionsScreen() {
  const { connections, hydrated, hydrate } = useConnectionsStore();
  const watchConnection = useConnectionRuntimeStore((state) => state.watch);
  const snapshots = useConnectionRuntimeStore((state) => state.snapshotsByConnection);
  const [search, setSearch] = useState("");
  const onChangeSearch = useCallback((event: { nativeEvent: { text: string } }) => {
    setSearch(event.nativeEvent.text);
  }, []);
  const searchOptions = useMemo(
    () => ({
      placeholder: "Search connections",
      placement: "stacked" as const,
      hideWhenScrolling: false,
      onChangeText: onChangeSearch,
      onCancelButtonPress: () => setSearch(""),
    }),
    [onChangeSearch]
  );

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrate, hydrated]);

  useEffect(() => {
    const unwatch = connections.map((connection) =>
      watchConnection(connection.key, optionsForConnection(connection.key, connections))
    );
    return () => {
      for (const stop of unwatch) stop();
    };
  }, [connections, watchConnection]);

  const filteredConnections = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return connections;
    return connections.filter((connection) => {
      const haystack = [
        connection.label,
        connection.key,
        connection.host,
        connection.environmentId,
        connectionStatusLabel(snapshots[connection.key]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [connections, search, snapshots]);

  return (
    <>
      <Stack.Screen
        options={{
          title: "Connections",
          headerSearchBarOptions: searchOptions,
        }}
      />
      <ScrollView
        className="flex-1 bg-background"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 p-4 pb-24"
      >
        <ListSection footer="Sign in with the same account as your Mac to see every linked computer with live presence.">
          <ListRow
            icon={Monitor}
            title="Your computers"
            subtitle="Discover devices on your account"
            onPress={() => router.push("/computers")}
          />
        </ListSection>

        {filteredConnections.length > 0 ? (
          <ListSection header="Connections">
            {filteredConnections.map((connection) => (
              <ListRow
                key={connection.key}
                icon={Server}
                iconTone="neutral"
                title={connection.label}
                subtitle={connectionStatusLabel(snapshots[connection.key])}
                onPress={() =>
                  router.push(`/c/${encodeURIComponent(connection.key)}`)
                }
              />
            ))}
          </ListSection>
        ) : (
          <EmptyState
            icon={Server}
            title={
              search.trim().length > 0 ? "No matches" : "No connections yet"
            }
            detail={
              search.trim().length > 0
                ? "Try another connection name, host, or status."
                : "Add a local server to inspect sessions and live messages."
            }
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
    </>
  );
}
