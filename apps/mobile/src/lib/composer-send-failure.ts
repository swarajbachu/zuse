import { isRetryableClientError } from "~/rpc/connection-failures";

/**
 * A normal composer send is placed in the durable ClientBus outbox before the
 * transport call begins. If that call loses its socket, the optimistic row is
 * still truthful: the same command ID will be replayed after reconnect. Only a
 * definitive failure, or one that happened before the optimistic command was
 * staged, should roll the row back and surface an error.
 */
export const composerSendFailureDisposition = (
	cause: unknown,
	hasOptimisticMessage: boolean,
): "retrying" | "failed" =>
	hasOptimisticMessage && isRetryableClientError(cause) ? "retrying" : "failed";
