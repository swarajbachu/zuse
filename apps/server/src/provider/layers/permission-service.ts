import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type FolderId,
  PermissionDecision,
  type PermissionKind,
  PermissionRequest,
  PermissionRequestNotFoundError,
  SavedDecision,
  type SessionId,
} from "@zuse/contracts";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import { ReactorRunner } from "@zuse/domain/engine/reactor-runner";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import {
  makeSqlConsumerStorage,
  type SqlConsumerStorageError,
} from "@zuse/domain/engine/sql-consumer-storage";
import {
  DateTime,
  Deferred,
  Effect,
  Layer,
  PubSub,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";

import { AppPaths } from "../../app-paths.ts";
import {
  PermissionService,
  type PermissionServiceShape,
} from "../services/permission-service.ts";

interface PendingEntry {
  readonly request: PermissionRequest;
  readonly deferred: Deferred.Deferred<PermissionDecision>;
  readonly projectId: FolderId;
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

interface PendingRequestRow {
  readonly request_json: string;
  readonly project_id: string;
}

/**
 * Decisions that should map to `scope='folder'`. Only `AlwaysAllow` is
 * folder-scoped today; everything else stays session-scoped (even denials,
 * which we keep for inspector visibility).
 */
const scopeForDecision = (
  decision: PermissionDecision,
): "session" | "folder" =>
  decision._tag === "AlwaysAllow" ? "folder" : "session";

const decodeSavedDecision = Schema.decodeUnknownEffect(SavedDecision);
const decodePermissionDecision = Schema.decodeUnknownEffect(PermissionDecision);
const decodePermissionRequest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PermissionRequest),
);

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
const nextRequestId = (): string => `pr_${Date.now()}_${++requestCounter}`;

export const PermissionServiceLive = Layer.effect(
  PermissionService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessionDomain = yield* SessionDomain;
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

    type PermissionLifecycleCommand =
      | { readonly _tag: "PublishPermission"; readonly requestId: string }
      | {
          readonly _tag: "CompletePermission";
          readonly requestId: string;
          readonly decisionJson: string;
        };

    const permissionReactor = new ReactorRunner<
      StoredEvent,
      PermissionLifecycleCommand,
      SqlConsumerStorageError
    >(
      makeSqlConsumerStorage(sql),
      (input) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(pending);
          const entry = entries.get(input.command.requestId);
          if (entry === undefined) return;
          if (input.command._tag === "PublishPermission") {
            const published = yield* PubSub.publish(pubsub, entry.request);
            log("request.published", {
              requestId: entry.request.id,
              sessionId: entry.request.sessionId,
              published,
            });
            return;
          }

          const decision = yield* decodePermissionDecision(
            JSON.parse(input.command.decisionJson),
          ).pipe(Effect.orDie);
          yield* persistDecision(entry.request, entry.projectId, decision);
          yield* Ref.update(pending, (current) => {
            const next = new Map(current);
            next.delete(input.command.requestId);
            return next;
          });
          yield* Deferred.succeed(entry.deferred, decision);
          log("decide.pending_removed", {
            requestId: input.command.requestId,
            sessionId: entry.request.sessionId,
            decision: decision._tag,
            projectId: entry.projectId,
          });
        }),
      {
        name: "permission-lifecycle",
        react: (record) => {
          if (record.event._tag === "PermissionRequested") {
            return Effect.succeed([
              {
                streamId: record.streamId,
                command: {
                  _tag: "PublishPermission" as const,
                  requestId: record.event.requestId,
                },
              },
            ]);
          }
          if (record.event._tag === "PermissionResolved") {
            return Effect.succeed([
              {
                streamId: record.streamId,
                command: {
                  _tag: "CompletePermission" as const,
                  requestId: record.event.requestId,
                  decisionJson:
                    record.event.decisionJson ??
                    JSON.stringify({ _tag: record.event.decision }),
                },
              },
            ]);
          }
          return Effect.succeed([]);
        },
      },
    );
    const permissionReactorLock = yield* Semaphore.make(1);
    const runPermissionReactor = permissionReactorLock.withPermits(1)(
      permissionReactor.catchUp().pipe(Effect.asVoid, Effect.orDie),
    );

    // The driver Deferred is process-local, but the prompt itself is durable.
    // Recreate unresolved entries before replaying the reactor so a restarted UI
    // can still list and decide them. The original provider process is gone; the
    // replacement Deferred simply gives the normal resolution path a safe target.
    const unresolved = yield* sql<PendingRequestRow>`
      SELECT json_extract(requested.payload_json, '$.payloadJson') AS request_json,
             sessions.project_id
      FROM events AS requested
      JOIN sessions ON sessions.id = requested.stream_id
      WHERE requested.stream_kind = 'session'
        AND requested.type = 'PermissionRequested'
        AND json_valid(requested.payload_json)
        AND NOT EXISTS (
          SELECT 1 FROM events AS resolved
          WHERE resolved.stream_kind = 'session'
            AND resolved.stream_id = requested.stream_id
            AND resolved.type = 'PermissionResolved'
            AND json_extract(resolved.payload_json, '$.requestId') =
                json_extract(requested.payload_json, '$.requestId')
        )
      ORDER BY requested.sequence
    `;
    for (const row of unresolved) {
      const recovered = yield* decodePermissionRequest(row.request_json).pipe(
        Effect.orDie,
      );
      const deferred = yield* Deferred.make<PermissionDecision>();
      yield* Ref.update(pending, (current) => {
        const next = new Map(current);
        next.set(recovered.id, {
          request: recovered,
          deferred,
          projectId: row.project_id as FolderId,
        });
        return next;
      });
      log("request.recovered", {
        requestId: recovered.id,
        sessionId: recovered.sessionId,
        projectId: row.project_id,
      });
    }
    yield* runPermissionReactor;

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
        const deferred = yield* Deferred.make<PermissionDecision>();
        yield* Ref.update(pending, (m) => {
          const next = new Map(m);
          next.set(id, { request: req, deferred, projectId: options.projectId });
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
        yield* sessionDomain
          .dispatch({
            commandId: `permission:request:${id}`,
            streamId: sessionId,
            command: {
              _tag: "RequestPermission",
              requestId: id,
              turnId: id,
              payloadJson: JSON.stringify(req),
              requestedAt: req.requestedAt.getTime(),
            },
          })
          .pipe(Effect.orDie);
        yield* runPermissionReactor;
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
        yield* sessionDomain
          .dispatch({
            commandId: `permission:resolve:${requestId}`,
            streamId: entry.request.sessionId,
            command: {
              _tag: "ResolvePermission",
              requestId,
              decision: decision._tag,
              decisionJson: JSON.stringify(decision),
              resolvedAt: (yield* DateTime.nowAsDate).getTime(),
            },
          })
          .pipe(Effect.orDie);
        yield* runPermissionReactor;
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
        const rows = yield* (
          filter.projectId !== undefined
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
