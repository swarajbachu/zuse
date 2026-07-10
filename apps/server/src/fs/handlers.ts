import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { FsService } from "./services/fs-service.ts";

const Tree = MemoizeRpcs.toLayerHandler(
  "fs.tree",
  ({ folderId, path, worktreeId }) =>
    Effect.flatMap(FsService, (svc) =>
      svc.tree(folderId, path ?? "", worktreeId ?? null),
    ),
);

const WatchTree = MemoizeRpcs.toLayerHandler(
  "fs.watchTree",
  ({ folderId, worktreeId }) =>
    Stream.unwrap(
      Effect.map(FsService, (svc) =>
        svc.watchTree(folderId, worktreeId ?? null),
      ),
    ),
);

const ReadFile = MemoizeRpcs.toLayerHandler(
  "fs.readFile",
  ({ folderId, path, worktreeId }) =>
    Effect.flatMap(FsService, (svc) =>
      svc.readFile(folderId, path, worktreeId ?? null),
    ),
);

const WriteFile = MemoizeRpcs.toLayerHandler(
  "fs.writeFile",
  ({ folderId, path, content, expectedMtime, worktreeId }) =>
    Effect.flatMap(FsService, (svc) =>
      svc.writeFile(folderId, path, content, expectedMtime, worktreeId ?? null),
    ),
);

const CreateFile = MemoizeRpcs.toLayerHandler(
  "fs.createFile",
  ({ folderId, path, worktreeId }) =>
    Effect.flatMap(FsService, (svc) =>
      svc.createFile(folderId, path, worktreeId ?? null),
    ),
);

const CreateDirectory = MemoizeRpcs.toLayerHandler(
  "fs.createDirectory",
  ({ folderId, path, worktreeId }) =>
    Effect.flatMap(FsService, (svc) =>
      svc.createDirectory(folderId, path, worktreeId ?? null),
    ),
);

const Remove = MemoizeRpcs.toLayerHandler(
  "fs.remove",
  ({ folderId, path, worktreeId }) =>
    Effect.flatMap(FsService, (svc) =>
      svc.remove(folderId, path, worktreeId ?? null),
    ),
);

const ReadExternalFile = MemoizeRpcs.toLayerHandler(
  "fs.readExternalFile",
  ({ path }) => Effect.flatMap(FsService, (svc) => svc.readExternal(path)),
);

const WriteExternalFile = MemoizeRpcs.toLayerHandler(
  "fs.writeExternalFile",
  ({ path, content, expectedMtime }) =>
    Effect.flatMap(FsService, (svc) =>
      svc.writeExternal(path, content, expectedMtime),
    ),
);

export const FsHandlersLayer = Layer.mergeAll(
  Tree,
  WatchTree,
  ReadFile,
  WriteFile,
  CreateFile,
  CreateDirectory,
  Remove,
  ReadExternalFile,
  WriteExternalFile,
);
