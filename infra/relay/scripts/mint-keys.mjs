// Mint the relay's Ed25519 mint keypair (JWK).
//   Run from infra/relay:  node scripts/mint-keys.mjs
//
// - PUBLIC  -> wrangler.jsonc `RELAY_MINT_PUBLIC_JWK`
// - PRIVATE -> `bunx wrangler secret put RELAY_MINT_PRIVATE_JWK` (paste when prompted)
import { generateKeyPair, exportJWK } from "jose";

const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
  extractable: true,
});

console.log("PUBLIC (RELAY_MINT_PUBLIC_JWK):");
console.log(JSON.stringify(await exportJWK(publicKey)));
console.log("");
console.log("PRIVATE (wrangler secret put RELAY_MINT_PRIVATE_JWK):");
console.log(JSON.stringify(await exportJWK(privateKey)));
