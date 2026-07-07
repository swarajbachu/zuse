import type {
  Folder,
  GitBranchInfo,
  GitPrSummary,
  Worktree,
} from "@zuse/wire";
import { Effect } from "effect";
import { router, Stack } from "expo-router";
import { CloudOff, Send } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  createWorktree,
  listBranches,
  listPullRequests,
  listWorktrees,
} from "~/rpc/actions";
import { optionsForConnection } from "~/lib/connection-params";
import {
  buildNewChatCreatePayload,
  MAIN_SOURCE,
  type NewChatSource,
} from "~/lib/new-chat";
import {
  defaultModelForProvider,
} from "~/lib/model-options";
import { useConnectionsStore } from "~/store/connections";
import { useSessionsStore } from "~/store/sessions";
import { Button } from "~/components/ui/button";
import { GlassSurface } from "~/components/ui/glass-surface";
import {
  ComposerModelMenu,
  NativeButton,
  ProjectPill,
  SourcePill,
  type ModelModeValue,
} from "~/components/model-mode-menu";

export default function NewChatScreen() {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedConnectionKey, setSelectedConnectionKey] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<Folder["id"] | null>(null);
  const [source, setSource] = useState<NewChatSource>(MAIN_SOURCE);
  const [modelMode, setModelMode] = useState<ModelModeValue>({
    providerId: "codex",
    model: defaultModelForProvider("codex"),
    runtimeMode: "approval-required",
    permissionMode: "default",
  });
  const [worktrees, setWorktrees] = useState<readonly Worktree[]>([]);
  const [branches, setBranches] = useState<readonly GitBranchInfo[]>([]);
  const [prs, setPrs] = useState<readonly GitPrSummary[]>([]);

  const {
    connections,
    hydrated,
    hydrate: hydrateConnections,
  } = useConnectionsStore();
  const {
    bundlesByConnection,
    loadingByConnection,
    hydrate: hydrateSessions,
    createChat,
  } = useSessionsStore();

  useEffect(() => {
    if (!hydrated) void hydrateConnections();
  }, [hydrateConnections, hydrated]);

  useEffect(() => {
    for (const connection of connections) {
      const options = optionsForConnection(connection.key, connections);
      if (options !== null) void hydrateSessions(connection.key, options);
    }
  }, [connections, hydrateSessions]);

  const effectiveConnectionKey =
    selectedConnectionKey ?? connections[0]?.key ?? null;

  const projectChoices = useMemo(() => {
    if (effectiveConnectionKey === null) return [];
    return (bundlesByConnection[effectiveConnectionKey] ?? []).map((bundle) => ({
      project: bundle.project,
      connectionKey: effectiveConnectionKey,
    }));
  }, [bundlesByConnection, effectiveConnectionKey]);

  const projectMenuGroups = useMemo(
    () =>
      connections.map((connection) => ({
        connectionKey: connection.key,
        connectionLabel: connection.label,
        projects: (bundlesByConnection[connection.key] ?? []).map((bundle) => ({
          id: bundle.project.id,
          name: bundle.project.name,
          path: bundle.project.path,
        })),
      })),
    [bundlesByConnection, connections],
  );

  const effectiveProjectId =
    selectedProjectId !== null &&
    projectChoices.some((item) => item.project.id === selectedProjectId)
      ? selectedProjectId
      : (projectChoices[0]?.project.id ?? null);

  const selectedOptions = useMemo(
    () =>
      effectiveConnectionKey === null
        ? null
        : optionsForConnection(effectiveConnectionKey, connections),
    [connections, effectiveConnectionKey],
  );

  useEffect(() => {
    if (selectedOptions === null || effectiveProjectId === null) return;
    let cancelled = false;
    void Promise.all([
      Effect.runPromise(
        listWorktrees({ connection: selectedOptions, projectId: effectiveProjectId }),
      ).catch(() => [] as readonly Worktree[]),
      Effect.runPromise(
        listBranches({ connection: selectedOptions, projectId: effectiveProjectId }),
      ),
      Effect.runPromise(
        listPullRequests({ connection: selectedOptions, projectId: effectiveProjectId }),
      ),
    ]).then(([nextWorktrees, nextBranches, nextPrs]) => {
      if (cancelled) return;
      setWorktrees(nextWorktrees);
      setBranches(nextBranches);
      setPrs(nextPrs);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedOptions, effectiveProjectId]);

  const loading = Object.values(loadingByConnection).some(Boolean);
  const selectedProject = projectChoices.find(
    (item) => item.project.id === effectiveProjectId,
  )?.project;
  const sourceLabel = source.kind === "main" ? "Main" : source.label;
  const canSubmit =
    effectiveConnectionKey !== null &&
    selectedOptions !== null &&
    effectiveProjectId !== null &&
    text.trim().length > 0 &&
    !submitting;

  const submit = useCallback(async () => {
    const payload = buildNewChatCreatePayload({
      connectionKey: effectiveConnectionKey,
      projectId: effectiveProjectId,
      providerId: modelMode.providerId,
      model: modelMode.model,
      runtimeMode: modelMode.runtimeMode,
      permissionMode: modelMode.permissionMode,
      source,
      text,
    });
    if (payload === null || effectiveConnectionKey === null || selectedOptions === null) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const worktreeId =
        payload.createSource === null
          ? payload.worktreeId
          : (
              await Effect.runPromise(
                createWorktree({
                  connection: selectedOptions,
                  projectId: payload.projectId,
                  source: payload.createSource,
                }),
              )
            ).id;
      const result = await createChat(effectiveConnectionKey, selectedOptions, {
        projectId: payload.projectId,
        providerId: payload.providerId,
        model: payload.model,
        initialPrompt: payload.initialPrompt,
        runtimeMode: payload.runtimeMode,
        permissionMode: payload.permissionMode,
        worktreeId,
      });
      router.replace(
        `/c/${encodeURIComponent(effectiveConnectionKey)}/session/${encodeURIComponent(
          result.initialSession.id,
        )}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }, [
    createChat,
    modelMode,
    effectiveConnectionKey,
    selectedOptions,
    effectiveProjectId,
    source,
    text,
  ]);

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-background">
      <Stack.Screen options={{ title: "New Chat" }} />
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 18, paddingBottom: 180, gap: 18, flexGrow: 1 }}
      >
        <View className="flex-1" />

        {error === null ? null : (
          <Text selectable className="font-sans text-[13px] leading-5 text-danger">
            {error}
          </Text>
        )}
      </ScrollView>

      <View
        className="border-t border-border px-3 pt-3"
        style={{ paddingBottom: insets.bottom > 0 ? insets.bottom : 12 }}
      >
        <GlassSurface
          style={{
            flexDirection: "row",
            alignItems: "flex-end",
            gap: 8,
            padding: 8,
          }}
        >
          <View className="min-w-0 flex-1 gap-2">
            <View className="flex-row flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                className="h-10 w-10 rounded-full px-0"
              >
                <Text className="font-sans text-[26px] leading-7 text-foreground">+</Text>
              </Button>
              <ProjectPill
                label={
                  selectedProject === undefined
                    ? loading
                      ? "Loading projects"
                      : "Project"
                    : selectedProject.name
                }
                options={projectMenuGroups}
                onSelect={(connectionKey, projectId) => {
                  setSelectedConnectionKey(connectionKey);
                  setSelectedProjectId(projectId as Folder["id"]);
                  setSource(MAIN_SOURCE);
                }}
              />
              <SourcePill label={sourceLabel}>
                <NativeButton
                  label="Main"
                  systemImage={source.kind === "main" ? "checkmark" : "folder"}
                  onPress={() => setSource(MAIN_SOURCE)}
                />
                {worktrees.slice(0, 8).map((worktree) => (
                  <NativeButton
                    key={worktree.id}
                    label={worktree.branch}
                    systemImage={
                      source.kind === "worktree" && source.worktreeId === worktree.id
                        ? "checkmark"
                        : "point.topleft.down.curvedto.point.bottomright.up"
                    }
                    onPress={() =>
                      setSource({
                        kind: "worktree",
                        label: worktree.branch,
                        worktreeId: worktree.id,
                      })
                    }
                  />
                ))}
                {branches
                  .filter((branch) => !branch.current)
                  .slice(0, 8)
                  .map((branch) => (
                    <NativeButton
                      key={`${branch.kind}:${branch.name}`}
                      label={branch.name}
                      systemImage={
                        source.kind === "branch" && source.label === branch.name
                          ? "checkmark"
                          : "arrow.branch"
                      }
                      onPress={() =>
                        setSource({
                          kind: "branch",
                          label: branch.name,
                          worktreeId: null,
                          createSource: {
                            _tag: "branch",
                            branch: branch.name,
                            remote: branch.remote,
                          },
                        })
                      }
                    />
                  ))}
                {prs.slice(0, 8).map((pr) => (
                  <NativeButton
                    key={`pr:${pr.number}`}
                    label={`#${pr.number} ${pr.title}`}
                    systemImage={
                      source.kind === "pr" && source.label === `#${pr.number}`
                        ? "checkmark"
                        : "arrow.triangle.pull"
                    }
                    onPress={() =>
                      setSource({
                        kind: "pr",
                        label: `#${pr.number}`,
                        worktreeId: null,
                        createSource: {
                          _tag: "pr",
                          number: pr.number,
                          headRefName: pr.headRefName,
                        },
                      })
                    }
                  />
                ))}
              </SourcePill>
            </View>
            <TextInput
              className="min-h-10 px-2 py-2 font-sans text-[17px] text-foreground"
              multiline
              placeholder="Ask Zuse"
              placeholderTextColor="hsl(72 4% 56%)"
              value={text}
              onChangeText={setText}
            />
            <View className="flex-row items-center justify-between">
              <View className="h-10 w-10" />
              <ComposerModelMenu
                value={modelMode}
                editable
                onChange={setModelMode}
              />
            </View>
          </View>
          <Button
            variant="primary"
            disabled={!canSubmit}
            onPress={() => void submit()}
          >
            {submitting ? (
              <ActivityIndicator color="hsl(72 5% 6%)" />
            ) : selectedOptions === null ? (
              <CloudOff size={16} color="hsl(72 5% 6%)" />
            ) : (
              <Send size={16} color="hsl(72 5% 6%)" />
            )}
          </Button>
        </GlassSurface>
      </View>
    </KeyboardAvoidingView>
  );
}
