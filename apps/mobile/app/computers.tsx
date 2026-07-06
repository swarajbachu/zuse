import { useEffect, useState } from "react";
import { Host, Icon, List, ListItem } from "@expo/ui";
import { router } from "expo-router";
import { Monitor } from "lucide-react-native";
import { Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { errorTap, successTap } from "~/lib/haptics";
import { useAuthStore } from "~/store/auth";
import { useEnvironmentsStore } from "~/store/environments";

const LIME = "hsl(72 98% 54%)";
const MUTED = "hsl(72 2% 64%)";
const AMBER = "hsl(42 93% 56%)";
const DANGER = "hsl(2 86% 64%)";

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
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrate, hydrated]);

  useEffect(() => {
    if (account !== null) void refresh();
  }, [account, refresh]);

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

  if (account === null) {
    return (
      <View className="flex-1 bg-background">
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

  const presenceLabel = (environmentId: string, presence: string) => {
    if (connecting === environmentId) return "Connecting…";
    if (presence === "online") return "Online";
    if (presence === "offline") return "Offline";
    return "Checking…";
  };

  const presenceColor = (presence: string) =>
    presence === "online" ? LIME : presence === "offline" ? MUTED : AMBER;

  return (
    <View className="flex-1 bg-background">
      <Host
        colorScheme="dark"
        seedColor={LIME}
        style={{ width: "100%", height: "100%" }}
      >
        <List onRefresh={() => refresh()}>
          {environments.map((environment) => (
            <ListItem
              key={environment.environmentId}
              onPress={() => void onConnect(environment.environmentId)}
              leading={
                <Icon
                  name="laptopcomputer"
                  size={22}
                  color={presenceColor(environment.presence)}
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

      {environments.length === 0 && !loading ? (
        <View className="absolute inset-x-0 top-40 px-8">
          <Text className="text-center font-sans text-sm text-muted-foreground">
            No computers yet. Open Settings → Devices on your Mac and link it to
            your account.
          </Text>
        </View>
      ) : null}

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
