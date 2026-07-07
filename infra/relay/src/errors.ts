import { Data } from "effect";

/**
 * All relay failures are tagged so the HTTP layer can map them to a status +
 * stable error code without leaking internals. `status` is the HTTP status the
 * boundary should emit; `code` is the machine-readable body `{ error: code }`.
 */
export class RelayError extends Data.TaggedError("RelayError")<{
  readonly code: string;
  readonly status: number;
  readonly detail?: string;
}> {}

export const unauthorized = (code: string, detail?: string): RelayError =>
  new RelayError({ code, status: 401, detail });

export const forbidden = (code: string, detail?: string): RelayError =>
  new RelayError({ code, status: 403, detail });

export const notFound = (code = "not_found", detail?: string): RelayError =>
  new RelayError({ code, status: 404, detail });

export const badRequest = (code: string, detail?: string): RelayError =>
  new RelayError({ code, status: 400, detail });

export const gone = (code: string, detail?: string): RelayError =>
  new RelayError({ code, status: 410, detail });
