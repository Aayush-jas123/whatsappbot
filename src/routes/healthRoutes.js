/**
 * healthRoutes.js — liveness and readiness for the WhatsApp order bot
 * (Phase 1 §B1–B5).
 *
 * WHAT THIS REPLACES:
 * a two-field stub. It answered "is Express responding?" and nothing else, so a
 * Render instance whose database was dead, whose task queue was dropping work,
 * or whose event loop was wedged still reported itself as healthy — and it did
 * so to the one endpoint the deploy would eventually poll before restarting an
 * already-suffering instance.
 *
 * THE SPLIT:
 *   /health  liveness. Constant cost, no database, no network, no allocation.
 *            Answers "is this process able to answer HTTP?" and nothing more,
 *            which is exactly what a restart-on-failure probe should ask.
 *            Deliberately registered BEFORE cors() and the rate limiters in
 *            server.js so a saturated or rate-limited instance can still prove
 *            it is alive.
 *   /ready   readiness. The checks below, each a read of a counter that already
 *            exists. Authenticated, because pool sizing, queue depth and memory
 *            headroom are operational detail with no business in a public
 *            response body.
 *
 * WHY A FACTORY:
 * taskQueue and MAX_QUEUE_SIZE are locals of server.js and the memory ceiling
 * is a deploy fact, not a module fact. Taking them as arguments keeps this file
 * free of globals and lets the C3 test build a router over an empty queue and a
 * full one without starting the bot.
 */

const express = require('express');
const { pool, poolStats, dbAdapter } = require('../database/db');
const { getCacheStats } = require('../utils/cache');
const { sharedHttpsAgent, sharedHttpAgent, FREE_SOCKET_TTL_MS } = require('../utils/httpAgent');
const { verifyToken } = require('../middleware/auth');
const report = require('../utils/healthReport');

// ?deep=1 is the only path here that touches the database, and it is capped
// hard: a readiness probe that hangs is worse than one that reports unhealthy.
const DEEP_QUERY_TIMEOUT_MS = 1500;
// How recently a query error has to be to still count as "happening now".
const RECENT_ERROR_WINDOW_MS = 60 * 1000;
// Queue depth as a fraction of MAX_QUEUE_SIZE at which dropping work becomes
// likely (enqueueTask drops the oldest task once the queue is full).
const QUEUE_DEGRADED_RATIO = 0.8;

function isRecent(timestampMs, nowMs) {
    return typeof timestampMs === 'number' && (nowMs - timestampMs) <= RECENT_ERROR_WINDOW_MS;
}

// ---------------------------------------------------------------- checks ----

// Reads poolStats() only. The distinction that matters here is "the pool is
// empty because nothing is running" versus "the pool is empty because nothing
// has ever worked" — the timestamps separate them without a probe query.
function databaseCheck(stats, nowMs) {
    if (!stats.configured) {
        return report.check('unhealthy', 'SUPABASE_DB_URL is not configured — no database connection is possible', stats);
    }
    const queriesFailing = isRecent(stats.lastQueryErrorAt, nowMs)
        && (stats.lastSuccessfulQueryAt === null || stats.lastQueryErrorAt > stats.lastSuccessfulQueryAt);

    if (stats.queryCount === 0 && queriesFailing) {
        return report.check('unhealthy', `no query has succeeded since boot: ${stats.lastQueryErrorMessage}`, stats);
    }
    if (stats.waiting > 0) {
        return report.check('degraded', `${stats.waiting} request(s) queued for a connection (pool ${stats.inUse}/${stats.max} in use)`, stats);
    }
    if (queriesFailing) {
        return report.check('degraded', `queries failing: ${stats.lastQueryErrorMessage}`, stats);
    }
    if (stats.lastSuccessfulQueryAt === null) {
        return report.check('degraded', 'no query has completed since boot', stats);
    }
    if (isRecent(stats.lastPoolErrorAt, nowMs)) {
        // Expected routine here — Supabase's pooler drops idle connections and
        // the pool recovers on its own — so it degrades, never fails.
        return report.check('degraded', `idle connection dropped by pooler: ${stats.lastPoolErrorMessage}`, stats);
    }
    return report.check('healthy',
        `pool ${stats.inUse}/${stats.max} in use, ${stats.idle} idle, last query ${stats.lastQueryAgeMs}ms ago (${stats.lastQueryMs}ms)`
        + (stats.slowestQueryMs ? `, slowest ${stats.slowestQueryMs}ms` : ''),
        stats);
}

async function deepDatabaseCheck() {
    const outcome = await report.runWithTimeout(() => dbAdapter.query('SELECT 1'), DEEP_QUERY_TIMEOUT_MS);
    if (outcome.ok) {
        return report.check('healthy', `SELECT 1 round-tripped in ${outcome.ms}ms (1500ms budget)`, { durationMs: outcome.ms, timeoutMs: DEEP_QUERY_TIMEOUT_MS });
    }
    if (outcome.timedOut) {
        return report.check('unhealthy', `SELECT 1 exceeded ${DEEP_QUERY_TIMEOUT_MS}ms — connections are being acquired but never served`, { durationMs: outcome.ms, timeoutMs: DEEP_QUERY_TIMEOUT_MS });
    }
    return report.check('unhealthy', `SELECT 1 failed: ${outcome.error}`, { durationMs: outcome.ms, timeoutMs: DEEP_QUERY_TIMEOUT_MS });
}

function cacheCheck(stats) {
    const namespaces = Object.entries(stats || {});
    let entries = 0;
    let hits = 0;
    let misses = 0;
    const saturated = [];
    const perNamespace = {};

    for (const [name, one] of namespaces) {
        entries += one.size || 0;
        hits += one.hits || 0;
        misses += one.misses || 0;
        perNamespace[name] = { size: one.size || 0, maxSize: one.maxSize || null, hitRate: one.hitRate };
        if (one.maxSize && one.size >= one.maxSize) saturated.push(name);
    }

    const total = hits + misses;
    const hitRate = total > 0 ? `${Math.round(hits / total * 100)}%` : 'n/a';
    const metrics = { entries, hits, misses, hitRatePercent: total > 0 ? Math.round(hits / total * 100) : null, namespaces: perNamespace };

    if (saturated.length) {
        return report.check('degraded', `${entries} entries, hit rate ${hitRate} — at capacity and evicting: ${saturated.join(', ')}`, metrics);
    }
    return report.check('healthy', `${entries} entries across ${namespaces.length} caches, hit rate ${hitRate}`, metrics);
}

// taskQueue is module-local to server.js, so the numbers arrive through
// getQueueStats(). The counters that matter are the destructive ones: a full
// queue silently drops the oldest task and the watchdog empties the queue past
// 100 items, so "0 now" means nothing without "how many were lost".
function queueCheck(getQueueStats) {
    if (typeof getQueueStats !== 'function') {
        return report.skipped('no queue was wired into this router');
    }
    let stats;
    try {
        stats = getQueueStats() || {};
    } catch (e) {
        return report.check('unhealthy', `queue stats unavailable: ${e.message}`);
    }

    const depth = stats.queued || 0;
    const capacity = stats.maxQueueSize || 0;
    const ratio = capacity > 0 ? depth / capacity : 0;
    const lost = (stats.drops || 0) + (stats.clearedItems || 0);
    const metrics = {
        queued: depth,
        active: stats.active || 0,
        maxQueueSize: capacity,
        maxConcurrent: stats.maxConcurrent || null,
        fullPercent: capacity > 0 ? Math.round(ratio * 100) : 0,
        enqueued: stats.enqueued || 0,
        processed: stats.processed || 0,
        drops: stats.drops || 0,
        watchdogClears: stats.watchdogClears || 0,
        clearedItems: stats.clearedItems || 0,
        lostTasks: lost
    };

    if (ratio >= 1) {
        return report.check('unhealthy', `queue full (${depth}/${capacity}) — new tasks are dropping the oldest`, metrics);
    }
    if (ratio >= QUEUE_DEGRADED_RATIO) {
        return report.check('degraded', `queue at ${metrics.fullPercent}% (${depth}/${capacity})`, metrics);
    }
    if (lost > 0) {
        return report.check('degraded', `${depth} queued, ${lost} task(s) lost since boot (${metrics.drops} dropped, ${metrics.clearedItems} cleared by watchdog)`, metrics);
    }
    if (stats.saturated) {
        return report.check('degraded', `${depth} queued, ${stats.active}/${metrics.maxConcurrent} workers busy`, metrics);
    }
    return report.check('healthy', `${depth} queued, ${stats.active}/${metrics.maxConcurrent || '?'} workers busy, ${metrics.processed} processed`, metrics);
}

// Outbound socket pressure. The shared agents are the only egress for Meta,
// Shiprocket, Delhivery, Ekart, Shopify, Zoho and the AI providers, so a
// saturated agent queues every integration at once — and parked free sockets
// are precisely the native-memory leak the reaper exists for.
function countSockets(byHost) {
    if (!byHost || typeof byHost !== 'object') return 0;
    let count = 0;
    for (const list of Object.values(byHost)) {
        if (Array.isArray(list)) count += list.length;
    }
    return count;
}

function agentSummary(name, agent) {
    const active = countSockets(agent && agent.sockets);
    const free = countSockets(agent && agent.freeSockets);
    return { name, active, free, maxSockets: agent && agent.options ? agent.options.maxSockets : null };
}

function socketsCheck() {
    const https = agentSummary('https', sharedHttpsAgent);
    const http = agentSummary('http', sharedHttpAgent);
    const metrics = { https, http, freeSocketTtlMs: FREE_SOCKET_TTL_MS };
    const saturated = [https, http].filter(a => a.maxSockets && a.active >= a.maxSockets);
    const detail = `https ${https.active} active/${https.free} free (max ${https.maxSockets}), http ${http.active} active/${http.free} free (max ${http.maxSockets})`;

    if (saturated.length) {
        return report.check('degraded', `${detail} — ${saturated.map(a => a.name).join(' and ')} agent(s) at connection limit, outbound calls are queueing`, metrics);
    }
    return report.check('healthy', detail, metrics);
}

// --------------------------------------------------------------- router -----

function createHealthRouter(deps = {}) {
    const version = deps.version || 'unknown';
    const rssLimitMB = deps.rssLimitMB || 512;
    const router = express.Router();

    const authorize = deps.authorize || report.createReadinessAuth({
        getInternalToken: deps.getInternalToken || (() => process.env.WHATSAPP_INTERNAL_TOKEN),
        authenticate: deps.authenticate || verifyToken
    });

    // Liveness. Nothing below this line may do work.
    router.get('/health', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(report.livenessEnvelope({ version }));
    });

    router.get('/ready', authorize, async (req, res) => {
        const nowMs = Date.now();
        const deep = req.query.deep === '1' || req.query.deep === 'true';
        const checks = {};

        try {
            checks.database = databaseCheck(poolStats(), nowMs);
            checks.taskQueue = queueCheck(deps.getQueueStats);
            checks.cache = cacheCheck(getCacheStats());
            checks.memory = report.memoryCheck({ rssLimitMB });
            checks.sockets = socketsCheck();
            checks.eventLoop = report.eventLoopCheck();

            if (deep) {
                // Only reached on demand, so the ordinary poll path — the one a
                // load balancer drives — still never touches the pool.
                checks.databaseQuery = await deepDatabaseCheck();
            }
        } catch (e) {
            // A throwing check must not turn into a 500 with no explanation,
            // and must never echo a stack or a connection string.
            checks.collection = report.check('unhealthy', `readiness checks failed: ${e.message}`);
        }

        const status = report.worstStatus(checks);
        // Echo which checks ran so a reader never mistakes a shallow report for
        // a deep one that happened to pass.
        const envelope = report.buildEnvelope({ version, status, checks });
        envelope.deep = deep;

        res.status(report.statusToHttpStatus(status)).set('Cache-Control', 'no-store').json(envelope);
    });

    return router;
}

module.exports = {
    createHealthRouter,
    databaseCheck,
    deepDatabaseCheck,
    cacheCheck,
    queueCheck,
    socketsCheck,
    countSockets,
    DEEP_QUERY_TIMEOUT_MS,
    QUEUE_DEGRADED_RATIO
};
