import { SqlClient } from "effect/unstable/sql";
import { Deferred, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  PermissionKind,
  PermissionRequest,
  PermissionRequestNotFoundError,
  SavedDecision,
  type FolderId,
  type PermissionDecision,
  type SessionId,
} from "@zuse/contracts";

import { AppPaths } from "../../app-paths.ts";
import {
  PermissionService,
  type PermissionServiceShape,
} from "../services/permission-service.ts";

interface PendingEntry {
  readonly request: PermissionRequest;
  readonly deferred: Deferred.Deferred<PermissionDecision>;
}

interface DecisionRow {
  readonly request_id: string;
  readonly session_id: string;
  readonly project_id: string | null;
  readonly kind_tag: string;
  readonly kind_key: string;
  readonly kind_json: string;
  readonly decision: string;
  readonly scope: string;
  readonly decided_at: string;
}

/**
 * Decisions that should map to `scope='folder'`. Only `AlwaysAllow` is
 * folder-scoped today; everything else stays session-scoped (even denials,
 * which we keep for inspector visibility).
 */
const scopeForDecision = (decision: PermissionDecision): "session" | "folder" =>
  decision._tag === "AlwaysAllow" ? "folder" : "session";

const decodeSavedDecision = Schema.decodeUnknown(SavedDecision);

const rowToSavedDecision = (
  row: DecisionRow,
): Effect.Effect<SavedDecision, never> =>
  decodeSavedDecision({
    requestId: row.request_id,
    sessionId: row.session_id,
    projectId: row.project_id,
    kind: JSON.parse(row.kind_json),
    decision: row.decision,
    scope: row.scope,
    decidedAt: row.decided_at,
  }).pipe(
    Effect.catch(() =>
      // Bad row (corrupted scope/decision string) — surface a synthetic Deny
      // so the inspector still renders. Better than crashing the whole list.
      decodeSavedDecision({
        requestId: row.request_id,
        sessionId: row.session_id,
        projectId: row.project_id,
        kind: { _tag: "Other", tool: row.kind_tag, summary: row.kind_key },
        decision: "Deny",
        scope: "session",
        decidedAt: row.decided_at,
      }).pipe(Effect.orDie),
    ),
  );

/**
 * Stable per-kind matching key. Equality on this string is what lets
 * `AllowForSession` short-circuit a re-prompt — exact-match only, no
 * prefix / glob (kept deliberate per the Phase 4 plan; smarter matchers
 * are deferred).
 */
const kindKey = (kind: PermissionKind): string => {
  switch (kind._tag) {
    case "FileWrite":
      return kind.path;
    case "Bash":
      return kind.command;
    case "Network":
      return kind.url;
    case "Other":
      return `${kind.tool}:${kind.summary}`;
  }
};

const decisionTag = (
  decision: PermissionDecision,
): "AllowOnce" | "AllowForSession" | "Deny" | "AlwaysAllow" => decision._tag;

let requestCounter = 0;
const nextRequestId = (): string =>
  `pr_${Date.now()}_${++requestCounter}`;

export const PermissionServiceLive = Layer.effect(
  PermissionService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const paths = yield* AppPaths;
    const pubsub = yield* PubSub.unbounded<PermissionRequest>();
    const pending = yield* Ref.make<ReadonlyMap<string, PendingEntry>>(
      new Map(),
    );
    const logPath = join(paths.userData, "logs", "permissions.log");

    const log = (event: string, fields: Record<string, unknown> = {}): void => {
      try {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(
          logPath,
          `${JSON.stringify({
            ts: new Date().toISOString(),
            event,
            ...fields,
          })}\n`,
        );
      } catch {
        // Permission logging must never affect permission handling.
      }
    };

    const findExistingAllow = (
      sessionId: SessionId,
      projectId: FolderId,
      kind: PermissionKind,
    ): Effect.Effect<boolean> =>
      sql<DecisionRow>`
        SELECT request_id, session_id, project_id, kind_tag, kind_key,
               kind_json, decision, scope, decided_at
        FROM permission_decisions
        WHERE kind_tag = ${kind._tag}
          AND kind_key = ${kindKey(kind)}
          AND (
            (session_id = ${sessionId} AND scope = 'session' AND decision = 'AllowForSession')
            OR
            (project_id = ${projectId} AND scope = 'folder' AND decision = 'AlwaysAllow')
          )
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.catch(() => Effect.succeed(false)),
      );

    const persistDecision = (
      request: PermissionRequest,
      projectId: FolderId,
      decision: PermissionDecision,
    ): Effect.Effect<void> =>
      sql`
        INSERT OR REPLACE INTO permission_decisions
          (request_id, session_id, project_id, kind_tag, kind_key,
           kind_json, decision, scope, decided_at)
        VALUES
          (${request.id}, ${request.sessionId}, ${projectId},
           ${request.kind._tag}, ${kindKey(request.kind)},
           ${JSON.stringify(request.kind)},
           ${decisionTag(decision)}, ${scopeForDecision(decision)},
           ${new Date().toISOString()})
      `.pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning(
            `[PermissionService] persist decision failed: ${String(cause)}`,
          ),
        ),
      );

    /**
     * Side table — `requestId → projectId` — so `decide()` can persist with
     * the right `project_id` without re-querying the session row. Cleared
     * when the request is fulfilled.
     */
    const projectByRequest = yield* Ref.make<ReadonlyMap<string, FolderId>>(
      new Map(),
    );

    const request: PermissionServiceShape["request"] = (
      sessionId,
      kind,
      options,
    ) =>
      Effect.gen(function* () {
        if (options.forcePrompt !== true) {
          const allowed = yield* findExistingAllow(
            sessionId,
            options.projectId,
            kind,
          );
          if (allowed) {
            log("request.auto_allowed", {
              sessionId,
              projectId: options.projectId,
              kindTag: kind._tag,
              kindKey: kindKey(kind),
            });
            return { _tag: "AllowOnce" } as PermissionDecision;
          }
        }

        const id = nextRequestId();
        const req = PermissionRequest.make({
          id,
          sessionId,
          kind,
          requestedAt: new Date(),
          forcePrompt: options.forcePrompt === true,
        });
        yield* Ref.update(projectByRequest, (m) => {
          const next = new Map(m);
          next.set(id, options.projectId);
          return next;
        });
        const deferred = yield* Deferred.make<PermissionDecision>();
        yield* Ref.update(pending, (m) => {
          const next = new Map(m);
          next.set(id, { request: req, deferred });
          log("request.pending_added", {
            requestId: id,
            sessionId,
            projectId: options.projectId,
            kindTag: kind._tag,
            kindKey: kindKey(kind),
            forcePrompt: req.forcePrompt,
            pendingCount: next.size,
          });
          return next;
        });
        const published = yield* PubSub.publish(pubsub, req);
        log("request.published", {
          requestId: id,
          sessionId,
          published,
        });
        const decision = yield* Deferred.await(deferred);
        log("request.resolved", {
          requestId: id,
          sessionId,
          decision: decision._tag,
        });
        return decision;
      });

    const decide: PermissionServiceShape["decide"] = (requestId, decision) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(pending);
        const entry = map.get(requestId);
        if (entry === undefined) {
          log("decide.not_found", {
            requestId,
            decision: decision._tag,
            pendingCount: map.size,
          });
          return yield* Effect.fail(
            new PermissionRequestNotFoundError({ requestId }),
          );
        }
        const projects = yield* Ref.get(projectByRequest);
        const projectId = projects.get(requestId);
        yield* Ref.update(pending, (m) => {
          const next = new Map(m);
          next.delete(requestId);
          log("decide.pending_removed", {
            requestId,
            sessionId: entry.request.sessionId,
            decision: decision._tag,
            projectId: projectId ?? null,
            pendingCount: next.size,
          });
          return next;
        });
        yield* Ref.update(projectByRequest, (m) => {
          const next = new Map(m);
          next.delete(requestId);
          return next;
        });
        if (projectId !== undefined) {
          yield* persistDecision(entry.request, projectId, decision);
        }
        yield* Deferred.succeed(entry.deferred, decision);
      });

    const listPending: PermissionServiceShape["listPending"] = (sessionId) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(pending);
        const out: PermissionRequest[] = [];
        for (const entry of map.values()) {
          if (entry.request.sessionId === sessionId) out.push(entry.request);
        }
        log("list_pending", {
          sessionId,
          count: out.length,
          requestIds: out.map((req) => req.id),
        });
        return out;
      });

    const requests: PermissionServiceShape["requests"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const dequeue = yield* PubSub.subscribe(pubsub);
          const map = yield* Ref.get(pending);
          const current = Array.from(map.values()).map(
            (entry) => entry.request,
          );
          log("stream.subscribe", {
            replayCount: current.length,
            requestIds: current.map((req) => req.id),
          });
          return Stream.concat(
            Stream.fromIterable(current),
            Stream.fromSubscription(dequeue),
          );
        }),
      );

    const listDecisions: PermissionServiceShape["listDecisions"] = (filter) =>
      Effect.gen(function* () {
        const rows = yield* (filter.projectId !== undefined
          ? sql<DecisionRow>`
              SELECT request_id, session_id, project_id, kind_tag, kind_key,
                     kind_json, decision, scope, decided_at
              FROM permission_decisions
              WHERE project_id = ${filter.projectId}
              ORDER BY decided_at DESC
            `
          : sql<DecisionRow>`
              SELECT request_id, session_id, project_id, kind_tag, kind_key,
                     kind_json, decision, scope, decided_at
              FROM permission_decisions
              ORDER BY decided_at DESC
            `
        ).pipe(Effect.catch(() => Effect.succeed([] as DecisionRow[])));
        const out: SavedDecision[] = [];
        for (const row of rows) {
          out.push(yield* rowToSavedDecision(row));
        }
        return out;
      });

    const revokeDecision: PermissionServiceShape["revokeDecision"] = (
      requestId,
    ) =>
      sql`
        DELETE FROM permission_decisions WHERE request_id = ${requestId}
      `.pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning(
            `[PermissionService] revoke failed: ${String(cause)}`,
          ),
        ),
      );

    return {
      request,
      decide,
      listPending,
      requests,
      listDecisions,
      revokeDecision,
    } as const;
  }),
);
