/** npm run verify — checks every team-formation invariant against the database in MONGODB_URI. */
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { checkIntegrity } from '../src/lib/integrity.js';

await mongoose.connect(config.mongoUri);
const t0 = Date.now();
const { teams, participantsInTeams, violations } = await checkIntegrity();
console.log(`Checked ${teams} teams / ${participantsInTeams} members in ${Date.now() - t0} ms`);
if (violations.length) {
  console.log(`FAIL: ${violations.length} violation(s)`);
  for (const v of violations.slice(0, 50)) console.log(' -', v);
} else {
  console.log('OK: all invariants hold');
}
await mongoose.disconnect();
process.exit(violations.length ? 1 : 0);
