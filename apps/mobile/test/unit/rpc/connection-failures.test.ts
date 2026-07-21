import { describe, expect, test } from "vitest";
import {
	isIntentionalConnectionInterruption,
	isRetryableClientError,
} from "../../../src/rpc/connection-failures";
import { ConnectionFailed } from "../../../src/rpc/errors";

describe("connection failure classification", () => {
	test("ignores Effect interruption from replacing an owned RPC subscription", () => {
		expect(
			isIntentionalConnectionInterruption(
				new Error("All fibers interrupted without error"),
			),
		).toBe(true);
	});

	test("does not hide real transport failures", () => {
		expect(
			isIntentionalConnectionInterruption(
				new Error("socket closed unexpectedly"),
			),
		).toBe(false);
	});

	test("does not classify ordinary domain failures as connection failures", () => {
		expect(isRetryableClientError({})).toBe(false);
		expect(isRetryableClientError({ _tag: "SessionNotFound" })).toBe(false);
	});

	test("classifies RPC transport and connection setup failures as retryable", () => {
		expect(isRetryableClientError({ _tag: "RpcClientError" })).toBe(true);
		expect(
			isRetryableClientError(
				new ConnectionFailed({ message: "socket closed" }),
			),
		).toBe(true);
		expect(
			isRetryableClientError(new ConnectionFailed({ message: "offline" })),
		).toBe(false);
	});
});
