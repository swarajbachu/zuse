import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Host, Icon, List, ListItem } from "@expo/ui";
import { router, Stack } from "expo-router";
import { Monitor } from "lucide-react-native";
import { Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { errorTap, selectionTap, successTap } from "~/lib/haptics";
import { useAuthStore } from "~/store/auth";
import {
  connectionStatusLabel,
  useConnectionRuntimeStore,
} from "~/store/connection-runtime";
import { useConnectionsStore } from "~/store/connections";
import { useEnvironmentsStore } from "~/store/environments";

const LIME = "hsl(72 98% 54%)";
const MUTED = "hsl(72 2% 64%)";
const DANGER = "hsl(2 86% 64%)";

// A checking/connecting environment can't host an RN pulsing dot inside the
// native @expo/ui list, so its laptop glyph "breathes" by cycling the amber
// color. Four steps (full → mid → dim → mid) read as a smooth pulse while
// staying dependency-free and cheap — it only runs while something is pending.
const AMBER_PULSE = [
  "hsl(42 93% 56%)",
  "hsl(42 86% 46%)",
  "hsl(42 72% 34%)",
  "hsl(42 86% 46%)",
] as const;

const isChecking = (presence: string) =>
  presence !== "online" && presence !== "offline";

function useAmberPulse(active: boolean) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(
      () => setStep((n) => (n + 1) % AMBER_PULSE.length),
      360
    );
    return () => clearInterval(id);
  }, [active]);
  // When inactive no row reads this value, so a stale step is harmless.
  return active ? AMBER_PULSE[step] : AMBER_PULSE[0];
}

/**
 * "Your computers" — the account discovery surface, rendered with real native
 * SwiftUI via @expo/ui (`Host` → `List`/`ListItem`). Sign in once with the same
 * account as the desktop and every linked computer shows up here with live
 * presence; tapping one connects through the relay. The lime brand accent is
 * carried into the native theme through `Host`'s `seedColor`.
 */
export default function ComputersScreen() {
  const { account, hydrated, busy, hydrate, signIn, signOut } = useAuthStore();
  const { environments, loading, error, refresh, connect } =
    useEnvironmentsStore();
  const connections = useConnectionsStore((state) => state.connections);
  const snapshots = useConnectionRuntimeStore((state) => state.snapshotsByConnection);
  const watchConnection = useConnectionRuntimeStore((state) => state.watch);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const onChangeSearch = useCallback((event: { nativeEvent: { text: string } }) => {
    setSearch(event.nativeEvent.text);
  }, []);
  const searchOptions = useMemo(
    () => ({
      placeholder: "Search computers",
      placement: "stacked" as const,
      hideWhenScrolling: false,
      onChangeText: onChangeSearch,
      onCancelButtonPress: () => setSearch(""),
    }),
    [onChangeSearch]
  );

  const anyPulsing =
    connecting !== null || environments.some((e) => isChecking(e.presence));
  const pulseColor = useAmberPulse(anyPulsing);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrate, hydrated]);

  useEffect(() => {
    if (account !== null) void refresh();
  }, [account, refresh]);

  useEffect(() => {
    const unwatch = environments
      .map((environment) =>
        connections.find(
          (connection) => connection.environmentId === environment.environmentId
        )
      )
      .filter((connection) => connection !== undefined)
      .map((connection) => watchConnection(connection.key, connection));
    return () => {
      for (const stop of unwatch) stop();
    };
  }, [connections, environments, watchConnection]);

  // Subtle selection tick when a computer comes online.
  const prevPresence = useRef(new Map<string, string>());
  useEffect(() => {
    const prev = prevPresence.current;
    for (const env of environments) {
      const before = prev.get(env.environmentId);
      if (before !== undefined && before !== "online" && env.presence === "online") {
        selectionTap();
      }
      prev.set(env.environmentId, env.presence);
    }
  }, [environments]);

  const onConnect = async (environmentId: string) => {
    setConnecting(environmentId);
    setConnectError(null);
    try {
      const key = await connect(environmentId);
      successTap();
      router.push(`/c/${encodeURIComponent(key)}`);
    } catch (cause) {
      errorTap();
      setConnectError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(null);
    }
  };

  const presenceLabel = useCallback((environmentId: string, presence: string) => {
    if (connecting === environmentId) return "Connecting…";
    const snapshot = snapshots[environmentId];
    if (snapshot !== undefined && snapshot.status !== "connected") {
      return connectionStatusLabel(snapshot);
    }
    if (presence === "online") return "Online";
    if (presence === "offline") return "Offline";
    return "Checking…";
  }, [connecting, snapshots]);

  const filteredEnvironments = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (query.length === 0) return environments;
    return environments.filter((environment) => {
      const connection = connections.find(
        (item) => item.environmentId === environment.environmentId
      );
      const haystack = [
        environment.label,
        environment.environmentId,
        environment.presence,
        connection?.label,
        connection?.key,
        presenceLabel(environment.environmentId, environment.presence),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [connections, environments, presenceLabel, search]);

  const presenceColor = (environmentId: string, presence: string) => {
    if (connecting === environmentId || isChecking(presence)) return pulseColor;
    return presence === "online" ? LIME : MUTED;
  };

  if (account === null) {
    return (
      <View className="flex-1 bg-background">
        <Stack.Screen
          options={{
            title: "Computers",
            headerSearchBarOptions: searchOptions,
          }}
        />
        <EmptyState
          icon={Monitor}
          title="Sign in to see your computers"
          detail="Use the same account you're signed into on your Mac."
        />
        <View className="p-4">
          <Button disabled={busy} onPress={() => void signIn()}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <Stack.Screen
        options={{
          title: "Computers",
          headerSearchBarOptions: searchOptions,
        }}
      />
      <Host
        colorScheme="dark"
        seedColor={LIME}
        style={{ width: "100%", height: "100%" }}
      >
        <List onRefresh={() => refresh()}>
          {filteredEnvironments.map((environment) => (
            <ListItem
              key={environment.environmentId}
              onPress={() => void onConnect(environment.environmentId)}
              leading={
                <Icon
                  name="laptopcomputer"
                  size={22}
                  color={presenceColor(
                    environment.environmentId,
                    environment.presence
                  )}
                />
              }
              supportingText={presenceLabel(
                environment.environmentId,
                environment.presence
              )}
              trailing={<Icon name="chevron.right" size={14} color={MUTED} />}
            >
              {environment.label}
            </ListItem>
          ))}

          {filteredEnvironments.length === 0 && !loading ? (
            <ListItem
              leading={<Icon name="laptopcomputer.slash" size={22} color={MUTED} />}
              supportingText={
                search.trim().length > 0
                  ? "Try another name or status."
                  : "Open Settings -> Devices on your Mac and link it to your account."
              }
            >
              {search.trim().length > 0 ? "No matches" : "No computers yet"}
            </ListItem>
          ) : null}

          {account.email ? (
            <ListItem
              leading={<Icon name="person.crop.circle" size={22} color={MUTED} />}
              supportingText={account.email}
            >
              Signed in
            </ListItem>
          ) : null}
          <ListItem
            onPress={() => void signOut()}
            leading={
              <Icon
                name="rectangle.portrait.and.arrow.right"
                size={20}
                color={DANGER}
              />
            }
          >
            Sign out
          </ListItem>
        </List>
      </Host>

      {(error ?? connectError) !== null ? (
        <View
          className="absolute inset-x-0 bottom-0 border-t border-border bg-background p-4"
          pointerEvents="none"
        >
          <Text selectable className="font-sans text-[13px] text-danger">
            {connectError ?? error}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
