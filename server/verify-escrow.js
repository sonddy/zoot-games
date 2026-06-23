/**
 * Escrow key sanity-check (no secrets are printed).
 *
 * Confirms which public wallet your ESCROW_PRIVATE_KEY actually controls before
 * you deploy. Run:
 *
 *   node server/verify-escrow.js
 *
 * It reads ESCROW_PRIVATE_KEY from .env / the environment, derives the public
 * address, and tells you whether it's the expected new wallet or a blocked one.
 */
require('dotenv').config();
const { Keypair } = require('@solana/web3.js');

const EXPECTED_NEW = '3PBpxg5sFTmNN2dyGJQA1RUXSrmVt8eQeFSQaXjjNNsR';
const BLOCKED = ['7aKmNNy3cbNA4DNEqAyLTwqKqKFLnJ7DntnfozEX945Q'];

const raw = process.env.ESCROW_PRIVATE_KEY;
if (!raw) {
  console.error('ESCROW_PRIVATE_KEY is not set.');
  process.exit(1);
}

let addr;
try {
  addr = Keypair.fromSecretKey(Buffer.from(raw, 'base64')).publicKey.toBase58();
} catch (e) {
  console.error('Could not parse ESCROW_PRIVATE_KEY as a base64 secret key:', e.message);
  process.exit(1);
}

console.log('Escrow wallet derived from current key:', addr);
if (BLOCKED.includes(addr)) {
  console.error('>>> DANGER: this is a COMPROMISED wallet. Do NOT deploy. Rotate the key.');
  process.exit(2);
} else if (addr === EXPECTED_NEW) {
  console.log('>>> OK: matches the expected new escrow wallet.');
} else {
  console.warn('>>> NOTE: this is neither the compromised wallet nor the expected new one. Double-check it is intentional.');
}
