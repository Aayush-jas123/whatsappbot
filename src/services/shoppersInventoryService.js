'use strict';

const { pool, dbAdapter } = require('../database/db');
const { extractItemSize } = require('../utils/orderItems');
const { indexCatalog, matchHubRow, normKey } = require('./shopifyInventorySync');

const SALE = 'sale';
const RESTOCK = 'sale_restock';
const RTO_RESTOCK = 'rto_restock';
const RETURN_RESTOCK = 'return_restock';
const EXCHANGE_RESTOCK = 'exchange_restock';
const EXCHANGE_SALE = 'exchange_sale';
const DEDUCTION_TYPES = new Set([SALE, EXCHANGE_SALE]);
const RESTOCK_TYPES = new Set([RESTOCK, RTO_RESTOCK, RETURN_RESTOCK, EXCHANGE_RESTOCK]);
const ORDER_LEDGER_REFERENCES = `(
    reference = $1
    OR left(reference, length('return:' || $1 || ':')) = 'return:' || $1 || ':'
    OR left(reference, length('refund:' || $1 || ':')) = 'refund:' || $1 || ':'
    OR left(reference, length('exchange:' || $1 || ':')) = 'exchange:' || $1 || ':'
)`;

function normalizeName(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeSize(value) {
    const size = String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
    if (['FREESIZE', 'ONESIZE', 'DEFAULTTITLE'].includes(size)) return 'FREE';
    return size;
}

function orderKeyOf(order) {
    const raw = order?.order_number || order?.name || order?.id;
    return raw == null ? '' : String(raw).trim().replace(/^#/, '');
}

function itemTitle(item) {
    return String(item?.title || item?.product_name || item?.name || '').trim();
}

function itemSize(item) {
    return extractItemSize(item) || '';
}

function itemQuantity(item) {
    const quantity = parseInt(item?.quantity ?? item?.qty, 10);
    return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}

function titleCandidates(item) {
    const title = itemTitle(item);
    if (!title) return [];
    const withoutSize = title.replace(
        /\s*-\s*(?:size\s*[:\-]?\s*)?(XXXS|XXS|XS|S|M|L|XL|2XL|XXL|3XL|XXXL|4XL|5XL|FREE SIZE|ONE SIZE)\s*$/i,
        ''
    ).trim();
    return [...new Set([title, withoutSize].filter(Boolean))];
}

function uniqueMatch(index, key) {
    const matches = index.get(key);
    return matches?.length === 1 ? matches[0] : null;
}

function buildManualIndex(rows) {
    const bySkuKey = new Map();
    const byNameSize = new Map();
    const add = (index, key, row) => {
        if (!key) return;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(row);
    };
    for (const row of rows || []) {
        add(bySkuKey, normKey(row.sku_key), row);
        add(byNameSize, `${normalizeName(row.product_name)}|${normalizeSize(row.size)}`, row);
    }
    return { bySkuKey, byNameSize };
}

function expandBundleItems(items, bundleRows) {
    const bundles = new Map();
    for (const row of bundleRows || []) {
        for (const key of [row.bundle_sku, normalizeName(row.bundle_sku)]) {
            if (!key) continue;
            if (!bundles.has(key)) bundles.set(key, []);
            bundles.get(key).push(row);
        }
    }
    if (!bundles.size) return items;

    const expanded = [];
    for (const item of items || []) {
        const components = bundles.get(item?.sku)
            || bundles.get(itemTitle(item))
            || bundles.get(normalizeName(itemTitle(item)));
        if (!components) {
            expanded.push(item);
            continue;
        }
        const quantity = itemQuantity(item);
        for (const component of components) {
            expanded.push({
                title: component.component_sku,
                sku: '',
                variant: item?.variant_title || item?.variant || item?.size || '',
                quantity: quantity * (parseInt(component.component_qty, 10) || 1),
            });
        }
    }
    return expanded;
}

function resolveDirectManual(item, manualIndex) {
    const sku = normKey(item?.sku);
    // Store SKUs are hand-entered and numeric values collide across products.
    if (sku && !/^\d+$/.test(sku)) {
        const hit = uniqueMatch(manualIndex.bySkuKey, sku);
        if (hit) return hit;
    }

    const size = normalizeSize(itemSize(item));
    if (!size) return null;
    for (const title of titleCandidates(item)) {
        const hit = uniqueMatch(manualIndex.byNameSize, `${normalizeName(title)}|${size}`);
        if (hit) return hit;
    }
    return null;
}

function buildCatalogResolver(catalog, manualRows, aliasRows) {
    const manualIndex = buildManualIndex(manualRows);
    const catalogIndex = indexCatalog(catalog);
    const byVariantId = new Map();
    const byProductId = new Map();
    const bySku = new Map();
    const byTitle = new Map();
    const variantToHub = new Map();

    const addVariantHub = (variantId, row) => {
        if (!variantId || !row) return;
        const key = String(variantId);
        if (!variantToHub.has(key)) variantToHub.set(key, []);
        variantToHub.get(key).push(row);
    };

    for (const product of catalog || []) {
        const titleKey = normalizeName(product.title);
        if (!byTitle.has(titleKey)) byTitle.set(titleKey, []);
        byTitle.get(titleKey).push(product);
        for (const variant of product.variants || []) {
            byVariantId.set(String(variant.id), { product, variant });
            const productId = String(product.id);
            if (!byProductId.has(productId)) byProductId.set(productId, []);
            byProductId.get(productId).push({ product, variant });
            const sku = normKey(variant.sku);
            if (sku && !/^\d+$/.test(sku) && !bySku.has(sku)) bySku.set(sku, { product, variant });
        }
    }

    // Reuse the Stock Room sync matcher so sheet-imported keys and Shopify
    // handle/variant keys resolve the same way here as they do in the workbench.
    for (const row of manualRows || []) {
        const match = matchHubRow(catalogIndex, row);
        if (match) addVariantHub(match.entry.variant.id, row);
    }
    // Exact descriptive matching rescues rows whose hand-entered key differs
    // from both the Shopify handle key and the variant SKU.
    for (const product of catalog || []) {
        for (const variant of product.variants || []) {
            const size = normalizeSize(extractItemSize({ variant_title: variant.title }) || variant.title);
            const row = uniqueMatch(manualIndex.byNameSize, `${normalizeName(product.title)}|${size}`);
            addVariantHub(variant.id, row);
        }
    }

    const aliasByVariantId = new Map();
    for (const alias of aliasRows || []) {
        aliasByVariantId.set(
            `${normalizeName(alias.raw_name)}|${normalizeSize(alias.raw_size)}`,
            String(alias.variant_id)
        );
    }

    const selectVariant = (product, size, extraTokens = []) => {
        const variants = product?.variants || [];
        if (variants.length === 1) return variants[0];
        if (!variants.length) return null;
        const wanted = [...extraTokens, ...normalizeName(size).split(' ').filter(Boolean)];
        if (wanted.length) {
            const hit = variants.find(variant => {
                const tokens = normalizeName(variant.title).split(' ').filter(Boolean);
                return wanted.every(token => tokens.includes(token));
            });
            if (hit) return hit;
        }
        if (size) {
            const hit = variants.find(variant =>
                normalizeSize(extractItemSize({ variant_title: variant.title }) || variant.title) === normalizeSize(size));
            if (hit) return hit;
        }
        return null;
    };

    return (item) => {
        const variantId = item?.variant_id != null ? String(item.variant_id) : '';
        if (variantId && byVariantId.has(variantId)) return uniqueMatch(variantToHub, variantId);

        const aliasVariantId = aliasByVariantId.get(`${normalizeName(itemTitle(item))}|${normalizeSize(itemSize(item))}`);
        if (aliasVariantId) {
            const hit = uniqueMatch(variantToHub, aliasVariantId);
            if (hit) return hit;
        }

        const sku = normKey(item?.sku);
        if (sku && !/^\d+$/.test(sku) && bySku.has(sku)) {
            return uniqueMatch(variantToHub, String(bySku.get(sku).variant.id));
        }

        const size = itemSize(item);
        const productId = item?.product_id != null ? String(item.product_id) : '';
        if (productId && byProductId.has(productId)) {
            const entries = byProductId.get(productId);
            const variant = selectVariant({ variants: entries.map(entry => entry.variant) }, size);
            if (variant) return uniqueMatch(variantToHub, String(variant.id));
        }

        for (const title of titleCandidates(item)) {
            const titleKey = normalizeName(title);
            let products = byTitle.get(titleKey);
            let extraTokens = [];
            if (!products) {
                const containing = [...byTitle.keys()]
                    .filter(key => key && (titleKey.startsWith(key) || key.startsWith(titleKey)))
                    .sort((a, b) => b.length - a.length);
                if (containing.length) {
                    products = byTitle.get(containing[0]);
                    extraTokens = titleKey.slice(containing[0].length).split(' ').filter(Boolean);
                }
            }
            if (products?.length !== 1) continue;
            const variant = selectVariant(products[0], size, extraTokens);
            if (variant) return uniqueMatch(variantToHub, String(variant.id));
        }
        return null;
    };
}

async function planOrderDeductions(items, manualRows, opts = {}) {
    const manualIndex = buildManualIndex(manualRows);
    const deductions = new Map();
    const unmatched = [];
    let resolveCatalog = null;

    if (opts.catalog) {
        resolveCatalog = buildCatalogResolver(opts.catalog, manualRows, opts.aliasRows || []);
    } else if (opts.loadCatalog) {
        try {
            const catalog = await opts.loadCatalog();
            if (catalog.length) resolveCatalog = buildCatalogResolver(catalog, manualRows, opts.aliasRows || []);
        } catch (error) {
            console.warn(`⚠️ Stock Room catalog fallback failed: ${error.message}`);
        }
    }

    for (const item of items || []) {
        const quantity = itemQuantity(item);
        if (!quantity) continue;
        let row = resolveDirectManual(item, manualIndex);
        if (!row && resolveCatalog) row = resolveCatalog(item);
        if (!row) {
            unmatched.push({ title: itemTitle(item) || 'Unknown item', size: itemSize(item), quantity });
            continue;
        }
        const existing = deductions.get(row.sku_key);
        if (existing) existing.quantity += quantity;
        else deductions.set(row.sku_key, {
            sku_key: row.sku_key,
            product_name: row.product_name,
            size: row.size,
            quantity,
        });
    }

    return {
        deductions: [...deductions.values()].sort((a, b) => a.sku_key.localeCompare(b.sku_key)),
        unmatched,
    };
}

async function loadInventoryContext(deps = {}) {
    const db = deps.db || dbAdapter;
    const [manualRows, bundleRows, aliasRows] = await Promise.all([
        db.query('SELECT sku_key, product_name, size FROM manual_inventory'),
        db.query('SELECT bundle_sku, component_sku, component_qty FROM zoho_bundle_map').catch(() => []),
        db.query('SELECT raw_name, raw_size, variant_id FROM inventory_name_aliases').catch(() => [])
    ]);
    return { manualRows, bundleRows, aliasRows };
}

async function planInventoryItems(items, context, deps = {}) {
    const expanded = expandBundleItems(Array.isArray(items) ? items : [], context.bundleRows);
    const loadCatalog = deps.loadCatalog || (() => require('./shopifyService').getProductCatalog(false));
    return planOrderDeductions(expanded, context.manualRows, {
        aliasRows: context.aliasRows,
        loadCatalog
    });
}

function logUnmatchedItems(plan, orderKey, label) {
    for (const item of plan.unmatched) {
        console.warn(`⚠️ Stock Room ${label}: order #${orderKey} item "${item.title}" (${item.size || 'unknown size'}) ×${item.quantity} did not match manual inventory; no stock moved for this line`);
    }
}

async function withOrderLock(dbPool, orderKey, work) {
    const client = await dbPool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`shoppers-inventory:${orderKey}`]);
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) { /* preserve the original failure */ }
        throw error;
    } finally {
        client.release();
    }
}

async function applyDeductions(client, orderKey, deductions, opts = {}) {
    const adjustmentType = opts.adjustmentType || SALE;
    const reference = opts.reference || orderKey;
    if (!DEDUCTION_TYPES.has(adjustmentType)) throw new Error(`Unsupported deduction type: ${adjustmentType}`);

    const applied = [];
    let duplicates = 0;
    let missing = 0;
    const timestamp = new Date().toISOString();
    const note = opts.note || `Customer order #${orderKey}`;

    for (const deduction of deductions || []) {
        const existing = await client.query(
            `SELECT 1 FROM inventory_adjustments
             WHERE reference = $1 AND sku_key = $2 AND adjustment_type = '${adjustmentType}' LIMIT 1`,
            [reference, deduction.sku_key]
        );
        if (existing.rows?.length) {
            duplicates++;
            continue;
        }
        const current = await client.query(
            'SELECT sku_key, product_name, size, quantity FROM manual_inventory WHERE sku_key = $1 FOR UPDATE',
            [deduction.sku_key]
        );
        const row = current.rows?.[0];
        if (!row) {
            missing++;
            continue;
        }
        const before = Number(row.quantity) || 0;
        const after = Math.max(0, before - deduction.quantity);
        const change = after - before;
        const claimed = await client.query(
            `INSERT INTO inventory_adjustments
             (sku_key, product_name, size, adjustment_type, quantity_change, quantity_before, quantity_after, reference, notes, performed_by, created_at)
             VALUES ($1, $2, $3, '${adjustmentType}', $4, $5, $6, $7, $8, 'system', $9)
             ON CONFLICT (reference, sku_key) WHERE adjustment_type = '${adjustmentType}' DO NOTHING
             RETURNING id`,
            [row.sku_key, row.product_name, row.size, change, before, after, reference, note, timestamp]
        );
        if (!claimed.rows?.length) {
            duplicates++;
            continue;
        }
        await client.query(
            'UPDATE manual_inventory SET quantity = $1, updated_at = $2 WHERE sku_key = $3',
            [after, timestamp, row.sku_key]
        );
        applied.push({ ...deduction, quantity_change: change, quantity_before: before, quantity_after: after });
    }
    return { applied, duplicates, missing };
}

async function applySaleDeductions(client, orderKey, deductions) {
    return applyDeductions(client, orderKey, deductions);
}

async function applyExchangeSaleDeductions(client, orderKey, reference, deductions) {
    return applyDeductions(client, orderKey, deductions, {
        adjustmentType: EXCHANGE_SALE,
        reference,
        note: `Exchange replacement for order #${orderKey} (${reference})`
    });
}

async function deductOrderStock(order, deps = {}) {
    const orderKey = orderKeyOf(order);
    if (!orderKey) return { success: true, skipped: 'missing_order_id' };
    if (order?.cancelled_at) return { success: true, skipped: 'order_cancelled' };

    const dbPool = deps.pool || pool;
    const context = await loadInventoryContext(deps);
    if (!context.manualRows.length) return { success: true, skipped: 'manual_inventory_empty' };

    const rawItems = order?.line_items || order?.products || order?.items || [];
    const plan = await planInventoryItems(rawItems, context, deps);
    logUnmatchedItems(plan, orderKey, 'sale');
    if (!plan.deductions.length) {
        return { success: true, deducted: 0, unmatched: plan.unmatched };
    }

    const result = await withOrderLock(dbPool, orderKey, client =>
        applySaleDeductions(client, orderKey, plan.deductions));
    const units = result.applied.reduce((sum, row) => sum + Math.abs(row.quantity_change), 0);
    if (result.applied.length) {
        console.log(`📦 Stock Room: order #${orderKey} deducted ${units} unit(s) across ${result.applied.length} SKU(s)`);
    }
    return {
        success: true,
        order_id: orderKey,
        deducted: units,
        items: result.applied,
        duplicates: result.duplicates,
        missing: result.missing,
        unmatched: plan.unmatched,
    };
}

async function applyReturnRestock(client, orderKey, reference, deductions, adjustmentType, notePrefix = 'Returned') {
    if (!RESTOCK_TYPES.has(adjustmentType)) throw new Error(`Unsupported restock type: ${adjustmentType}`);

    const applied = [];
    let duplicates = 0;
    let missing = 0;
    let exhausted = 0;
    const timestamp = new Date().toISOString();
    const deductionTypeList = [...DEDUCTION_TYPES].map(type => `'${type}'`).join(', ');
    const saleRows = await client.query(
        `SELECT sku_key, quantity_change FROM inventory_adjustments
         WHERE ${ORDER_LEDGER_REFERENCES} AND adjustment_type IN (${deductionTypeList}) ORDER BY sku_key`,
        [orderKey]
    );
    const sold = new Map();
    for (const sale of saleRows.rows || []) {
        sold.set(sale.sku_key, (sold.get(sale.sku_key) || 0) + Math.abs(Number(sale.quantity_change) || 0));
    }

    const restockTypeList = [...RESTOCK_TYPES].map(type => `'${type}'`).join(', ');
    const restoredRows = await client.query(
        `SELECT sku_key, COALESCE(SUM(quantity_change), 0) AS restored
         FROM inventory_adjustments
         WHERE ${ORDER_LEDGER_REFERENCES} AND adjustment_type IN (${restockTypeList})
         GROUP BY sku_key`,
        [orderKey]
    );
    const restored = new Map((restoredRows.rows || []).map(row => [row.sku_key, Number(row.restored) || 0]));

    for (const deduction of deductions || []) {
        const existing = await client.query(
            `SELECT 1 FROM inventory_adjustments
             WHERE reference = $1 AND sku_key = $2 AND adjustment_type = '${adjustmentType}' LIMIT 1`,
            [reference, deduction.sku_key]
        );
        if (existing.rows?.length) {
            duplicates++;
            continue;
        }

        const soldQuantity = sold.get(deduction.sku_key) || 0;
        const alreadyRestored = restored.get(deduction.sku_key) || 0;
        const remaining = Math.max(0, soldQuantity - alreadyRestored);
        if (!remaining) {
            exhausted++;
            continue;
        }
        const quantity = Math.min(deduction.quantity, remaining);
        const current = await client.query(
            'SELECT sku_key, product_name, size, quantity FROM manual_inventory WHERE sku_key = $1 FOR UPDATE',
            [deduction.sku_key]
        );
        const row = current.rows?.[0];
        if (!row) {
            missing++;
            continue;
        }
        const before = Number(row.quantity) || 0;
        const after = before + quantity;
        const claimed = await client.query(
            `INSERT INTO inventory_adjustments
             (sku_key, product_name, size, adjustment_type, quantity_change, quantity_before, quantity_after, reference, notes, performed_by, created_at)
             VALUES ($1, $2, $3, '${adjustmentType}', $4, $5, $6, $7, $8, 'system', $9)
             ON CONFLICT (reference, sku_key) WHERE adjustment_type = '${adjustmentType}' DO NOTHING
             RETURNING id`,
            [row.sku_key, row.product_name, row.size, quantity, before, after, reference,
                `${notePrefix} customer order #${orderKey} (${reference})`, timestamp]
        );
        if (!claimed.rows?.length) {
            duplicates++;
            continue;
        }
        await client.query(
            'UPDATE manual_inventory SET quantity = $1, updated_at = $2 WHERE sku_key = $3',
            [after, timestamp, row.sku_key]
        );
        restored.set(deduction.sku_key, alreadyRestored + quantity);
        applied.push({ ...deduction, quantity_change: quantity, quantity_before: before, quantity_after: after });
    }
    return { applied, duplicates, missing, exhausted };
}

async function applyCancellationRestock(client, orderKey, saleRows) {
    const deductions = (saleRows || [])
        .map(sale => ({ sku_key: sale.sku_key, quantity: Math.abs(Number(sale.quantity_change) || 0) }))
        .filter(deduction => deduction.quantity > 0);
    return applyReturnRestock(client, orderKey, orderKey, deductions, RESTOCK, 'Cancelled');
}

async function applyFullOrderRestock(client, orderKey, adjustmentType, notePrefix) {
    const rows = await client.query(
        `SELECT sku_key, quantity_change FROM inventory_adjustments
         WHERE reference = $1 AND adjustment_type = 'sale' ORDER BY sku_key`,
        [orderKey]
    );
    const deductions = (rows.rows || [])
        .map(row => ({ sku_key: row.sku_key, quantity: Math.abs(Number(row.quantity_change) || 0) }))
        .filter(deduction => deduction.quantity > 0);
    return applyReturnRestock(client, orderKey, orderKey, deductions, adjustmentType, notePrefix);
}

async function restockCancelledOrder(order, deps = {}) {
    const orderKey = orderKeyOf(order);
    if (!orderKey) return { success: true, skipped: 'missing_order_id' };
    const dbPool = deps.pool || pool;
    return withOrderLock(dbPool, orderKey, async client => {
        const result = await applyFullOrderRestock(client, orderKey, RESTOCK, 'Cancelled');
        const units = result.applied.reduce((sum, row) => sum + row.quantity_change, 0);
        if (units) console.log(`📦 Stock Room: cancelled order #${orderKey} restored ${units} unit(s)`);
        return { success: true, order_id: orderKey, restored: units, ...result };
    });
}

async function restockReturnedItems({ order, items, eventId, adjustmentType = RETURN_RESTOCK, referencePrefix = '', deps = {} }) {
    const orderKey = orderKeyOf(typeof order === 'string' ? { order_number: order } : order);
    if (!orderKey) return { success: true, skipped: 'missing_order_id' };
    let prefix = referencePrefix;
    let eventReference = String(eventId || '').trim();
    if (!prefix) {
        const match = eventReference.match(/^(return|refund|exchange):(.*)$/);
        if (match) {
            prefix = `${match[1]}:`;
            eventReference = match[2];
        }
    }
    const reference = prefix
        ? `${prefix}${orderKey}:${eventReference || 'event'}`
        : (eventReference || orderKey);

    const context = await loadInventoryContext(deps);
    if (!context.manualRows.length) return { success: true, skipped: 'manual_inventory_empty' };
    const plan = await planInventoryItems(items, context, deps);
    logUnmatchedItems(plan, orderKey, adjustmentType);
    if (!plan.deductions.length) {
        return { success: true, order_id: orderKey, restored: 0, unmatched: plan.unmatched };
    }

    const result = await withOrderLock(deps.pool || pool, orderKey, client =>
        applyReturnRestock(client, orderKey, reference, plan.deductions, adjustmentType));
    const units = result.applied.reduce((sum, row) => sum + row.quantity_change, 0);
    if (units) console.log(`📦 Stock Room: ${adjustmentType} for order #${orderKey} restored ${units} unit(s)`);
    return {
        success: true,
        order_id: orderKey,
        reference,
        restored: units,
        ...result,
        unmatched: plan.unmatched
    };
}

async function restockRTOOrder(order, deps = {}) {
    const orderKey = orderKeyOf(typeof order === 'string' ? { order_number: order } : order);
    if (!orderKey) return { success: true, skipped: 'missing_order_id' };
    return withOrderLock(deps.pool || pool, orderKey, async client => {
        const result = await applyFullOrderRestock(client, orderKey, RTO_RESTOCK, 'RTO delivered');
        const units = result.applied.reduce((sum, row) => sum + row.quantity_change, 0);
        if (units) console.log(`📦 Stock Room: RTO delivered for order #${orderKey} restored ${units} unit(s)`);
        return { success: true, order_id: orderKey, restored: units, ...result };
    });
}

async function restockShopifyRefund(shopifyOrder, refund, deps = {}) {
    const items = [];
    for (const entry of refund?.refund_line_items || refund?.line_items || []) {
        if (String(entry.restock_type || '').toLowerCase() === 'no_restock') continue;
        const item = entry.line_item || entry;
        const quantity = parseInt(entry.restock_quantity ?? entry.quantity ?? item.quantity, 10);
        if (!(quantity > 0)) continue;
        items.push({
            title: item.title || entry.title || '',
            sku: item.sku || entry.sku || '',
            variant_title: item.variant_title || entry.variant_title || '',
            variant_id: item.variant_id ?? entry.variant_id,
            product_id: item.product_id ?? entry.product_id,
            quantity
        });
    }
    if (!items.length) return { success: true, skipped: 'no_restockable_items' };
    const orderKey = orderKeyOf(shopifyOrder);
    const refundId = refund?.id != null ? String(refund.id) : '';
    return restockReturnedItems({
        order: shopifyOrder,
        items,
        eventId: refundId || 'event',
        referencePrefix: 'refund:',
        deps
    });
}

async function restockExchangeItems({ order, items, eventId, deps = {} }) {
    const orderKey = orderKeyOf(typeof order === 'string' ? { order_number: order } : order);
    if (!orderKey) return { success: true, skipped: 'missing_order_id' };
    const rawReference = String(eventId || '').trim();
    const eventReference = rawReference.startsWith('exchange:')
        ? rawReference.slice('exchange:'.length)
        : rawReference;
    return restockReturnedItems({
        order: { order_number: orderKey },
        items,
        eventId: eventReference,
        referencePrefix: 'exchange:',
        adjustmentType: EXCHANGE_RESTOCK,
        deps
    });
}

async function deductExchangeReplacement({ order, items, eventId, deps = {} }) {
    const orderKey = orderKeyOf(typeof order === 'string' ? { order_number: order } : order);
    if (!orderKey) return { success: true, skipped: 'missing_order_id' };
    const rawReference = String(eventId || '').trim();
    const eventReference = rawReference.startsWith('exchange:')
        ? rawReference.slice('exchange:'.length)
        : rawReference;
    const reference = `exchange:${orderKey}:${eventReference || 'event'}`;
    const context = await loadInventoryContext(deps);
    if (!context.manualRows.length) return { success: true, skipped: 'manual_inventory_empty' };

    const plan = await planInventoryItems(items, context, deps);
    logUnmatchedItems(plan, orderKey, 'exchange replacement');
    if (!plan.deductions.length) {
        return { success: true, order_id: orderKey, reference, deducted: 0, unmatched: plan.unmatched };
    }

    const result = await withOrderLock(deps.pool || pool, orderKey, client =>
        applyExchangeSaleDeductions(client, orderKey, reference, plan.deductions));
    const units = result.applied.reduce((sum, row) => sum + Math.abs(row.quantity_change), 0);
    if (units) console.log(`📦 Stock Room: exchange replacement for order #${orderKey} deducted ${units} unit(s)`);
    return {
        success: true,
        order_id: orderKey,
        reference,
        deducted: units,
        ...result,
        unmatched: plan.unmatched
    };
}

module.exports = {
    SALE,
    RESTOCK,
    RTO_RESTOCK,
    RETURN_RESTOCK,
    EXCHANGE_RESTOCK,
    EXCHANGE_SALE,
    normalizeName,
    normalizeSize,
    orderKeyOf,
    expandBundleItems,
    planOrderDeductions,
    applySaleDeductions,
    applyCancellationRestock,
    deductOrderStock,
    restockCancelledOrder,
    restockReturnedItems,
    restockRTOOrder,
    restockShopifyRefund,
    restockExchangeItems,
    deductExchangeReplacement,
};
