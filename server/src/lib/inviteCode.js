import crypto from 'node:crypto';

// Crockford base32 alphabet: no I, L, O, U -> no confusing 0/O or 1/I/l when typed by humans.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LENGTH = 10; // 32^10 = 2^50 ≈ 1.1 quadrillion possibilities

/**
 * Generate a cryptographically random invite code like "7K3QX-9MZ2B".
 * 50 bits of entropy + rate limiting (10 attempts / 15 min / user) means guessing a valid code
 * would take on the order of 10^11 years even with 1,000 active codes.
 */
export function generateInviteCode() {
  const bytes = crypto.randomBytes(LENGTH);
  let out = '';
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[bytes[i] & 31]; // 256 % 32 === 0 -> no modulo bias
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Normalise what the user typed (case, dashes, spaces, common look-alikes). */
export function normaliseInviteCode(input) {
  return String(input)
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** Only the hash is stored in the database. */
export function hashInviteCode(code) {
  return crypto.createHash('sha256').update(normaliseInviteCode(code)).digest('hex');
}
