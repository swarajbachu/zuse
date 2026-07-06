import { useEffect, useState } from "react";
import { router } from "expo-router";
import { Monitor } from "lucide-react-native";
import { Pressable, ScrollView, Text, View } from "react-native";

import { Button } from "~/components/ui/button";
import { EmptyState } from "~/components/ui/empty-state";
import { useAuthStore } from "~/store/auth";
import { useEnvironmentsStore } from "~/store/environments";

/**
 * "Your computers" — the account-based discovery surface. Sign in once with the
 * same account as the desktop and every linked computer shows up here with live
 * presence; tapping one connects through the relay.
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
      router.push(`/c/${encodeURIComponent(key)}`);
    } catch (cause) {
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

  return (
    <View className="flex-1 bg-background">
      <ScrollView contentContainerClassName="gap-3 p-4">
        {environments.length === 0 && !loading ? (
          <EmptyState
            icon={Monitor}
            title="No computers yet"
            detail="Open Settings → Devices on your Mac and link it to your account."
          />
        ) : (
          environments.map((environment) => (
            <Pressable
              key={environment.environmentId}
              onPress={() => void onConnect(environment.environmentId)}
              disabled={connecting !== null}
              className="flex-row items-center justify-between rounded-xl border border-border bg-card p-4"
            >
              <View className="flex-row items-center gap-3">
                <View
                  className={
                    environment.presence === "online"
                      ? "size-2.5 rounded-full bg-emerald-500"
                      : environment.presence === "offline"
                        ? "size-2.5 rounded-full bg-muted-foreground/40"
                        : "size-2.5 rounded-full bg-amber-400"
                  }
                />
                <View>
                  <Text className="font-sans-medium text-sm text-foreground">
                    {environment.label}
                  </Text>
                  <Text className="font-sans text-xs text-muted-foreground">
                    {connecting === environment.environmentId
                      ? "Connecting…"
                      : environment.presence === "online"
                        ? "Online"
                        : environment.presence === "offline"
                          ? "Offline"
                          : "Checking…"}
                  </Text>
                </View>
              </View>
            </Pressable>
          ))
        )}

        {error !== null && (
          <Text className="font-sans text-xs text-destructive">{error}</Text>
        )}
        {connectError !== null && (
          <Text className="font-sans text-xs text-destructive">
            {connectError}
          </Text>
        )}
      </ScrollView>

      <View className="gap-3 border-t border-border p-4">
        <Button variant="secondary" onPress={() => void refresh()}>
          Refresh
        </Button>
        <Pressable onPress={() => void signOut()}>
          <Text className="text-center font-sans text-xs text-muted-foreground">
            Signed in{account.email ? ` as ${account.email}` : ""} · Sign out
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
