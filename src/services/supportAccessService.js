const { dbAdapter } = require('../database/db');
const { caches } = require('../utils/cache');
const Support = require('./supportService');

// ============================================================
// SupportAccessService — the Access tab engine behind /desk.
//
// The whitelist (support_whitelist) is the only gate the storefront
// Help & Tickets tab has, so this module owns everything around it:
//   · the access policy (support_settings key 'access')
//   · the 60s in-memory snapshot the customer gate + webhooks read
//   · segment queries that turn "who should get access?" into SQL
//   · bulk grant / revoke / cleanup / import primitives
//
// Segments are declared once and reused by the count aggregates, the
// candidate browser and the bulk-grant path, so a segment can never
// mean different things in different places.
//
// Every phone that leaves this module is normalized through
// Support.normalizePhone's rules, mirrored in SQL by normSql() —
// store_shoppers in particular stores '+91 98765 43210', '09876543210'
// and '919876543210' for the same human being.
// ============================================================

const ACCESS_SETTING_KEY = 'access';
const SNAP_TTL_MS = 60 * 1000;
const MAX_BULK = 20000;
const MAX_PAGE = 5000;

const MODES = ['whitelist', 'open', 'closed'];
const LEVELS = ['full', 'view'];

const POLICY_DEFAULTS = {
    mode: 'whitelist',          // whitelist = only listed phones; open = every verified customer; closed = nobody
    defaultDays: 0,             // access length handed to new grants (0 = permanent)
    defaultLevel: 'full',       // 'full' can raise tickets, 'view' is read-only
    syncOnGrant: true,          // pull the customer's Shopify orders when they are added
    verifyBeforeGrant: false,   // skip phones we have never seen in tickets/orders/shoppers
    autoGrantNewTickets: false, // whitelist a customer automatically when a ticket lands
    autoGrantChannel: 'website',// 'website' | 'any' — which channels auto-grant applies to
    dormantRevokeDays: 0,       // 0 = off; feeds the "revoke dormant" cleanup
    agentMayGrant: true,        // desk agents without the master-admin role may grant/revoke
    webhookCacheFollowsList: true, // only cache Shopify orders for explicitly listed phones
    notifyOnGrant: false        // queue the support_desk_intro WhatsApp message on every grant
};

function clampEnum(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
}

// Merges whatever is stored over the defaults so a half-written policy
// (or one saved by an older build) can never leave a toggle undefined.
async function getPolicy() {
    const stored = (await Support.getSetting(ACCESS_SETTING_KEY)) || {};
    const out = { ...POLICY_DEFAULTS, ...stored };
    out.mode = clampEnum(out.mode, MODES, 'whitelist');
    out.defaultLevel = clampEnum(out.defaultLevel, LEVELS, 'full');
    out.autoGrantChannel = out.autoGrantChannel === 'any' ? 'any' : 'website';
    out.defaultDays = Math.max(0, Math.min(3650, Number(out.defaultDays) || 0));
    out.dormantRevokeDays = Math.max(0, Math.min(3650, Number(out.dormantRevokeDays) || 0));
    out.syncOnGrant = out.syncOnGrant !== false;
    out.verifyBeforeGrant = !!out.verifyBeforeGrant;
    out.autoGrantNewTickets = !!out.autoGrantNewTickets;
    out.agentMayGrant = out.agentMayGrant !== false;
    out.webhookCacheFollowsList = out.webhookCacheFollowsList !== false;
    out.notifyOnGrant = !!out.notifyOnGrant;
    return out;
}

async function savePolicy(patch) {
    const next = { ...await getPolicy(), ...(patch || {}) };
    await Support.putSetting(ACCESS_SETTING_KEY, next);
    invalidateSnapshot();
    invalidateStatsCache();
    return getPolicy();
}

// ---------- schema probing ----------
// The three extra whitelist columns are added by initializeDatabase() at boot,
// but a deploy can race the DDL. Rather than 500ing the tab, the module degrades
// to the legacy (phone, note, added_by) shape and tells the UI it did.
let extCols = null;
async function hasExtendedColumns() {
    if (extCols !== null) return extCols;
    try {
        await dbAdapter.query('SELECT access_level, expires_at, source FROM support_whitelist LIMIT 1');
        extCols = true;
    } catch (e) {
        extCols = false;
    }
    return extCols;
}

// ---------- phone normalization in SQL ----------
// Mirrors Support.normalizePhone: 10 digits -> 91+10, leading 0 dropped,
// 0091 stripped. Anything left over that is not exactly 12 digits is invalid
// and gets filtered by VALID_RE. This used to be an inline CASE +
// REGEXP_REPLACE; the same mapping now lives in the IMMUTABLE
// support_normalize_phone() SQL function (created at boot by
// initializePerformanceIndexes and by migrate-add-phone-norm-indexes.js,
// which builds it CONCURRENTLY), so the b-tree expression indexes below it
// can turn the Access-tab phone aggregates into index-only scans.
function normSql(col) {
    return `support_normalize_phone(${col})`;
}
const VALID_RE = '^91[0-9]{10}$';

// ---------- access snapshot ----------
// One snapshot serves the customer gate, the theme's tab-visibility probe and
// the webhook filter, so a grant or revocation is visible everywhere at once
// (invalidateSnapshot) instead of after three separate TTLs drift apart.
let snap = null;

async function buildSnapshot() {
    const policy = await getPolicy();
    const ext = await hasExtendedColumns();
    const cols = ext
        ? 'phone, access_level, expires_at'
        : 'phone';
    const rows = await dbAdapter.query(`SELECT ${cols} FROM support_whitelist`);
    const now = Date.now();
    const list = new Map();
    for (const r of rows) {
        const phone = Support.normalizePhone(r.phone);
        if (!phone) continue;
        const expiresAt = ext && r.expires_at ? new Date(r.expires_at).getTime() : null;
        if (expiresAt && expiresAt < now) continue;   // expired grants are inert
        list.set(phone, { level: (ext && r.access_level) || 'full', expiresAt });
    }
    return { ts: now, policy, ext, list };
}

async function getSnapshot(force) {
    if (!snap || force || Date.now() - snap.ts > SNAP_TTL_MS) snap = await buildSnapshot();
    return snap;
}

function invalidateSnapshot() { snap = null; }

// Full access decision for a storefront customer.
// Returns { allowed, level, via } — 'via' says which rule granted it so the
// desk can explain a customer's state instead of guessing.
async function checkAccess(phone) {
    const p = Support.normalizePhone(phone);
    const snapshot = await getSnapshot();
    if (!p) return { allowed: false, level: null, via: 'invalid-phone' };
    if (snapshot.policy.mode === 'closed') return { allowed: false, level: null, via: 'mode-closed' };
    const row = snapshot.list.get(p);
    if (row) return { allowed: true, level: row.level, via: 'whitelist' };
    if (snapshot.policy.mode === 'open') return { allowed: true, level: 'full', via: 'mode-open' };
    return { allowed: false, level: null, via: 'not-listed' };
}

// Explicit-list membership only — never satisfied by "open" mode. This is what
// gates the Shopify order webhook firehose: opening access to the whole shop
// must not silently start caching every order in the store.
async function isListed(phone) {
    const p = Support.normalizePhone(phone);
    if (!p) return false;
    const snapshot = await getSnapshot();
    return snapshot.list.has(p);
}

// Back-compat name used by the webhook path.
async function isWhitelistedCached(phone) {
    const policy = (await getSnapshot()).policy;
    // With webhook caching released from the list, the gate widens to everyone
    // the customer gate would let in.
    if (!policy.webhookCacheFollowsList) return Boolean((await checkAccess(phone)).allowed);
    return isListed(phone);
}

// ---------- segments ----------
// Each segment supplies:
//   label / group / hint  — what the Access tab renders
//   phones(ctx)           — SQL returning DISTINCT normalized phones
//   agg()                 — ONE aggregate query returning counts for every
//                           segment that shares the source, keyed by segment id
// Bulk grants run off phones(), so "allow everyone with an active ticket" and
// the number on that card can never disagree.
const TICKET_LIVE = "status NOT IN ('closed', 'resolved')";

// The desk's approval sub-issues, quoted for an IN-list. Straight from the
// supportService taxonomy constants — never from user input.
const REQUEST_KEY_LIST = Object.keys(Support.REQUESTS || {})
    .map(k => `'${String(k).replace(/'/g, "''")}'`).join(', ') || "''";

// Thresholds that live in admin settings are read once per request and inlined
// as coerced numbers, so a segment stays a single SQL string (no extra bind
// plumbing through every caller) and can still never be injection-vector.
async function segmentCtx() {
    const [policy, cost] = await Promise.all([getPolicy(), Support.getSetting('cost_config')]);
    return {
        highValue: Math.max(0, Number((cost || {}).high_value) || 2500),
        dormantDays: Number(policy.dormantRevokeDays) > 0 ? Number(policy.dormantRevokeDays) : 90
    };
}

const SEGMENTS = {
    // ── Support activity ──
    active_tickets: {
        label: 'Active support tickets',
        group: 'Support activity',
        hint: 'Customers with a ticket the team has not closed yet.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE ${TICKET_LIVE}`
    },
    open_tickets: {
        label: 'Tickets waiting on us',
        group: 'Support activity',
        hint: 'status = open: nobody has answered these customers yet.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE status = 'open'`
    },
    awaiting_customer: {
        label: 'Waiting on the customer',
        group: 'Support activity',
        hint: 'status = awaiting: we replied and the ball is in their court.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE status = 'awaiting'`
    },
    follow_up: {
        label: 'Parked for follow-up',
        group: 'Support activity',
        hint: 'status = follow_up: the team is waiting on something before answering.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE status = 'follow_up'`
    },
    high_priority: {
        label: 'High-priority cases',
        group: 'Support activity',
        hint: 'Live tickets flagged high (DNR, wrong product, wrong charge).',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE ${TICKET_LIVE} AND priority = 'high'`
    },
    escalated: {
        label: 'Escalations',
        group: 'Support activity',
        hint: 'Live tickets routed to the escalation team.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE ${TICKET_LIVE} AND team = 'escalation'`
    },
    approval_queue: {
        label: 'Approvals pending',
        group: 'Support activity',
        hint: 'Customers whose ticket needs a desk decision (cancel, address, return, exchange).',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE ${TICKET_LIVE} AND (reason || '/' || sub) IN (${REQUEST_KEY_LIST})`
    },
    any_ticket_history: {
        label: 'Anyone who ever wrote in',
        group: 'Support activity',
        hint: 'Every phone with at least one ticket in the history.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets`
    },
    ticketed_30d: {
        label: 'Wrote in last 30 days',
        group: 'Support activity',
        hint: 'Recent ticket activity, regardless of status.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_tickets
                       WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'`
    },
    closed_only: {
        label: 'Tickets all closed',
        group: 'Support activity',
        hint: 'Wrote in before, nothing live — candidates for a read-only pass.',
        phones: () => `SELECT phone FROM (
                          SELECT ${normSql('customer_phone')} AS phone,
                                 COUNT(*) FILTER (WHERE ${TICKET_LIVE}) AS live_cnt
                          FROM support_tickets GROUP BY 1) t
                        WHERE t.live_cnt = 0`
    },

    // ── Order state (webhook cache) ──
    live_orders: {
        label: 'Order in flight',
        group: 'Order state',
        hint: 'Has an order that is not delivered, cancelled or returning.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE stage NOT IN ('delivered', 'cancelled', 'rto')`
    },
    unshipped: {
        label: 'Order not shipped',
        group: 'Order state',
        hint: 'Still in our hands — address and cancellation windows are open.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE stage = 'unshipped'`
    },
    cod_unshipped: {
        label: 'COD not shipped',
        group: 'Order state',
        hint: 'Cash-on-delivery orders awaiting confirmation.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE stage = 'unshipped' AND UPPER(COALESCE(payment, '')) LIKE '%COD%'`
    },
    in_transit: {
        label: 'Shipped / out for delivery',
        group: 'Order state',
        hint: 'Parcel with the courier right now.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE stage IN ('shipped', 'out_for_delivery')`
    },
    rto: {
        label: 'Parcel returning to us (RTO)',
        group: 'Order state',
        hint: 'Delivery failed and the parcel is coming back.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE stage = 'rto'`
    },
    return_exchange: {
        label: 'Return or exchange running',
        group: 'Order state',
        hint: 'A return pickup or an exchange is in progress.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE stage IN ('return', 'exchange')`
    },
    delivered_only: {
        label: 'Everything delivered',
        group: 'Order state',
        hint: 'Has orders, none of them still moving.',
        phones: () => `SELECT phone FROM (
                          SELECT ${normSql('customer_phone')} AS phone,
                                 BOOL_AND(stage IN ('delivered', 'cancelled', 'rto')) AS done
                          FROM support_order_cache GROUP BY 1) o WHERE o.done`
    },

    // ── Customer value ──
    repeat_buyers: {
        label: 'Repeat buyers',
        group: 'Customer value',
        hint: 'Two or more orders on file.',
        phones: () => `SELECT phone FROM (
                          SELECT ${normSql('customer_phone')} AS phone, COUNT(*) AS n
                          FROM support_order_cache GROUP BY 1) o WHERE o.n >= 2`
    },
    high_value: {
        label: 'High-value orders',
        group: 'Customer value',
        hint: 'At least one order above the high-value threshold in Cost & risk.',
        phones: (ctx) => `SELECT phone FROM (
                          SELECT ${normSql('customer_phone')} AS phone, MAX(COALESCE(total, 0)) AS mx
                          FROM support_order_cache GROUP BY 1) o
                        WHERE o.mx >= ${ctx.highValue}`
    },
    ordered_30d: {
        label: 'Ordered in last 30 days',
        group: 'Customer value',
        hint: 'Current demand — most support need shows up here first.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE placed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'`
    },
    ordered_90d: {
        label: 'Ordered in last 90 days',
        group: 'Customer value',
        hint: 'Quarterly window across every channel we recorded.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache
                       WHERE placed_at >= CURRENT_TIMESTAMP - INTERVAL '90 days'`
    },

    // ── Known audiences ──
    all_known: {
        label: 'All known customers',
        group: 'Known audiences',
        hint: 'Every phone seen in an order, a ticket or the Shoppers Hub.',
        phones: () => KNOWN_PHONES_CTE + 'SELECT phone FROM known'
    },
    shoppers_hub: {
        label: 'Ordered via Shoppers Hub',
        group: 'Known audiences',
        hint: 'Customers whose order landed in the hub (store_shoppers).',
        phones: () => `SELECT DISTINCT ${normSql('phone')} AS phone FROM store_shoppers`
    },
    website_orders: {
        label: 'Website checkout orders',
        group: 'Known audiences',
        hint: 'Phones whose orders the support cache synced from Shopify.',
        phones: () => `SELECT DISTINCT ${normSql('customer_phone')} AS phone FROM support_order_cache`
    },

    // ── Current roster hygiene ──
    granted: {
        label: 'Everyone currently allowed',
        group: 'Current roster',
        hint: 'All rows in the access list, live and expired.',
        phones: () => `SELECT ${normSql('phone')} AS phone FROM support_whitelist`
    },
    ungranted_known: {
        label: 'Known customers without access',
        group: 'Current roster',
        hint: 'The gap list: real customers who cannot open the Help tab.',
        phones: () => KNOWN_PHONES_CTE + `SELECT k.phone FROM known k
                        LEFT JOIN support_whitelist w ON w.phone = k.phone WHERE w.phone IS NULL`
    },
    granted_expired: {
        label: 'Expired grants',
        group: 'Current roster',
        hint: 'Listed but past their access expiry date.',
        requiresExtended: true,
        phones: () => `SELECT ${normSql('phone')} AS phone FROM support_whitelist
                        WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`
    },
    granted_dormant: {
        label: 'Dormant grants',
        group: 'Current roster',
        hint: 'Allowed customers with no order or ticket since the dormant window.',
        requiresExtended: false,
        phones: (ctx) => `SELECT ${normSql('w.phone')} AS phone FROM support_whitelist w
                        LEFT JOIN (${LAST_SEEN_SQL}) s ON s.phone = w.phone
                        WHERE s.last_at IS NULL OR s.last_at < CURRENT_TIMESTAMP - make_interval(days => ${ctx.dormantDays})`
    },
    granted_view_only: {
        label: 'Read-only grants',
        group: 'Current roster',
        hint: 'Listed with access level "view" — they can look, not raise tickets.',
        requiresExtended: true,
        phones: () => `SELECT ${normSql('phone')} AS phone FROM support_whitelist WHERE access_level = 'view'`
    },
    granted_full: {
        label: 'Full-access grants',
        group: 'Current roster',
        hint: 'Listed with access level "full".',
        requiresExtended: true,
        phones: () => `SELECT ${normSql('phone')} AS phone FROM support_whitelist WHERE access_level = 'full'`
    },
    granted_invalid: {
        label: 'Invalid or unknown numbers',
        group: 'Current roster',
        hint: 'Listed numbers that are not valid Indian mobiles or match no customer.',
        phones: () => `SELECT ${normSql('w.phone')} AS phone FROM support_whitelist w
                        LEFT JOIN (${KNOWN_PHONES_SQL}) k ON k.phone = ${normSql('w.phone')}
                        WHERE ${normSql('w.phone')} !~ '${VALID_RE}' OR k.phone IS NULL`
    }
};

// The known-customer universe, shared by the audience + hygiene segments.
const KNOWN_PHONES_SQL = `
    SELECT DISTINCT ${normSql('t.customer_phone')} AS phone FROM support_tickets t
      UNION
    SELECT DISTINCT ${normSql('c.customer_phone')} FROM support_order_cache c
      UNION
    SELECT DISTINCT ${normSql('s.phone')} FROM store_shoppers s`;
const KNOWN_PHONES_CTE = `WITH known AS (${KNOWN_PHONES_SQL}) `;

// Most recent signal (ticket or order) per phone, for dormancy checks.
const LAST_SEEN_SQL = `
    SELECT phone, MAX(at) AS last_at FROM (
        SELECT ${normSql('customer_phone')} AS phone, created_at AS at FROM support_tickets
          UNION ALL
        SELECT ${normSql('customer_phone')}, placed_at FROM support_order_cache
    ) x WHERE x.phone ~ '${VALID_RE}' GROUP BY phone`;

const SEGMENT_IDS = Object.keys(SEGMENTS);

function segmentDef(id) {
    return SEGMENTS[id] || null;
}

// Phones matched by a segment, normalized and validated. Used by both the
// preview counts and the bulk-grant path, and by sync-to-segment.
async function segmentPhones(id, ctx) {
    const def = segmentDef(id);
    if (!def) throw new Error('Unknown segment: ' + id);
    if (def.requiresExtended && !(await hasExtendedColumns())) {
        throw new Error('This segment needs the access expiry/level columns (see the Access tab notice).');
    }
    const sql = def.phones(ctx || await segmentCtx());
    const rows = await dbAdapter.query(`SELECT DISTINCT phone FROM (${sql}) seg WHERE phone ~ '${VALID_RE}'`);
    return rows.map(r => String(r.phone));
}

// ---------- summary ----------
// Display-only card counts, so they are cached for 2 minutes instead of
// recomputed per Access-tab load: the Nov 23 log showed the full-table regex
// passes costing 900ms–23s each, eight fired at once, pinning the 10-slot
// pool and timing out unrelated queries. getOrLoad also single-flights, so
// concurrent loads share one recompute; every mutation path below drops the
// entry so the tab stays honest right after a grant/revoke/cleanup.
const STATS_CACHE_KEY = 'access:segmentCounts';
const STATS_TTL_MS = 120 * 1000;
const STATS_CONCURRENCY = 2;

function invalidateStatsCache() {
    caches.queries.delete(STATS_CACHE_KEY);
}

// Run query thunks with at most `limit` pool connections checked out at once.
async function runLimited(thunks, limit) {
    const out = new Array(thunks.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
        while (next < thunks.length) {
            const i = next++;
            out[i] = await thunks[i]();
        }
    });
    await Promise.all(workers);
    return out;
}

async function segmentCounts(force) {
    return caches.queries.getOrLoad(STATS_CACHE_KEY, computeSegmentCounts, STATS_TTL_MS, { refresh: Boolean(force) });
}

// One query per source table instead of one per segment: the Access tab renders
// ~30 cards and still boots in a couple of round trips.
async function computeSegmentCounts() {
    const out = {};
    const ctx = await segmentCtx();
    const jobs = [
        // Distinct customers per ticket-shaped segment, in one pass.
        () => dbAdapter.query(`
            SELECT
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE ${TICKET_LIVE}) AS active_tickets,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE status = 'open') AS open_tickets,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE status = 'awaiting') AS awaiting_customer,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE status = 'follow_up') AS follow_up,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE ${TICKET_LIVE} AND priority = 'high') AS high_priority,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE ${TICKET_LIVE} AND team = 'escalation') AS escalated,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE ${TICKET_LIVE} AND (reason || '/' || sub) IN (${REQUEST_KEY_LIST})) AS approval_queue,
                COUNT(DISTINCT ${normSql('customer_phone')}) AS any_ticket_history,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS ticketed_30d
            FROM support_tickets`),
        // Ticket history grouped, for the "nothing live" segment.
        () => dbAdapter.query(`
            SELECT COUNT(*) FILTER (WHERE live_cnt = 0) AS closed_only FROM (
                SELECT ${normSql('customer_phone')} AS phone,
                       COUNT(*) FILTER (WHERE ${TICKET_LIVE}) AS live_cnt
                FROM support_tickets GROUP BY 1) t
            WHERE t.phone ~ '${VALID_RE}'`),
        // Distinct customers per order-stage segment.
        () => dbAdapter.query(`
            SELECT
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE stage NOT IN ('delivered','cancelled','rto')) AS live_orders,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE stage = 'unshipped') AS unshipped,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE stage = 'unshipped' AND UPPER(COALESCE(payment,'')) LIKE '%COD%') AS cod_unshipped,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE stage IN ('shipped','out_for_delivery')) AS in_transit,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE stage = 'rto') AS rto,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE stage IN ('return','exchange')) AS return_exchange,
                COUNT(DISTINCT ${normSql('customer_phone')}) AS website_orders,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE placed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS ordered_30d,
                COUNT(DISTINCT ${normSql('customer_phone')}) FILTER (WHERE placed_at >= CURRENT_TIMESTAMP - INTERVAL '90 days') AS ordered_90d
            FROM support_order_cache`),
        // Order counts grouped per customer, for the value segments.
        () => dbAdapter.query(`
            SELECT COUNT(*) FILTER (WHERE n >= 2) AS repeat_buyers,
                   COUNT(*) FILTER (WHERE mx >= ${ctx.highValue}) AS high_value,
                   COUNT(*) FILTER (WHERE done) AS delivered_only
            FROM (
                SELECT ${normSql('customer_phone')} AS phone,
                       COUNT(*) AS n,
                       MAX(COALESCE(total, 0)) AS mx,
                       BOOL_AND(stage IN ('delivered','cancelled','rto')) AS done
                FROM support_order_cache GROUP BY 1) o
            WHERE o.phone ~ '${VALID_RE}'`),
        () => dbAdapter.query(`SELECT COUNT(DISTINCT ${normSql('phone')}) AS shoppers_hub FROM store_shoppers
                          WHERE ${normSql('phone')} ~ '${VALID_RE}'`),
        // Roster hygiene: listed but not a number we can ever match to someone.
        () => dbAdapter.query(`SELECT COUNT(*)::int AS granted_invalid FROM support_whitelist w
            LEFT JOIN (${KNOWN_PHONES_SQL}) k ON k.phone = ${normSql('w.phone')}
            WHERE ${normSql('w.phone')} !~ '${VALID_RE}' OR k.phone IS NULL`),
        // The universe union is the expensive one; counted on its own so the
        // others can run without holding a long read transaction open. The
        // gap list rides the same scan, so the "without access" card can never
        // disagree with the segment it links to.
        () => dbAdapter.query(`SELECT COUNT(*) AS all_known,
                                COUNT(*) FILTER (WHERE w.phone IS NULL) AS ungranted_known
                         FROM (${KNOWN_PHONES_SQL}) k
                         LEFT JOIN support_whitelist w ON w.phone = k.phone
                         WHERE k.phone ~ '${VALID_RE}'`),
        () => dbAdapter.query(`
            SELECT COUNT(*) AS granted_dormant FROM support_whitelist w
            LEFT JOIN (${LAST_SEEN_SQL}) s ON s.phone = ${normSql('w.phone')}
            WHERE s.last_at IS NULL OR s.last_at < CURRENT_TIMESTAMP - make_interval(days => ${ctx.dormantDays})`)
    ];

    const results = await runLimited(
        jobs.map(run => () => run().catch(e => ({ __error: e.message }))),
        STATS_CONCURRENCY
    );
    for (const res of results) {
        if (res && !res.__error) Object.assign(out, res[0] || {});
    }

    const grantedRes = await dbAdapter.query('SELECT COUNT(*)::int AS granted FROM support_whitelist');
    const granted = Number(grantedRes[0] && grantedRes[0].granted) || 0;
    out.granted = granted;

    // Roster-side counts need the extended columns; they stay absent when the
    // schema is not migrated, so the UI can say "unavailable" rather than 0.
    if (await hasExtendedColumns()) {
        try {
            const ext = await dbAdapter.query(`
                SELECT
                    COUNT(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP)::int AS granted_expired,
                    COUNT(*) FILTER (WHERE access_level = 'view')::int AS granted_view_only,
                    COUNT(*) FILTER (WHERE access_level IS NULL OR access_level <> 'view')::int AS granted_full
                FROM support_whitelist`);
            Object.assign(out, ext[0] || {});
        } catch (e) { /* counts for those cards stay absent */ }
    }
    return out;
}

// ---------- whitelist rows ----------
// The roster the Access tab renders: every grant enriched with who they are,
// what is live for them and whether the row is still doing anything.
async function listRoster(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), MAX_PAGE);
    const ext = await hasExtendedColumns();
    const sel = ext
        ? 'w.phone, w.note, w.added_by, w.created_at, w.access_level, w.expires_at, w.source'
        : 'w.phone, w.note, w.added_by, w.created_at';
    const params = [];
    const days = Number(opts.dormantDays) > 0 ? Number(opts.dormantDays) : 0;
    // Dormancy is a filter on the joined last-activity, not a HAVING: this
    // query is a flat join, so the clause belongs in WHERE.
    const dormantWhere = days
        ? `AND (s.last_at IS NULL OR s.last_at < CURRENT_TIMESTAMP - make_interval(days => ${days}))`
        : '';

    const rows = await dbAdapter.query(`
        SELECT ${sel},
               COALESCE(tk.name, sh.name) AS name,
               COALESCE(tk.open_cnt, 0)::int  AS open_tickets,
               COALESCE(tk.total_cnt, 0)::int AS total_tickets,
               COALESCE(oc.order_cnt, 0)::int AS orders,
               COALESCE(oc.live_cnt, 0)::int  AS live_orders,
               s.last_at AS last_activity
        FROM support_whitelist w
        LEFT JOIN (${LAST_SEEN_SQL}) s ON s.phone = ${normSql('w.phone')}
        LEFT JOIN (
            SELECT ${normSql('customer_phone')} AS phone,
                   COUNT(*) FILTER (WHERE ${TICKET_LIVE}) AS open_cnt,
                   COUNT(*) AS total_cnt,
                   MAX(customer_name) AS name
            FROM support_tickets GROUP BY 1
        ) tk ON tk.phone = ${normSql('w.phone')}
        LEFT JOIN (
            SELECT ${normSql('customer_phone')} AS phone,
                   COUNT(*) AS order_cnt,
                   COUNT(*) FILTER (WHERE stage NOT IN ('delivered','cancelled','rto')) AS live_cnt
            FROM support_order_cache GROUP BY 1
        ) oc ON oc.phone = ${normSql('w.phone')}
        LEFT JOIN (
            SELECT DISTINCT ON (${normSql('phone')}) ${normSql('phone')} AS phone, name
            FROM store_shoppers WHERE NULLIF(TRIM(COALESCE(name, '')), '') IS NOT NULL
            ORDER BY 1, created_at DESC
        ) sh ON sh.phone = ${normSql('w.phone')}
        WHERE 1 = 1 ${dormantWhere}
        ORDER BY s.last_at DESC NULLS LAST, w.created_at DESC NULLS LAST
        LIMIT ${limit}`, params);

    return rows.map(r => {
        const phone = Support.normalizePhone(r.phone);
        const expiresAt = r.expires_at ? new Date(r.expires_at).getTime() : null;
        const expired = Boolean(expiresAt && expiresAt < Date.now());
        return {
            phone,
            name: r.name || null,
            note: r.note || null,
            addedBy: r.added_by || null,
            addedAt: r.created_at || null,
            level: r.access_level || 'full',
            source: r.source || 'manual',
            expiresAt,
            openTickets: Number(r.open_tickets) || 0,
            totalTickets: Number(r.total_tickets) || 0,
            orders: Number(r.orders) || 0,
            liveOrders: Number(r.live_orders) || 0,
            lastActivity: r.last_activity || null,
            flags: [
                expired ? 'expired' : null,
                phone.match(VALID_RE) ? null : 'invalid',
                !r.orders && !r.total_tickets ? 'unknown' : null,
                r.level === 'view' ? 'view-only' : null
            ].filter(Boolean)
        };
    });
}

// ---------- bulk writes ----------
function normalizeList(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(/[\s,;]+/);
    const seen = new Set();
    const valid = [];
    const invalid = [];
    for (const raw of list) {
        const phone = Support.normalizePhone(raw);
        if (!phone || !/^\d+$/.test(phone) || phone.length < 10) { if (raw) invalid.push(String(raw)); continue; }
        if (seen.has(phone)) continue;
        seen.add(phone);
        if (!phone.match(VALID_RE)) { invalid.push(phone); continue; }
        valid.push(phone);
    }
    return { valid, invalid: [...new Set(invalid)] };
}

// Phones we have never seen anywhere. Only consulted when verifyBeforeGrant
// is on, so the default path pays nothing for it.
async function unknownPhones(phones) {
    const placeholders = phones.map(() => '?').join(',');
    const rows = await dbAdapter.query(`SELECT DISTINCT phone FROM (${KNOWN_PHONES_SQL}) k WHERE phone IN (${placeholders})`, phones);
    const known = new Set(rows.map(r => String(r.phone)));
    return phones.filter(p => !known.has(p));
}

async function bulkGrant(phones, opts = {}) {
    const list = (Array.isArray(phones) ? phones : []).map(p => Support.normalizePhone(p)).filter(Boolean);
    if (!list.length) return { requested: 0, granted: 0, updated: 0, phones: [], invalid: [], skipped: [] };
    if (list.length > MAX_BULK) throw new Error(`Bulk grant is capped at ${MAX_BULK} numbers per call`);

    const policy = opts.policy || await getPolicy();
    const ext = await hasExtendedColumns();
    const level = clampEnum(opts.level || policy.defaultLevel, LEVELS, 'full');
    const days = Number.isFinite(Number(opts.days)) ? Math.max(0, Number(opts.days)) : Number(policy.defaultDays) || 0;
    const source = String(opts.source || 'manual').slice(0, 40);

    const { valid, invalid } = normalizeList(list);
    const skipped = [];
    let targets = valid;

    if (policy.verifyBeforeGrant && targets.length) {
        const unknown = await unknownPhones(targets);
        const unknownSet = new Set(unknown);
        unknown.forEach(p => skipped.push({ phone: p, reason: 'not a known customer' }));
        targets = targets.filter(p => !unknownSet.has(p));
    }

    if (!targets.length) {
        return { requested: list.length, granted: 0, updated: 0, phones: [], invalid, skipped };
    }

    // Existing rows are counted as updates, not new grants, so the toast can be
    // honest about how much access actually changed.
    const chunks = [];
    for (let i = 0; i < targets.length; i += 500) chunks.push(targets.slice(i, i + 500));

    let granted = 0;
    let updated = 0;
    for (const chunk of chunks) {
        const ph = chunk.map(() => '?').join(',');
        const existing = await dbAdapter.query(`SELECT phone FROM support_whitelist WHERE phone IN (${ph})`, chunk);
        const existingSet = new Set(existing.map(r => Support.normalizePhone(r.phone)));

        const valueSql = ext
            ? `INSERT INTO support_whitelist (phone, added_by, note, source, access_level, expires_at)
               VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}
               ON CONFLICT (phone) DO UPDATE SET
                 added_by = EXCLUDED.added_by,
                 note = COALESCE(EXCLUDED.note, support_whitelist.note),
                 source = EXCLUDED.source,
                 access_level = EXCLUDED.access_level,
                 expires_at = EXCLUDED.expires_at`
            : `INSERT INTO support_whitelist (phone, added_by, note)
               VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
               ON CONFLICT (phone) DO UPDATE SET
                 added_by = EXCLUDED.added_by,
                 note = COALESCE(EXCLUDED.note, support_whitelist.note)`;

        const params = [];
        for (const phone of chunk) {
            if (ext) {
                params.push(phone, opts.addedBy || 'desk', opts.note || null, source, level,
                    days ? new Date(Date.now() + days * 86400000) : null);
            } else {
                params.push(phone, opts.addedBy || 'desk', opts.note || null);
            }
        }
        await dbAdapter.run(valueSql, params);
        granted += chunk.filter(p => !existingSet.has(p)).length;
        updated += chunk.filter(p => existingSet.has(p)).length;
    }

    invalidateSnapshot();
    invalidateStatsCache();
    return { requested: list.length, granted, updated, phones: targets, invalid, skipped, level, days, source, schemaLimited: !ext };
}

async function bulkRevoke(phones) {
    const list = (Array.isArray(phones) ? phones : []).map(p => Support.normalizePhone(p)).filter(Boolean);
    if (!list.length) return { revoked: 0 };
    if (list.length > MAX_BULK) throw new Error(`Bulk revoke is capped at ${MAX_BULK} numbers per call`);
    let revoked = 0;
    for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        const ph = chunk.map(() => '?').join(',');
        const res = await dbAdapter.run(`DELETE FROM support_whitelist WHERE phone IN (${ph})`, chunk);
        revoked += Number(res.changes) || 0;
        // Access revoked: their cached orders have no consumer left.
        await dbAdapter.run(
            `DELETE FROM support_order_cache WHERE customer_phone IN (${ph}) OR ${normSql('customer_phone')} IN (${ph})`,
            [...chunk, ...chunk]
        );
    }
    invalidateSnapshot();
    invalidateStatsCache();
    return { revoked };
}

// Re-point the whole list at one segment: grants everything in it and revokes
// everyone outside it. Used by "allow only these customers".
async function syncListToSegment(id, opts = {}) {
    const target = new Set(await segmentPhones(id));
    const current = await dbAdapter.query('SELECT phone FROM support_whitelist');
    const currentSet = new Set(current.map(r => Support.normalizePhone(r.phone)));
    const toGrant = [...target].filter(p => !currentSet.has(p));
    const toRevoke = [...currentSet].filter(p => !target.has(p));
    const added = toGrant.length ? await bulkGrant(toGrant, { ...opts, source: 'segment-sync', note: opts.note || `Segment: ${id}` }) : null;
    const removed = toRevoke.length ? await bulkRevoke(toRevoke) : { revoked: 0 };
    return { granted: added ? added.granted + added.updated : 0, revoked: removed.revoked, target: target.size };
}

// Re-apply one rule (level or expiry) across a selection without touching the
// rest of the row.
async function updateGrants(phones, patch = {}) {
    const list = (Array.isArray(phones) ? phones : []).map(p => Support.normalizePhone(p)).filter(Boolean);
    if (!list.length) return { updated: 0 };
    if (!(await hasExtendedColumns())) throw new Error('Access level and expiry need the whitelist columns (see the notice in this tab).');
    const sets = [];
    const params = [];
    if (patch.level) { sets.push('access_level = ?'); params.push(clampEnum(patch.level, LEVELS, 'full')); }
    if (patch.days !== undefined) {
        const d = Number(patch.days);
        sets.push('expires_at = ?');
        params.push(Number.isFinite(d) && d > 0 ? new Date(Date.now() + d * 86400000) : null);
    }
    if (patch.note !== undefined) { sets.push('note = ?'); params.push(patch.note || null); }
    if (!sets.length) return { updated: 0 };
    let changed = 0;
    for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        const res = await dbAdapter.run(
            `UPDATE support_whitelist SET ${sets.join(', ')} WHERE phone IN (${chunk.map(() => '?').join(',')})`,
            [...params, ...chunk]
        );
        changed += Number(res.changes) || 0;
    }
    invalidateSnapshot();
    invalidateStatsCache();
    return { updated: changed };
}

// Targeted maintenance actions exposed as buttons in the tab.
async function cleanup(kind, opts = {}) {
    const ext = await hasExtendedColumns();
    if (kind === 'expired') {
        if (!ext) throw new Error('No expiry column to clean against yet.');
        const res = await dbAdapter.run('DELETE FROM support_whitelist WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP');
        invalidateSnapshot();
        invalidateStatsCache();
        return { kind, removed: Number(res.changes) || 0 };
    }
    if (kind === 'invalid') {
        const rows = await dbAdapter.query(`SELECT phone FROM support_whitelist`);
        const bad = rows.map(r => String(r.phone)).filter(p => !Support.normalizePhone(p).match(VALID_RE));
        if (!bad.length) return { kind, removed: 0 };
        const ph = bad.map(() => '?').join(',');
        const res = await dbAdapter.run(`DELETE FROM support_whitelist WHERE phone IN (${ph})`, bad);
        invalidateSnapshot();
        invalidateStatsCache();
        return { kind, removed: Number(res.changes) || 0 };
    }
    if (kind === 'duplicates') {
        // phone is UNIQUE, so this only ever cleans up legacy rows saved with
        // different spellings of the same number (9876543210 vs 919876543210).
        const rows = await dbAdapter.query('SELECT id, phone FROM support_whitelist ORDER BY created_at ASC');
        const first = new Map();
        const dupIds = [];
        for (const r of rows) {
            const p = Support.normalizePhone(r.phone);
            if (first.has(p)) dupIds.push(r.id); else first.set(p, r.id);
        }
        if (!dupIds.length) return { kind, removed: 0 };
        const res = await dbAdapter.run(
            `DELETE FROM support_whitelist WHERE id IN (${dupIds.map(() => '?').join(',')})`, dupIds);
        invalidateSnapshot();
        invalidateStatsCache();
        return { kind, removed: Number(res.changes) || 0 };
    }
    if (kind === 'dormant') {
        const days = Number(opts.days) > 0 ? Number(opts.days) : Number((await getPolicy()).dormantRevokeDays) || 90;
        const rows = await dbAdapter.query(`
            SELECT w.phone FROM support_whitelist w
            LEFT JOIN (${LAST_SEEN_SQL}) s ON s.phone = ${normSql('w.phone')}
            WHERE s.last_at IS NULL OR s.last_at < CURRENT_TIMESTAMP - make_interval(days => ?)`, [days]);
        const phones = rows.map(r => r.phone);
        if (!phones.length) return { kind, removed: 0, days };
        const res = await bulkRevoke(phones);
        return { kind, removed: res.revoked, days };
    }
    if (kind === 'unknown') {
        const rows = await dbAdapter.query(`
            SELECT w.phone FROM support_whitelist w
            LEFT JOIN (${KNOWN_PHONES_SQL}) k ON k.phone = ${normSql('w.phone')}
            WHERE k.phone IS NULL`);
        const phones = rows.map(r => r.phone);
        if (!phones.length) return { kind, removed: 0 };
        const res = await bulkRevoke(phones);
        return { kind, removed: res.revoked };
    }
    throw new Error('Unknown cleanup action');
}

// Paste import: any blob of numbers (CSV column, WhatsApp export, spreadsheet
// copy) inlined into one textarea. Normalizes, dedupes and reports both sides.
function parseImport(text) {
    const raw = String(text || '');
    const tokens = raw.split(/[^0-9+x-]+/).map(t => t.trim()).filter(t => /\d{10}/.test(t));
    const { valid, invalid } = normalizeList(tokens);
    return { valid, invalid, seen: tokens.length };
}

// ---------- auto-grant ----------
// Fire-and-forget from ticket creation: the storefront must never fail because
// a policy write to the whitelist hiccuped.
async function maybeAutoGrant(phone, channel) {
    try {
        const policy = await getPolicy();
        if (!policy.autoGrantNewTickets) return false;
        if (policy.autoGrantChannel !== 'any' && channel && channel !== policy.autoGrantChannel) return false;
        const p = Support.normalizePhone(phone);
        if (!p || !p.match(VALID_RE)) return false;
        if (await isListed(p)) return false;
        await bulkGrant([p], { addedBy: 'auto-ticket', source: 'auto-ticket', note: 'Auto-granted on ticket', policy });
        return true;
    } catch (e) {
        console.warn('[SupportAccess] auto-grant skipped:', e.message);
        return false;
    }
}

// ---------- overview ----------
// Everything the Access tab needs for first paint in one response.
async function overview() {
    const [policy, counts, ext] = await Promise.all([getPolicy(), segmentCounts(), hasExtendedColumns()]);
    const segments = SEGMENT_IDS
        .filter(id => !SEGMENTS[id].requiresExtended || ext)
        .map(id => ({
            id,
            label: SEGMENTS[id].label,
            group: SEGMENTS[id].group,
            hint: SEGMENTS[id].hint,
            count: Number(counts[id]) || 0,
            unavailable: Boolean(SEGMENTS[id].requiresExtended && !ext)
        }));
    return {
        policy,
        counts,
        segments,
        schemaLimited: !ext,
        modes: MODES,
        levels: LEVELS
    };
}

// Candidate browser: rows for one segment with their roster state, so the same
// list can drive both "grant these" and "revoke these".
async function candidates(segmentId, opts = {}) {
    const def = segmentDef(segmentId);
    if (!def) throw new Error('Unknown segment: ' + segmentId);
    const ext = await hasExtendedColumns();
    if (def.requiresExtended && !ext) throw new Error('This segment needs the expiry/level columns.');

    const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), MAX_PAGE);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const digits = String(opts.q || '').replace(/\D/g, '');
    const rosterFilter = ['ungranted', 'granted'].includes(opts.roster) ? opts.roster : null;
    const ctx = await segmentCtx();

    const sql = `
        WITH seg AS (${def.phones(ctx)}),
        seen AS (${LAST_SEEN_SQL}),
        tk AS (
            SELECT ${normSql('customer_phone')} AS phone,
                   COUNT(*) FILTER (WHERE ${TICKET_LIVE})::int AS open_cnt,
                   COUNT(*)::int AS total_cnt,
                   MAX(customer_name) AS name
            FROM support_tickets GROUP BY 1
        ),
        oc AS (
            SELECT ${normSql('customer_phone')} AS phone, COUNT(*)::int AS orders,
                   COUNT(*) FILTER (WHERE stage NOT IN ('delivered','cancelled','rto'))::int AS live_orders,
                   MAX(total)::float AS max_total
            FROM support_order_cache GROUP BY 1
        ),
        sh AS (
            SELECT DISTINCT ON (${normSql('phone')}) ${normSql('phone')} AS phone, name
            FROM store_shoppers WHERE NULLIF(TRIM(COALESCE(name, '')), '') IS NOT NULL
            ORDER BY 1, created_at DESC
        )
        SELECT s.phone,
               COALESCE(tk.name, sh.name) AS name,
               COALESCE(tk.open_cnt, 0) AS open_tickets,
               COALESCE(tk.total_cnt, 0) AS total_tickets,
               COALESCE(oc.orders, 0) AS orders,
               COALESCE(oc.live_orders, 0) AS live_orders,
               COALESCE(oc.max_total, 0) AS max_total,
               seen.last_at AS last_activity,
               (w.phone IS NOT NULL) AS granted,
               ${ext
                    ? "COALESCE(w.access_level, 'full') AS level, w.expires_at AS expires_at, w.source AS grant_source"
                    : "'full' AS level, NULL AS expires_at, NULL AS grant_source"}
        FROM seg s
        LEFT JOIN support_whitelist w ON w.phone = s.phone
        LEFT JOIN seen ON seen.phone = s.phone
        LEFT JOIN tk ON tk.phone = s.phone
        LEFT JOIN oc ON oc.phone = s.phone
        LEFT JOIN sh ON sh.phone = s.phone
        WHERE s.phone ~ '${VALID_RE}'
        ${digits ? `AND s.phone LIKE '%' || ? || '%'` : ''}
        ${rosterFilter === 'granted' ? 'AND w.phone IS NOT NULL' : ''}
        ${rosterFilter === 'ungranted' ? 'AND w.phone IS NULL' : ''}
        ORDER BY seen.last_at DESC NULLS LAST, s.phone
        LIMIT ${limit} OFFSET ${offset}`;

    const rows = await dbAdapter.query(sql, digits ? [digits] : []);
    return {
        segment: segmentId,
        label: def.label,
        limit,
        offset,
        rows: rows.map(r => ({
            phone: r.phone,
            name: r.name || null,
            openTickets: Number(r.open_tickets) || 0,
            totalTickets: Number(r.total_tickets) || 0,
            orders: Number(r.orders) || 0,
            liveOrders: Number(r.live_orders) || 0,
            maxTotal: Number(r.max_total) || 0,
            lastActivity: r.last_activity || null,
            granted: Boolean(r.granted),
            level: r.level || 'full',
            expiresAt: r.expires_at || null,
            grantSource: r.grant_source || null
        }))
    };
}

module.exports = {
    ACCESS_SETTING_KEY, POLICY_DEFAULTS, MODES, LEVELS, VALID_RE, MAX_BULK,
    getPolicy, savePolicy,
    getSnapshot, invalidateSnapshot, checkAccess, isListed, isWhitelistedCached,
    SEGMENT_IDS, segmentDef, segmentPhones, segmentCounts, invalidateStatsCache,
    listRoster, candidates, overview,
    bulkGrant, bulkRevoke, syncListToSegment, updateGrants, cleanup, parseImport,
    maybeAutoGrant, normalizeList, hasExtendedColumns, normSql
};
