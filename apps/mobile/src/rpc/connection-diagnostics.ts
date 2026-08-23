import { redactDiagnosticValue } from "~/lib/redact-diagnostics";

type DiagnosticFields = Record<string, unknown>;

const safeFields = (fields: DiagnosticFields): DiagnosticFields =>
	redactDiagnosticValue(
  Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value instanceof Error
        ? { name: value.name, message: value.message }
        : value,
    ]),
		),
	) as DiagnosticFields;

export const logConnectionDiagnostic = (
  event: string,
  fields: DiagnosticFields = {},
): void => {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...safeFields(fields),
  };
  console.info("[zuse:remote]", JSON.stringify(payload));
};

export const logConnectionProblem = (
  event: string,
  fields: DiagnosticFields = {},
): void => {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...safeFields(fields),
  };
  console.warn("[zuse:remote]", JSON.stringify(payload));
};
