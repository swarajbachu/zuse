-- Complete the API naming cutover without replacing existing challenges.
ALTER TABLE "api_link_challenges" RENAME COLUMN "relay_issuer" TO "api_issuer";
