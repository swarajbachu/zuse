import { AccountAccessErrorCode } from "@zuse/contracts";
import { Schema } from "effect";

export class AccountAccessServiceError extends Schema.TaggedErrorClass<AccountAccessServiceError>()(
	"AccountAccessServiceError",
	{ code: AccountAccessErrorCode },
) {
	constructor(code: AccountAccessErrorCode) {
		super({ code });
	}
}
