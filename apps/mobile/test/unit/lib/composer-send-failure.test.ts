import { describe, expect, test } from "vitest";

import { composerSendFailureDisposition } from "../../../src/lib/composer-send-failure";
import { ConnectionFailed } from "../../../src/rpc/errors";

describe("composer send failure disposition", () => {
	test("keeps an optimistic message while its durable command retries", () => {
		expect(
			composerSendFailureDisposition({ _tag: "RpcClientError" }, true),
		).toBe("retrying");
		expect(
			composerSendFailureDisposition(
				new ConnectionFailed({ message: "socket closed" }),
				true,
			),
		).toBe("retrying");
	});

	test("surfaces definitive failures and failures before optimistic staging", () => {
		expect(
			composerSendFailureDisposition({ _tag: "SessionNotFound" }, true),
		).toBe("failed");
		expect(
			composerSendFailureDisposition({ _tag: "RpcClientError" }, false),
		).toBe("failed");
	});
});
