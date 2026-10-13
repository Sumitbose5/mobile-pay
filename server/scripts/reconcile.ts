/* Usage: npm run reconcile    Exits 1 if any invariant is violated, so it can run from cron or CI. */
import { closeDb } from '../src/db/client.js';
import { reconcile } from '../src/modules/reconciliation/reconciliation.service.js';

try {
  const report = await reconcile();
  for (const c of report.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  (${c.violationCount} violation(s))`}`);
    if (!c.ok) console.log(JSON.stringify(c.violations, null, 2));
  }
  console.log(`\n${report.ok ? 'All invariants hold.' : 'INVARIANT VIOLATIONS FOUND.'} (${report.durationMs} ms)`);
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await closeDb();
}
