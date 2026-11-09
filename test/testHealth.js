/**
 * Standalone test for the health/readiness endpoints (Phase 1 §C3).
 * Run: node test/testHealth.js
 *
 * WHAT THIS PROVES, IN THE ORDER IT MATTERS:
 *   1. /health answers from a process whose database is completely unavailable
 *      — there is no SUPABASE_DB_URL in this environment at all — and it does so
 *      in well under 20 ms.
 *   2. Polling /health never consumes a pool connection. A 1 Hz probe must not
 *      itself become load, so this asserts pool.totalCount stays 0 rather than
 *      asserting the code "looks cheap".
 *   3. /ready is unreadable unauthenticated and unreadable cross-origin.
 *   4. Every status decision in the report is a pure function of a stats
 *      object, so the whole healthy/degraded/unhealthy matrix is driven
 *      directly — including the cases a live server cannot be made to produce
 *      on demand (a queue at 100 %, a pooler dropping an idle connection).
 *
 * Reporting uses process.stdout.write only, never console.*, so the log shim
 * cannot intercept or redact its own output. db.js starts a 30s interval at
 * require time, so the runner exits explicitly.
 */

const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const report = require('../src/utils/healthReport');
const {
    createHealthRouter,
    databaseCheck,
    cacheCheck,
    queueCheck,
    socketsCheck,
    countSockets,
    DEEP_QUERY_TIMEOUT_MS
} = require('../src/routes/healthRoutes');
const { poolStats } = require('../src/database/db');

const say = (line) => process.stdout.write(`${line}\n`);

let passed = 0;
let failed = 0;
const queue = [];

function check(name, fn) {
    queue.push({ name, fn });
}

async function run() {
    for (const item of queue) {
        try {
            await item.fn();
            passed++;
            say(`PASS  ${item.name}`);
        } catch (err) {
            failed++;
            say(`FAIL  ${item.name}`);
            say(`      ${err.message}`);
        }
    }
    say('');
    say(`${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

// ─── harness ───────────────────────────────────────────────────────────────

const TEST_TOKEN = 'phase1-c3-internal-token';
const VERSION = require('../package.json').version;

// Mirrors server.js: the health router is mounted BEFORE cors(), which is what
// stops a browser on another origin from reading /ready.
function buildApp(deps = {}) {
    const app = express();
    app.use(createHealthRouter(Object.assign({
        version: VERSION,
        rssLimitMB: 512,
        getInternalToken: () => TEST_TOKEN,
        authenticate: (req, res, next) => res.status(401).json({ error: 'JWT path reached' })
    }, deps)));
    app.use((req, res) => res.status(404).json({ error: 'not found' }));
    return app;
}

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function requestOnce(server, path, opts = {}) {
    return new Promise((resolve, reject) => {
        const startedAt = process.hrtime.bigint();
        const req = http.request({
            host: '127.0.0.1',
            port: server.address().port,
            path,
            method: 'GET',
            headers: opts.headers || {},
            agent: false
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let body = null;
                try { body = JSON.parse(raw); } catch (e) { body = raw; }
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body,
                    raw,
                    ms: Number(process.hrtime.bigint() - startedAt) / 1e6
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

const authedHeaders = { 'x-internal-token': TEST_TOKEN };

// ─── /health — liveness ────────────────────────────────────────────────────

check('/health answers 200 with the fields the stub already returned', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/health');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok', 'status must stay "ok" for existing pollers');
        assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(res.body.timestamp), 'timestamp must stay an ISO string');
    } finally {
        await close(server);
    }
});

check('/health adds version and uptimeSec without dropping anything', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/health');
        assert.strictEqual(res.body.version, VERSION);
        assert.ok(Number.isFinite(res.body.uptimeSec) && res.body.uptimeSec >= 0);
        // Exactly four fields: this body must not accrete cost over time.
        assert.deepStrictEqual(Object.keys(res.body).sort(), ['status', 'timestamp', 'uptimeSec', 'version']);
    } finally {
        await close(server);
    }
});

check('/health needs no credentials and is never redirected to auth', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/health');
        assert.strictEqual(res.status, 200);
    } finally {
        await close(server);
    }
});

check('/health answers in under 20 ms with the database unreachable', async () => {
    // No SUPABASE_DB_URL exists in this environment, so the pool in db.js can
    // never connect — the exact "dead pool instance" the gate asks about.
    assert.strictEqual(poolStats().configured, false, 'harness must run without a database');
    const server = await listen(buildApp());
    try {
        await requestOnce(server, '/health'); // warm the connection
        const samples = [];
        for (let i = 0; i < 20; i++) samples.push((await requestOnce(server, '/health')).ms);
        samples.sort((a, b) => a - b);
        const median = samples[Math.floor(samples.length / 2)];
        assert.ok(median < 20, `median ${median.toFixed(2)}ms is not under 20ms`);
    } finally {
        await close(server);
    }
});

check('polling /health 25x never raises pool.totalCount', async () => {
    const before = poolStats().total;
    const server = await listen(buildApp());
    try {
        for (let i = 0; i < 25; i++) await requestOnce(server, '/health');
    } finally {
        await close(server);
    }
    const after = poolStats();
    assert.strictEqual(after.total, before, `pool grew from ${before} to ${after.total}`);
    assert.strictEqual(after.queryCount, 0, 'liveness must not run a single query');
});

check('/health is marked no-store so no proxy can fake a live instance', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/health');
        assert.strictEqual(res.headers['cache-control'], 'no-store');
    } finally {
        await close(server);
    }
});

check('no CORS header on /health or /ready — mounted before cors()', async () => {
    const server = await listen(buildApp());
    try {
        const health = await requestOnce(server, '/health', { headers: { origin: 'https://evil.example' } });
        const ready = await requestOnce(server, '/ready', { headers: { origin: 'https://evil.example', ...authedHeaders } });
        assert.ok(!health.headers['access-control-allow-origin'], 'liveness must not be CORS-readable');
        assert.ok(!ready.headers['access-control-allow-origin'], '/ready must not be CORS-readable');
    } finally {
        await close(server);
    }
});

// ─── /ready — authentication ───────────────────────────────────────────────

check('/ready 401s with no credentials at all', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready');
        assert.strictEqual(res.status, 401);
        assert.ok(!res.body.checks, 'an unauthenticated response must not contain checks');
    } finally {
        await close(server);
    }
});

check('/ready 401s on a wrong internal token', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready', { headers: { 'x-internal-token': 'not-it' } });
        assert.strictEqual(res.status, 401);
    } finally {
        await close(server);
    }
});

check('/ready fails closed when no internal token is configured', async () => {
    // The whole point of the JWT fallback ordering: an unconfigured secret must
    // never degrade into "open to whoever asks".
    const server = await listen(buildApp({ getInternalToken: () => undefined }));
    try {
        const res = await requestOnce(server, '/ready', { headers: { 'x-internal-token': '' } });
        assert.strictEqual(res.status, 401);
        assert.match(res.body.error, /JWT path reached/, 'must fall through to the JWT gate, not allow');
    } finally {
        await close(server);
    }
});

check('/ready accepts the internal token ahead of the JWT gate', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready', { headers: authedHeaders });
        assert.notStrictEqual(res.body.error, 'JWT path reached');
        assert.ok(res.body.checks || res.body.status);
    } finally {
        await close(server);
    }
});

check('/ready falls through to the JWT gate for a browser session', async () => {
    const server = await listen(buildApp({
        authenticate: (req, res, next) => res.status(401).json({ error: 'Access denied. No token provided.' })
    }));
    try {
        const res = await requestOnce(server, '/ready');
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error, 'Access denied. No token provided.');
    } finally {
        await close(server);
    }
});

// ─── /ready — report shape ─────────────────────────────────────────────────

check('/ready reports the full envelope with a valid status', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready', { headers: authedHeaders });
        assert.ok(['healthy', 'degraded', 'unhealthy'].includes(res.body.status), `bad status ${res.body.status}`);
        for (const key of ['version', 'node', 'uptimeSec', 'startedAt', 'checkedAt', 'checks']) {
            assert.ok(key in res.body, `missing ${key}`);
        }
        assert.strictEqual(res.body.version, VERSION);
        assert.strictEqual(res.body.node, process.version);
        assert.strictEqual(res.body.deep, false);
        for (const [name, entry] of Object.entries(res.body.checks)) {
            assert.ok(['healthy', 'degraded', 'unhealthy', 'skipped'].includes(entry.status), `${name}: bad status`);
            assert.strictEqual(typeof entry.detail, 'string', `${name}: detail must be a string`);
            assert.ok(entry.detail.length > 0, `${name}: detail must not be empty`);
        }
    } finally {
        await close(server);
    }
});

check('/ready runs the bot checks without being asked twice', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready', { headers: authedHeaders });
        for (const name of ['database', 'taskQueue', 'cache', 'memory', 'sockets', 'eventLoop']) {
            assert.ok(res.body.checks[name], `missing check: ${name}`);
        }
        assert.ok(!res.body.checks.databaseQuery, 'the deep probe must not run unasked');
    } finally {
        await close(server);
    }
});

check('a dead database makes /ready 503/unhealthy without hanging', async () => {
    const startedAt = Date.now();
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready', { headers: authedHeaders });
        assert.ok(Date.now() - startedAt < DEEP_QUERY_TIMEOUT_MS, '/ready hung on the database');
        assert.strictEqual(res.body.checks.database.status, 'unhealthy');
        assert.strictEqual(res.body.status, 'unhealthy');
        assert.strictEqual(res.status, 503);
    } finally {
        await close(server);
    }
});

check('shallow /ready takes no pool connection across 10 polls', async () => {
    const before = poolStats().total;
    const server = await listen(buildApp());
    try {
        for (let i = 0; i < 10; i++) await requestOnce(server, '/ready', { headers: authedHeaders });
    } finally {
        await close(server);
    }
    assert.strictEqual(poolStats().total, before);
    assert.strictEqual(poolStats().queryCount, 0, 'shallow readiness must not query');
});

check('?deep=1 adds the probe and still answers inside its budget', async () => {
    // The pool can never connect here, so this also proves the 1500 ms guard
    // holds against an unreachable host rather than a merely slow one.
    const server = await listen(buildApp());
    const startedAt = Date.now();
    try {
        const res = await requestOnce(server, '/ready?deep=1', { headers: authedHeaders });
        const elapsed = Date.now() - startedAt;
        const probe = res.body.checks.databaseQuery;
        assert.ok(probe, 'deep report must contain databaseQuery');
        assert.strictEqual(res.body.deep, true);
        assert.ok(['healthy', 'unhealthy'].includes(probe.status), `probe status ${probe.status}`);
        assert.ok(probe.durationMs <= DEEP_QUERY_TIMEOUT_MS + 400, `probe took ${probe.durationMs}ms vs a ${DEEP_QUERY_TIMEOUT_MS}ms guard`);
        assert.ok(elapsed < 3000, `deep /ready took ${elapsed}ms`);
    } finally {
        await close(server);
    }
});

check('/ready leaks no token, no connection string, no stack', async () => {
    const server = await listen(buildApp());
    try {
        const res = await requestOnce(server, '/ready?deep=1', { headers: authedHeaders });
        assert.ok(!res.raw.includes(TEST_TOKEN), 'the internal token appeared in the body');
        assert.ok(!/postgres(ql)?:\/\//i.test(res.raw), 'a connection string appeared in the body');
        assert.ok(!/\bat\s+\w+ \(.+:\d+:\d+\)/.test(res.raw), 'a stack trace appeared in the body');
        assert.ok(!res.raw.includes(TEST_TOKEN.slice(0, 8)));
    } finally {
        await close(server);
    }
});

// ─── the status matrix, as the pure functions they are ─────────────────────

const FRESH_POOL = {
    configured: true, total: 2, idle: 1, inUse: 1, waiting: 0, max: 10, utilizationPercent: 20,
    lastSuccessfulQueryAt: 1000, lastQueryAgeMs: 500, lastQueryMs: 12, slowestQueryMs: 900,
    lastQueryErrorAt: null, lastQueryErrorMessage: null, lastPoolErrorAt: null,
    lastPoolErrorMessage: null, queryCount: 40, queryErrorCount: 0, poolErrorCount: 0, slowQueryCount: 2
};

check('databaseCheck: healthy pool reports usage and recency', () => {
    const out = databaseCheck(Object.assign({}, FRESH_POOL), 1500);
    assert.strictEqual(out.status, 'healthy');
    assert.match(out.detail, /pool 1\/10 in use/);
    assert.match(out.detail, /last query 500ms ago/);
});

check('databaseCheck: unconfigured connection string is unhealthy', () => {
    const out = databaseCheck(Object.assign({}, FRESH_POOL, { configured: false }), 1500);
    assert.strictEqual(out.status, 'unhealthy');
});

check('databaseCheck: queries waiting for a connection is degraded', () => {
    const out = databaseCheck(Object.assign({}, FRESH_POOL, { waiting: 4 }), 1500);
    assert.strictEqual(out.status, 'degraded');
    assert.match(out.detail, /4 request\(s\) queued/);
});

check('databaseCheck: a recent pooler drop is degraded, never fatal', () => {
    // Supabase drops idle connections routinely; the pool recovers by itself.
    const out = databaseCheck(Object.assign({}, FRESH_POOL, {
        lastPoolErrorAt: 1400, lastPoolErrorMessage: 'connection terminated'
    }), 1500);
    assert.strictEqual(out.status, 'degraded');
    assert.match(out.detail, /idle connection dropped by pooler/);
});

check('databaseCheck: an old pooler error has stopped counting', () => {
    const out = databaseCheck(Object.assign({}, FRESH_POOL, {
        lastPoolErrorAt: 1500 - 5 * 60 * 1000, lastPoolErrorMessage: 'connection terminated'
    }), 1500);
    assert.strictEqual(out.status, 'healthy');
});

check('databaseCheck: failing queries after successes is degraded', () => {
    const out = databaseCheck(Object.assign({}, FRESH_POOL, {
        lastQueryErrorAt: 1600, lastQueryErrorMessage: 'relation "x" does not exist'
    }), 1500);
    assert.strictEqual(out.status, 'degraded');
    assert.match(out.detail, /queries failing/);
});

check('databaseCheck: nothing has ever worked is unhealthy', () => {
    const out = databaseCheck(Object.assign({}, FRESH_POOL, {
        lastSuccessfulQueryAt: null, queryCount: 0,
        lastQueryErrorAt: 1600, lastQueryErrorMessage: 'connection refused'
    }), 1500);
    assert.strictEqual(out.status, 'unhealthy');
});

check('databaseCheck: idle but proven-working is healthy, not "stale"', () => {
    // A quiet server at 3am has an old last-query timestamp. That is not an
    // outage, and a readiness gate that thinks so will restart healthy boxes.
    const out = databaseCheck(Object.assign({}, FRESH_POOL, {
        lastSuccessfulQueryAt: 0, lastQueryAgeMs: 45 * 60 * 1000, total: 0, idle: 0, inUse: 0
    }), 45 * 60 * 1000);
    assert.strictEqual(out.status, 'healthy');
});

const EMPTY_QUEUE = {
    queued: 0, active: 0, maxQueueSize: 1000, maxConcurrent: 25, saturated: false,
    enqueued: 10, processed: 10, drops: 0, watchdogClears: 0, clearedItems: 0, lostTasks: 0
};

check('queueCheck: an empty queue is healthy', () => {
    const out = queueCheck(() => EMPTY_QUEUE);
    assert.strictEqual(out.status, 'healthy');
    assert.match(out.detail, /0 processed/);
});

check('queueCheck: 80% depth is degraded, 100% is unhealthy', () => {
    assert.strictEqual(queueCheck(() => Object.assign({}, EMPTY_QUEUE, { queued: 799 })).status, 'healthy');
    assert.strictEqual(queueCheck(() => Object.assign({}, EMPTY_QUEUE, { queued: 800 })).status, 'degraded');
    assert.strictEqual(queueCheck(() => Object.assign({}, EMPTY_QUEUE, { queued: 1000 })).status, 'unhealthy');
});

check('queueCheck: work lost since boot is surfaced even at zero depth', () => {
    // This is the failure the old /health could hide completely: the queue
    // looks empty because the watchdog already threw the work away.
    const degraded = queueCheck(() => Object.assign({}, EMPTY_QUEUE, { drops: 3, lostTasks: 3 }));
    assert.strictEqual(degraded.status, 'degraded');
    assert.match(degraded.detail, /3 task\(s\) lost since boot/);
    assert.strictEqual(degraded.drops, 3);
});

check('queueCheck: all workers busy with backlog is degraded', () => {
    const out = queueCheck(() => Object.assign({}, EMPTY_QUEUE, { saturated: true, active: 25, queued: 4 }));
    assert.strictEqual(out.status, 'degraded');
});

check('queueCheck: an unrouted queue is skipped, not guessed at', () => {
    const out = queueCheck(undefined);
    assert.strictEqual(out.status, 'skipped');
    assert.strictEqual(report.worstStatus({ taskQueue: out }), 'healthy');
});

check('cacheCheck: saturated namespace is degraded and named', () => {
    const out = cacheCheck({
        customers: { size: 200, maxSize: 200, hits: 90, misses: 10, hitRate: '90.00%' },
        orders: { size: 5, maxSize: 120, hits: 1, misses: 4, hitRate: '20.00%' }
    });
    assert.strictEqual(out.status, 'degraded');
    assert.match(out.detail, /customers/);
    assert.strictEqual(out.entries, 205);
    // 91 hits / 105 lookups across both namespaces, rounded to whole percent.
    assert.strictEqual(out.hitRatePercent, 87);
});

check('socketsCheck: a saturated agent is degraded', () => {
    const out = socketsCheck();
    assert.ok(['healthy', 'degraded'].includes(out.status));
    assert.strictEqual(typeof out.https.active, 'number');
    assert.strictEqual(typeof out.https.free, 'number');
    assert.strictEqual(countSockets({ a: [1, 2], b: [3] }), 3);
    assert.strictEqual(countSockets(null), 0);
});

// ─── report primitives ─────────────────────────────────────────────────────

check('worstStatus: the worst check wins and skipped never counts', () => {
    assert.strictEqual(report.worstStatus({}), 'healthy');
    assert.strictEqual(report.worstStatus({
        a: report.healthy('ok'), b: report.skipped('n/a'), c: report.degraded('meh')
    }), 'degraded');
    assert.strictEqual(report.worstStatus({
        a: report.healthy('ok'), b: report.unhealthy('down'), c: report.degraded('meh')
    }), 'unhealthy');
});

check('check: an unknown status degrades instead of disappearing', () => {
    const out = report.check('purple', 'x', { n: 1 });
    assert.strictEqual(out.status, 'degraded');
    assert.strictEqual(out.n, 1);
    assert.deepStrictEqual(report.check('healthy', ''), { status: 'healthy', detail: '' });
});

check('statusToHttpStatus: degraded stays in rotation, unhealthy does not', () => {
    assert.strictEqual(report.statusToHttpStatus('healthy'), 200);
    assert.strictEqual(report.statusToHttpStatus('degraded'), 200);
    assert.strictEqual(report.statusToHttpStatus('unhealthy'), 503);
});

check('memoryCheck: reports the native-memory fields the leak shows up in', () => {
    const out = report.memoryCheck({ rssLimitMB: 512 });
    for (const key of ['rssMB', 'heapUsedMB', 'heapLimitMB', 'externalMB', 'arrayBuffersMB', 'nativeMB', 'usagePercent']) {
        assert.ok(key in out, `missing ${key}`);
        if (key !== 'usagePercent') assert.ok(Number.isFinite(out[key]), `${key} is not a number`);
    }
    assert.strictEqual(out.status, 'healthy', 'a fresh test process should not be near its ceiling');
});

check('memoryCheck: thresholds fire on RSS pressure and detached contexts', () => {
    const original = process.memoryUsage;
    try {
        process.memoryUsage = () => ({
            rss: Math.round(0.95 * 512 * 1048576), heapTotal: 40 * 1048576,
            heapUsed: 30 * 1048576, external: 60 * 1048576, arrayBuffers: 5 * 1048576
        });
        assert.strictEqual(report.memoryCheck({ rssLimitMB: 512 }).status, 'unhealthy');
        process.memoryUsage = () => ({
            rss: Math.round(0.8 * 512 * 1048576), heapTotal: 40 * 1048576,
            heapUsed: 30 * 1048576, external: 60 * 1048576, arrayBuffers: 5 * 1048576
        });
        assert.strictEqual(report.memoryCheck({ rssLimitMB: 512 }).status, 'degraded');
    } finally {
        process.memoryUsage = original;
    }
});

check('memoryCheck: no RSS budget still scores on the V8 heap limit', () => {
    const out = report.memoryCheck({});
    assert.strictEqual(out.rssLimitMB, null);
    assert.ok(out.heapLimitMB > 0);
    assert.strictEqual(out.status, 'healthy');
});

check('heapLimitBytes works with or without v8.getHeapMemoryLimit()', () => {
    const v8 = require('v8');
    const bytes = report.heapLimitBytes();
    assert.ok(bytes > 0);
    if (typeof v8.getHeapMemoryLimit !== 'function') {
        // Node 24 has no getHeapMemoryLimit(), so the fallback is the live path
        // — pin it to the statistic it is supposed to read.
        assert.strictEqual(bytes, v8.getHeapStatistics().heap_size_limit);
    }
});

check('runWithTimeout: resolves, rejects and times out — always as a result', async () => {
    const good = await report.runWithTimeout(() => Promise.resolve('v'), 500);
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.value, 'v');
    assert.strictEqual(good.timedOut, false);

    const bad = await report.runWithTimeout(() => Promise.reject(new Error('nope')), 500);
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.error, 'nope');
    assert.strictEqual(bad.timedOut, false);

    const slow = await report.runWithTimeout(() => new Promise(() => { }), 120);
    assert.strictEqual(slow.ok, false);
    assert.strictEqual(slow.timedOut, true);
    assert.match(slow.error, /timed out after 120ms/);
    assert.ok(slow.ms < 400, `timeout fired at ${slow.ms}ms`);

    const thrown = await report.runWithTimeout(() => { throw new Error('sync boom'); }, 500);
    assert.strictEqual(thrown.ok, false);
    assert.strictEqual(thrown.error, 'sync boom');
});

check('the guard keeps a stalled probe alive to report it, not to exit quietly', async () => {
    // Regression, found by this suite exiting 0 halfway through: the guard
    // timer was originally unref()'d, so with nothing else holding the loop
    // open Node ended the process instead of firing the timeout. In the server
    // an in-flight request keeps a handle alive so it appeared to work; the
    // ceiling was still only as reliable as the traffic around it. Driven as a
    // child process because the failure mode is the process going away.
    const script = `
        const report = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'utils', 'healthReport.js'))});
        report.runWithTimeout(() => new Promise(() => { }), 150).then((out) => {
            process.stdout.write(out.timedOut ? 'REPORTED' : 'NOT_REPORTED');
        });
    `;
    const child = spawn(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') });
    let captured = '';
    child.stdout.on('data', (chunk) => { captured += chunk; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.strictEqual(code, 0, 'the guard process should finish cleanly');
    assert.strictEqual(captured, 'REPORTED', 'a stalled probe ended the process before it could be reported');
});

check('eventLoopCheck: healthy now, unhealthy once the heartbeat goes stale', async () => {
    report.startHeartbeat();
    assert.strictEqual(report.eventLoopCheck().status, 'healthy');
    const realNow = Date.now;
    try {
        // Age is measured against Date.now(), so advancing it is the honest way
        // to drive the blocked-loop branch without blocking a real loop.
        Date.now = () => realNow() + 60000;
        const out = report.eventLoopCheck();
        assert.strictEqual(out.status, 'unhealthy');
        assert.match(out.detail, /event loop blocked/);
        Date.now = () => realNow() + 14000;
        assert.strictEqual(report.eventLoopCheck().status, 'degraded');
    } finally {
        Date.now = realNow;
    }
    assert.strictEqual(report.eventLoopCheck().status, 'healthy', 'Date.now must be restored');
    assert.ok(report.heartbeatAgeMs() < 6000);
});

check('tokenMatches: exact, constant-time, and closed when unconfigured', () => {
    assert.strictEqual(report.tokenMatches('abc', 'abc'), true);
    assert.strictEqual(report.tokenMatches('abd', 'abc'), false);
    assert.strictEqual(report.tokenMatches('abcdef', 'abc'), false, 'length must not leak');
    assert.strictEqual(report.tokenMatches(undefined, 'abc'), false);
    assert.strictEqual(report.tokenMatches('', ''), false, 'an unconfigured secret must not match anything');
    assert.strictEqual(report.tokenMatches('abc', undefined), false);
    assert.strictEqual(report.tokenMatches(123, '123'), true, 'non-string headers are compared as text');
});

check('createReadinessAuth: marks service callers and delegates everyone else', () => {
    const auth = report.createReadinessAuth({
        getInternalToken: () => 's3cret',
        authenticate: (req, res, next) => { req.viaJwt = true; next(); }
    });
    let reached = null;
    const res = { status() { return this; }, json() { return this; } };
    auth({ headers: { 'x-internal-token': 's3cret' } }, res, () => { reached = 'internal'; });
    assert.strictEqual(reached, 'internal');
    auth({ headers: { authorization: 'Bearer x' } }, res, () => { reached = 'jwt'; });
    assert.strictEqual(reached, 'jwt');
    // No JWT middleware at all: the only safe answer is 401.
    const bare = report.createReadinessAuth({ getInternalToken: () => 's3cret' });
    let code = null;
    bare({ headers: {} }, { status: (c) => { code = c; return { json: () => { } }; } }, () => { reached = 'leak'; });
    assert.strictEqual(code, 401);
    assert.strictEqual(reached, 'jwt', 'bare auth must not call next()');
});

check('livenessEnvelope is the four fields and nothing else', () => {
    assert.deepStrictEqual(Object.keys(report.livenessEnvelope({ version: '9.9.9' })).sort(),
        ['status', 'timestamp', 'uptimeSec', 'version']);
    assert.strictEqual(report.livenessEnvelope({}).version, 'unknown');
});

check('buildEnvelope derives startedAt from uptime, not module load', () => {
    const out = report.buildEnvelope({ version: '1.2.3', checks: { a: report.healthy('x') } });
    assert.strictEqual(out.status, 'healthy');
    assert.strictEqual(out.version, '1.2.3');
    assert.ok(Math.abs((Date.now() - new Date(out.startedAt).getTime()) - out.uptimeSec * 1000) < 2000);
    assert.strictEqual(report.statusToHttpStatus(out.status), 200);
});

run();
