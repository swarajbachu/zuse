import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  clearLastCrashReport,
  readLastCrashReport,
  type CrashReport,
} from "~/lib/crash-reporting";

export const CrashReportOverlay = () => {
  const insets = useSafeAreaInsets();
  const [report, setReport] = useState<CrashReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readLastCrashReport().then((next) => {
      if (!cancelled) {
        setReport(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (report === null) {
    return null;
  }

  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 z-50 px-3"
      style={{ top: insets.top + 8 }}
    >
      <View
        className="rounded-2xl border border-danger/35 bg-background/95 px-3 py-2 shadow-xl"
        style={{ borderCurve: "continuous" }}
      >
        <View className="flex-row items-center gap-2">
          <Text className="font-sans-medium text-xs text-danger">
            Last crash
          </Text>
          <Text
            className="min-w-0 flex-1 font-sans text-[11px] text-muted-foreground"
            numberOfLines={1}
          >
            {report.context} · {new Date(report.at).toLocaleTimeString()}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              setReport(null);
              void clearLastCrashReport();
            }}
            className="rounded-full bg-muted px-2 py-1 active:opacity-75"
          >
            <Text className="font-sans-medium text-[11px] text-foreground">
              Dismiss
            </Text>
          </Pressable>
        </View>
        <Text
          selectable
          className="mt-1 font-sans text-xs leading-4 text-foreground"
          numberOfLines={3}
        >
          {report.message}
        </Text>
      </View>
    </View>
  );
};
