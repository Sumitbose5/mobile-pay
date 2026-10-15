/**
 * CoinHub API – Autocannon Load-Test Suite
 * =========================================
 * Run with:
 *   node scripts/load-test.mjs [--url http://localhost:4000] [--connections 1000] [--duration 10]
 *
 * Prerequisites:
 *   npm install autocannon --save-dev  (or: npx autocannon)
 *   A running server + seeded DB       (npm run dev  in another terminal)
 *
 * What it does:
 *   1. Logs in as the seed admin to obtain a real access-token cookie.
 *   2. Fires 1000 concurrent connections against every route for `duration`
 *      seconds and prints a per-route summary (RPS, p99, errors).
 */

import autocannon from 'autocannon';
import http from 'http';

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const BASE_URL    = flag('--url',         'http://localhost:4000');
const CONNECTIONS = Number(flag('--connections', 1000));
const DURATION    = Number(flag('--duration',      10));
const PIPELINING  = Number(flag('--pipelining',     1));

// ─── Credentials (must match your .env SEED_ADMIN_* values) ──────────────────
const ADMIN_EMAIL    = 'bosesumit058@gmail.com';
const ADMIN_PASSWORD = 'Admin@12345';

// ─── Tiny HTTP helper (no extra deps for the setup phase) ────────────────────
function request(method, path, body, cookieHeader) {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, BASE_URL);
    const payload = body ? JSON.stringify(body) : null;
    const req     = http.request(
      {
        hostname: url.hostname,
        port:     url.port || 80,
        path:     url.pathname + url.search,
        method,
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': payload ? Buffer.byteLength(payload) : 0,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'] ?? [];
          resolve({ status: res.statusCode, body: JSON.parse(data || '{}'), setCookie });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieString(setCookieArr) {
  return setCookieArr.map((c) => c.split(';')[0]).join('; ');
}

// ─── Setup: login and obtain a cookie ────────────────────────────────────────
async function setup() {
  console.log('\nSetting up: logging in as admin...');
  const loginRes = await request('POST', '/api/v1/auth/login', {
    email:    ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `Admin login failed (${loginRes.status}): ${JSON.stringify(loginRes.body)}\n` +
      'Make sure the server is running and DB is seeded (npm run db:seed)',
    );
  }
  const adminCookie = cookieString(loginRes.setCookie);
  const adminUserId = loginRes.body?.data?.user?.id;
  console.log(`Admin logged in  (userId=${adminUserId})`);
  console.log(`Cookie: ${adminCookie.slice(0, 80)}...\n`);
  return { adminCookie, adminUserId };
}

// ─── autocannon wrapper ───────────────────────────────────────────────────────
function fire(title, opts) {
  return new Promise((resolve) => {
    console.log(`\n[RUN]  ${title}`);
    console.log(`       ${opts.method ?? 'GET'} ${opts.url}`);
    console.log(`       connections=${CONNECTIONS}  duration=${DURATION}s\n`);

    const instance = autocannon(
      { connections: CONNECTIONS, duration: DURATION, pipelining: PIPELINING, ...opts },
      (err, result) => {
        if (err) { console.error(`[ERR]  ${title}:`, err.message); resolve(null); return; }
        printSummary(title, result);
        resolve(result);
      },
    );
    autocannon.track(instance, { renderProgressBar: true });
  });
}

function printSummary(title, r) {
  const p99  = r.latency.p99;
  const rps  = Math.round(r.requests.average);
  const errs = r.errors + r['non2xx'];
  const tag  = errs === 0 ? '[OK  ]' : errs < 50 ? '[WARN]' : '[FAIL]';
  console.log(`${tag} ${title.padEnd(52)} RPS=${String(rps).padStart(6)}  p99=${String(p99).padStart(6)}ms  errors=${errs}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('================================================================');
  console.log('  CoinHub Load-Test Suite  --  autocannon');
  console.log(`  Target : ${BASE_URL}`);
  console.log(`  Conns  : ${CONNECTIONS}  |  Duration: ${DURATION}s per route  |  Pipeline: ${PIPELINING}`);
  console.log('================================================================');

  const { adminCookie, adminUserId } = await setup();

  const authHeaders = { Cookie: adminCookie };

  // Placeholder IDs – exercise auth + validation without mutating real data.
  const FAKE_TXN_ID       = 'TXN_000000000001';
  const FAKE_UUID         = '00000000-0000-0000-0000-000000000001';
  const FAKE_SESSION_ID   = FAKE_UUID;
  const FAKE_ORDER_ID     = FAKE_UUID;
  const FAKE_REPORT_ID    = FAKE_UUID;
  const FAKE_NOTIF_ID     = FAKE_UUID;
  const FAKE_BENEF_ID     = FAKE_UUID;
  const FAKE_BANK_ACCT_ID = FAKE_UUID;
  const FAKE_PAYRQ_ID     = FAKE_UUID;
  const FAKE_USER_ID      = adminUserId ?? FAKE_UUID;

  const results = [];
  const run = async (title, opts) => results.push(await fire(title, opts));

  // ── 1. HEALTH (no auth) ───────────────────────────────────────────────────
  await run('Health – GET /health/live',  { url: `${BASE_URL}/health/live` });
  await run('Health – GET /health/ready', { url: `${BASE_URL}/health/ready` });

  // ── 2. AUTH ───────────────────────────────────────────────────────────────
  await run('Auth – GET /auth/csrf', { url: `${BASE_URL}/api/v1/auth/csrf` });

  await run('Auth – GET /auth/sessions', {
    url: `${BASE_URL}/api/v1/auth/sessions`, headers: authHeaders,
  });

  await run('Auth – POST /auth/refresh', {
    url: `${BASE_URL}/api/v1/auth/refresh`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: '{}',
  });

  // Register hits the rate-limiter fast – tests limiter + schema validation
  await run('Auth – POST /auth/register (rate-limit probe)', {
    url: `${BASE_URL}/api/v1/auth/register`, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Load Test User', email: `load+${Date.now()}@example.com`, password: 'Test@12345' }),
  });

  await run('Auth – POST /auth/forgot-password (rate-limit probe)', {
    url: `${BASE_URL}/api/v1/auth/forgot-password`, method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com' }),
  });

  await run('Auth – DELETE /auth/sessions/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/auth/sessions/${FAKE_SESSION_ID}`, method: 'DELETE',
    headers: authHeaders,
  });

  // ── 3. USERS ──────────────────────────────────────────────────────────────
  await run('Users – GET /users/me', {
    url: `${BASE_URL}/api/v1/users/me`, headers: authHeaders,
  });

  await run('Users – PATCH /users/me', {
    url: `${BASE_URL}/api/v1/users/me`, method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Load Tester' }),
  });

  await run('Users – GET /users/me/notification-preferences', {
    url: `${BASE_URL}/api/v1/users/me/notification-preferences`, headers: authHeaders,
  });

  await run('Users – PATCH /users/me/notification-preferences', {
    url: `${BASE_URL}/api/v1/users/me/notification-preferences`, method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailMarketing: false }),
  });

  // PIN – will 4xx if admin has no PIN; tests body validation + auth
  await run('Users – POST /users/me/pin (set)', {
    url: `${BASE_URL}/api/v1/users/me/pin`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD, pin: '123456' }),
  });

  await run('Users – PUT /users/me/pin (change)', {
    url: `${BASE_URL}/api/v1/users/me/pin`, method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPin: '123456', newPin: '654321' }),
  });

  await run('Users – POST /users/me/pin/reset-request', {
    url: `${BASE_URL}/api/v1/users/me/pin/reset-request`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });

  // ── 4. WALLET ─────────────────────────────────────────────────────────────
  await run('Wallet – GET /wallet', {
    url: `${BASE_URL}/api/v1/wallet`, headers: authHeaders,
  });

  await run('Wallet – GET /wallet/balance', {
    url: `${BASE_URL}/api/v1/wallet/balance`, headers: authHeaders,
  });

  await run('Wallet – GET /wallet/recipients/lookup', {
    url: `${BASE_URL}/api/v1/wallet/recipients/lookup?email=nobody%40example.com`,
    headers: authHeaders,
  });

  // add-money creates a real order; idempotency key deduplicates repeat hits
  await run('Wallet – POST /wallet/add-money', {
    url: `${BASE_URL}/api/v1/wallet/add-money`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'Idempotency-Key': 'load-add-money-01' },
    body: JSON.stringify({ amount: 100 }),
  });

  // send – will 4xx (unknown receiver/wrong PIN) – full validation + auth chain
  await run('Wallet – POST /wallet/send (validation probe)', {
    url: `${BASE_URL}/api/v1/wallet/send`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'Idempotency-Key': 'load-send-01' },
    body: JSON.stringify({ receiverEmail: 'nobody@example.com', amount: 100, pin: '000000' }),
  });

  // withdraw – 4xx (fake bank account); tests auth + idempotency middleware
  await run('Wallet – POST /wallet/withdraw (validation probe)', {
    url: `${BASE_URL}/api/v1/wallet/withdraw`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'Idempotency-Key': 'load-withdraw-01' },
    body: JSON.stringify({ bankAccountId: FAKE_BANK_ACCT_ID, amount: 100, pin: '000000' }),
  });

  // ── 5. TRANSACTIONS ───────────────────────────────────────────────────────
  await run('Transactions – GET /transactions', {
    url: `${BASE_URL}/api/v1/transactions`, headers: authHeaders,
  });

  await run('Transactions – GET /transactions/summary', {
    url: `${BASE_URL}/api/v1/transactions/summary`, headers: authHeaders,
  });

  await run('Transactions – GET /transactions/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/transactions/${FAKE_TXN_ID}`, headers: authHeaders,
  });

  await run('Transactions – POST /transactions/export', {
    url: `${BASE_URL}/api/v1/transactions/export`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '2024-01-01', to: '2024-12-31' }),
  });

  await run('Transactions – GET /transactions/export/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/transactions/export/${FAKE_REPORT_ID}`, headers: authHeaders,
  });

  await run('Transactions – GET /transactions/export/:id/download (404 probe)', {
    url: `${BASE_URL}/api/v1/transactions/export/${FAKE_REPORT_ID}/download`, headers: authHeaders,
  });

  // ── 6. NOTIFICATIONS ──────────────────────────────────────────────────────
  await run('Notifications – GET /notifications', {
    url: `${BASE_URL}/api/v1/notifications`, headers: authHeaders,
  });

  await run('Notifications – GET /notifications/unread-count', {
    url: `${BASE_URL}/api/v1/notifications/unread-count`, headers: authHeaders,
  });

  await run('Notifications – POST /notifications/read-all', {
    url: `${BASE_URL}/api/v1/notifications/read-all`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: '{}',
  });

  await run('Notifications – PATCH /notifications/:id/read (404 probe)', {
    url: `${BASE_URL}/api/v1/notifications/${FAKE_NOTIF_ID}/read`, method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: '{}',
  });

  // ── 7. BENEFICIARIES ──────────────────────────────────────────────────────
  await run('Beneficiaries – GET /beneficiaries', {
    url: `${BASE_URL}/api/v1/beneficiaries`, headers: authHeaders,
  });

  await run('Beneficiaries – POST /beneficiaries (validation probe)', {
    url: `${BASE_URL}/api/v1/beneficiaries`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', pin: '000000' }),
  });

  await run('Beneficiaries – PATCH /beneficiaries/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/beneficiaries/${FAKE_BENEF_ID}`, method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: 'Test' }),
  });

  await run('Beneficiaries – DELETE /beneficiaries/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/beneficiaries/${FAKE_BENEF_ID}`, method: 'DELETE',
    headers: authHeaders,
  });

  // ── 8. BANK ACCOUNTS ──────────────────────────────────────────────────────
  await run('Bank Accounts – GET /bank-accounts', {
    url: `${BASE_URL}/api/v1/bank-accounts`, headers: authHeaders,
  });

  await run('Bank Accounts – POST /bank-accounts (validation probe)', {
    url: `${BASE_URL}/api/v1/bank-accounts`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountHolderName: 'Load Tester', accountNumber: '123456789012', ifscCode: 'SBIN0001234' }),
  });

  await run('Bank Accounts – DELETE /bank-accounts/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/bank-accounts/${FAKE_BANK_ACCT_ID}`, method: 'DELETE',
    headers: authHeaders,
  });

  // ── 9. PAYMENT REQUESTS ───────────────────────────────────────────────────
  await run('Payment Requests – GET /payment-requests', {
    url: `${BASE_URL}/api/v1/payment-requests`, headers: authHeaders,
  });

  await run('Payment Requests – POST /payment-requests (validation probe)', {
    url: `${BASE_URL}/api/v1/payment-requests`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ payerEmail: 'nobody@example.com', amount: 100 }),
  });

  await run('Payment Requests – GET /payment-requests/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/payment-requests/${FAKE_PAYRQ_ID}`, headers: authHeaders,
  });

  await run('Payment Requests – POST /payment-requests/:id/pay (404 probe)', {
    url: `${BASE_URL}/api/v1/payment-requests/${FAKE_PAYRQ_ID}/pay`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json', 'Idempotency-Key': 'load-pay-req-01' },
    body: JSON.stringify({ pin: '000000' }),
  });

  await run('Payment Requests – POST /payment-requests/:id/reject (404 probe)', {
    url: `${BASE_URL}/api/v1/payment-requests/${FAKE_PAYRQ_ID}/reject`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: '{}',
  });

  await run('Payment Requests – POST /payment-requests/:id/cancel (404 probe)', {
    url: `${BASE_URL}/api/v1/payment-requests/${FAKE_PAYRQ_ID}/cancel`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: '{}',
  });

  // ── 10. PAYMENTS ──────────────────────────────────────────────────────────
  await run('Payments – GET /payments/orders/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/payments/orders/${FAKE_ORDER_ID}`, headers: authHeaders,
  });

  // Simulator is disabled in prod; safe to hit in dev
  await run('Payments – POST /payments/simulator/:id/complete (404 probe)', {
    url: `${BASE_URL}/api/v1/payments/simulator/${FAKE_ORDER_ID}/complete`, method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome: 'SUCCESS' }),
  });

  // ── 11. ADMIN (requires admin role) ───────────────────────────────────────
  await run('Admin – GET /admin/ping', {
    url: `${BASE_URL}/api/v1/admin/ping`, headers: authHeaders,
  });

  await run('Admin – GET /admin/stats', {
    url: `${BASE_URL}/api/v1/admin/stats`, headers: authHeaders,
  });

  await run('Admin – GET /admin/reconciliation', {
    url: `${BASE_URL}/api/v1/admin/reconciliation`, headers: authHeaders,
  });

  await run('Admin – GET /admin/users', {
    url: `${BASE_URL}/api/v1/admin/users`, headers: authHeaders,
  });

  await run('Admin – GET /admin/users/:id', {
    url: `${BASE_URL}/api/v1/admin/users/${FAKE_USER_ID}`, headers: authHeaders,
  });

  await run('Admin – GET /admin/transactions', {
    url: `${BASE_URL}/api/v1/admin/transactions`, headers: authHeaders,
  });

  await run('Admin – GET /admin/transactions/:id (404 probe)', {
    url: `${BASE_URL}/api/v1/admin/transactions/${FAKE_TXN_ID}`, headers: authHeaders,
  });

  await run('Admin – GET /admin/audit-logs', {
    url: `${BASE_URL}/api/v1/admin/audit-logs`, headers: authHeaders,
  });

  await run('Admin – GET /admin/suspicious', {
    url: `${BASE_URL}/api/v1/admin/suspicious`, headers: authHeaders,
  });

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log('\n\n================================================================');
  console.log('  LOAD TEST COMPLETE');
  console.log('================================================================');
  console.log(`  Connections : ${CONNECTIONS}`);
  console.log(`  Duration    : ${DURATION}s per route`);
  console.log(`  Total tests : ${results.filter(Boolean).length}`);
  console.log('================================================================\n');
  console.log('Legend: [OK  ] = 0 errors | [WARN] = <50 errors | [FAIL] = >=50 errors\n');
}

main().catch((err) => {
  console.error('\nLoad test aborted:', err.message);
  process.exit(1);
});
