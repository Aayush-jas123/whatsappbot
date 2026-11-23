const zohoService = require('./zohoService');

// ============================================================
// ZOHO ITEM RESOLVER
// Shared by invoice sync, credit notes and exchange replacements
// so every document links to real Zoho items — that linkage is
// what makes Books adjust stock (deduct on invoice sent, return
// on credit note / replacement flows). An unlinked line still
// invoices correctly, so a miss is invisible unless it is logged.
// ============================================================

// Zoho catalog names are inconsistent ("( B ) - M" vs "(G)-M") —
// normalise whitespace so bundle components still link to stock.
const normName = (s) => String(s || '').replace(/\s+/g, '').toUpperCase();

// ------------------------------------------------------------
// SPELLING TOLERANCE
// The catalog is hand-maintained and the same product is entered
// three ways:
//   "VEST - 001 ( W ) - XL"   BASE ( COLOUR ) - SIZE   ← what we emit
//   "VEST 001 - S / Black"    BASE - SIZE / COLOUR
//   "VEST 001 - S  Black"     BASE - SIZE  COLOUR
// Comparing only the emitted form left every black vest — the
// second colourway of "VEST - 001 ( Pack of 2 )" — without an
// item, so Zoho billed those sales and never deducted the stock.
// ------------------------------------------------------------

// Single-letter colourways used across the catalog ("( B )", "( W )", "( G )")
const COLOR_LETTERS = { B: 'BLACK', W: 'WHITE', G: 'GREY' };
// Only these tails count as a colour in the two non-parenthesised forms, so
// an ordinary name is never reinterpreted as BASE - SIZE / COLOUR.
const COLOR_WORDS = new Set([
    'BLACK', 'WHITE', 'GREY', 'NAVY', 'BLUE', 'GREEN', 'PINK', 'RED', 'MAROON',
    'BROWN', 'BEIGE', 'CREAM', 'IVORY', 'CHARCOAL', 'OLIVE', 'DENIM', 'SAGE',
    'MINT', 'LILAC', 'MUSTARD', 'STONE', 'OFFWHITE', 'ACIDWASH', 'DARKWASH', 'LIGHTWASH'
]);

const canonColor = (c) => {
    const t = normName(c).replace(/-/g, '');
    if (t === 'GRAY') return 'GREY';
    if (COLOR_WORDS.has(t)) return t;
    return COLOR_LETTERS[t] || t;
};
const isColorWord = (c) => COLOR_WORDS.has(canonColor(c));

/** Split any of the three catalog spellings into base / colour / size. */
function parseItemName(name) {
    const raw = String(name || '').trim();
    let m = raw.match(/^(.*?)\s*\(\s*([^)]*?)\s*\)\s*(?:-\s*(\S+?)\s*)?$/);
    if (m) return { base: m[1].trim(), color: canonColor(m[2]), size: (m[3] || '').trim().toUpperCase() };
    m = raw.match(/^(.*?)\s+-\s+(\S+)\s*\/\s*(.+?)\s*$/);
    if (m) return { base: m[1].trim(), color: canonColor(m[3]), size: m[2].trim().toUpperCase() };
    m = raw.match(/^(.*?)\s+-\s+(\S+)\s+(.+?)\s*$/);
    if (m && isColorWord(m[3])) return { base: m[1].trim(), color: canonColor(m[3]), size: m[2].trim().toUpperCase() };
    return { base: raw, color: '', size: '' };
}

// Style family ignores dashes and spaces: "VEST - 001" ≡ "VEST 001".
const famKeyOf = (base) => normName(base).replace(/-/g, '');

/** Comparison key: same style + colourway + size, whichever spelling. */
function nameKey(name) {
    const { base, color, size } = parseItemName(name);
    return `${famKeyOf(base)}|${color}|${size}`;
}

// Charge lines are never catalog items — searching for them costs two API
// calls per invoice for nothing.
const CHARGE_LINE_RX = /^(shipping|rounding adjustment|cod\b|cash on delivery)/i;
const isChargeLineName = (name) => CHARGE_LINE_RX.test(String(name || '').trim());

/**
 * The style token to search the catalog with. Derived from the parsed base so
 * "VEST 001 ( BLACK ) - M" and "VEST 001 - M / Black" search identically.
 */
function stylePrefix(key) {
    return parseItemName(key).base.trim();
}

/**
 * Best item for a name among candidates. Whitespace-exact matches win over
 * spelling-tolerant ones. Several items on one key means the catalog holds a
 * duplicate: take the oldest (lowest item_id — every duplicate observed is a
 * later re-entry of the same style) and say so, because silently picking any
 * of them moves stock onto an arbitrary row.
 */
function pickMatchingItem(items, key) {
    const pool = (items || []).filter(Boolean);
    if (!pool.length || !key) return null;
    const want = normName(key);
    const exact = pool.filter(i => normName(i.name) === want);
    const tolerant = pool.filter(i => nameKey(i.name) === nameKey(key));
    const hits = exact.length ? exact : tolerant;
    if (!hits.length) return null;
    if (hits.length > 1) {
        const byAge = (a, b) => String(a.item_id).length - String(b.item_id).length
            || String(a.item_id).localeCompare(String(b.item_id));
        const sorted = [...hits].sort(byAge);
        console.warn(`⚠️ Zoho catalog: ${sorted.length} items match "${key}" — using "${sorted[0].name}", ignoring ${sorted.slice(1).map(h => `"${h.name}"`).join(', ')}`);
        return sorted[0];
    }
    return hits[0];
}

/**
 * A SKU hit is only trustworthy when it points at the style the NAME claims.
 * Shopify SKUs in this store are hand-typed ("0", "5", "7") and several Zoho
 * items carry those same values for OTHER colorways, so an unguarded SKU
 * lookup billed grey raglans against the black item's stock.
 */
function skuHitAgrees(name, item) {
    if (!item) return false;
    const a = parseItemName(name);
    const b = parseItemName(item.name || '');
    if (famKeyOf(a.base) !== famKeyOf(b.base)) return false;
    if (a.size && b.size && a.size !== b.size) return false;
    if (a.color && b.color && a.color !== b.color) return false;
    return true;
}

/**
 * Create a resolver with a per-run cache.
 * resolve(name) → Zoho item object ({ item_id, name, ... }) or null.
 * resolveLine({ name, sku }) → { item, via, conflict } — what document builders
 * should use: NAME is authoritative (exact → spelling-tolerant), the SKU is a
 * guarded fallback. Lookup order for a name: exact spell → style-prefix search
 * + whitespace-insensitive match → same search widened to the first word.
 */
function createItemResolver() {
    const itemCache = new Map();
    const inflight = new Map();                // key -> pending lookup promise
    const ITEM_CACHE_TTL = 10 * 60 * 1000;  // 10 min — items rarely change
    const ITEM_CACHE_MAX = 300;              // hard cap: 300 unique items

    async function searchCandidates(term) {
        if (!term) return [];
        return await zohoService.searchItem({ name_contains: term, per_page: 200 }) || [];
    }

    async function lookupName(name) {
        try {
            const exact = await zohoService.getItemByName(name);
            if (exact) return exact;
            // Fuzzy fallback: search the style prefix, then compare tolerantly
            // (Zoho stores some variants without spaces, e.g. "RAGLAN 001 (G)-M"
            // vs "RAGLAN 001 ( G ) - M", and some without the colour parentheses,
            // e.g. "VEST 001 - M / Black" vs "VEST 001 ( BLACK ) - M")
            const picked = pickMatchingItem(await searchCandidates(stylePrefix(name)), name);
            if (picked) return picked;
            // The prefix may simply be spelled differently in the catalog
            // ("VEST-001" searched against "VEST 001 …") — widen to the first
            // word before giving up.
            const firstWord = stylePrefix(name).split(/[\s/-]+/)[0];
            if (firstWord && firstWord !== stylePrefix(name)) {
                return pickMatchingItem(await searchCandidates(firstWord), name);
            }
            return null;
        } catch (e) {
            return null;   // leave unlinked
        }
    }

    async function lookupSku(sku) {
        try {
            const rows = await zohoService.searchItem({ sku });
            return rows[0] || null;
        } catch (e) {
            return null;
        }
    }

    /** Cached lookup — `cacheKey` namespaces name vs SKU searches. */
    function cached(cacheKey, fetch) {
        const hit = itemCache.get(cacheKey);
        if (hit && (Date.now() - hit.ts) < ITEM_CACHE_TTL) return Promise.resolve(hit.value);
        // Concurrent callers (bulk backfill workers) share one lookup instead
        // of each paying for the same catalog search.
        if (inflight.has(cacheKey)) return inflight.get(cacheKey);

        const promise = fetch().then(item => {
            // LRU-style: delete first so re-set moves to tail
            if (itemCache.has(cacheKey)) itemCache.delete(cacheKey);
            itemCache.set(cacheKey, { value: item, ts: Date.now() });

            // Evict oldest when over cap
            while (itemCache.size > ITEM_CACHE_MAX) {
                itemCache.delete(itemCache.keys().next().value);
            }
            return item;
        }).finally(() => inflight.delete(cacheKey));

        inflight.set(cacheKey, promise);
        return promise;
    }

    async function resolve(name) {
        if (!name) return null;
        return cached(`name:${name}`, () => lookupName(name));
    }

    async function resolveBySku(sku) {
        if (!sku) return null;
        return cached(`sku:${sku}`, () => lookupSku(sku));
    }

    /**
     * Resolve one document line. Charge lines (shipping, rounding, COD) carry
     * no stock, so they are answered without spending any API call.
     */
    async function resolveLine({ name, sku } = {}) {
        if (isChargeLineName(name)) return { item: null, via: 'charge-line' };
        const byName = await resolve(name);
        if (byName?.item_id) return { item: byName, via: 'name' };
        // Bundle components arrive with the name in the sku slot — searching it
        // twice would only cost another call.
        if (sku && normName(sku) !== normName(name)) {
            const bySku = await resolveBySku(sku);
            if (bySku?.item_id) {
                if (skuHitAgrees(name, bySku)) return { item: bySku, via: 'sku' };
                return { item: null, via: 'sku-conflict', conflict: bySku };
            }
        }
        return { item: null, via: 'miss' };
    }

    return { resolve, resolveBySku, resolveLine, normName };
}

module.exports = {
    createItemResolver,
    // matching rules, shared so live sync, backfills and the bundle wizard
    // all agree on what two catalog names mean
    normName,
    parseItemName,
    nameKey,
    famKeyOf,
    stylePrefix,
    pickMatchingItem,
    skuHitAgrees,
    isChargeLineName,
};
