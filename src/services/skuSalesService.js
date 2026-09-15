/**
 * SKU-Level Sales Analytics Service
 * Provides product- and SKU-level sales intelligence for the AI Copilot.
 *
 * Implements Requirement 6:
 * - STEP 1: Inspect available Shopify/order/sales data
 * - STEP 2: Identify SKU, product, variant, quantity, date/time and revenue
 * - STEP 3: Analytics query/tool get_sales_by_sku(date_range, sku/product filters)
 * - STEP 4: Answer target officer questions:
 *     1. "How many units of SKU X sold today?"
 *     2. "What are today's best-selling SKUs?"
 *     3. "Which SKU sold the most this week?"
 *     4. "Which SKU generated the highest revenue?"
 * - STEP 5: Clearly define time zone used for "today" as India Standard Time (IST, UTC+05:30)
 * - STEP 6: State exact data timestamp on every response (Data as of: <timestamp> IST)
 * - STEP 7: Tests comparing results against known database values
 */

const { dbAdapter } = require('../database/db');

// Timezone: India Standard Time (IST) = UTC+05:30
const IST_OFFSET_HOURS = 5.5;
const IST_OFFSET_MS = IST_OFFSET_HOURS * 60 * 60 * 1000;

/**
 * Format a Date object or ISO string to readable IST format.
 * Example: "09 Sep 2026, 07:30 AM IST"
 */
function formatIstDateTime(dateInput) {
    if (!dateInput) return 'Not available';
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return 'Not available';
        const istDate = new Date(d.getTime() + IST_OFFSET_MS);

        const day = String(istDate.getUTCDate()).padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[istDate.getUTCMonth()];
        const year = istDate.getUTCFullYear();

        let hours = istDate.getUTCHours();
        const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const formattedHour = String(hours).padStart(2, '0');

        return `${day} ${month} ${year}, ${formattedHour}:${minutes} ${ampm} IST`;
    } catch {
        return 'Not available';
    }
}

/**
 * Format Date to "DD-Mon-YYYY".
 */
function formatIstDateOnly(dateInput) {
    if (!dateInput) return 'Not available';
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return 'Not available';
        const istDate = new Date(d.getTime() + IST_OFFSET_MS);
        const day = String(istDate.getUTCDate()).padStart(2, '0');
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const month = months[istDate.getUTCMonth()];
        const year = istDate.getUTCFullYear();
        return `${day}-${month}-${year}`;
    } catch {
        return 'Not available';
    }
}

/**
 * Compute UTC start and end boundaries for a given IST period.
 * STEP 5: Clearly define the time zone used for "today".
 * 
 * In IST:
 * - "today": 00:00:00 IST of current day to current time.
 *   (e.g., 09-Sep-2026 00:00:00 IST = 08-Sep-2026 18:30:00 UTC)
 * - "yesterday": yesterday 00:00:00 IST to 23:59:59.999 IST
 * - "this_week": Monday 00:00:00 IST of current week to current time
 * - "last_7_days": 7 full days prior to now
 * - "this_month": 1st of current month 00:00:00 IST to current time
 */
function getIstPeriodBoundaries(period = 'today', referenceDate = new Date()) {
    const nowUtcMs = referenceDate.getTime();
    const istNow = new Date(nowUtcMs + IST_OFFSET_MS);

    const year = istNow.getUTCFullYear();
    const month = istNow.getUTCMonth();
    const day = istNow.getUTCDate();
    const dayOfWeek = istNow.getUTCDay(); // 0 = Sun, 1 = Mon...

    // Start of Today in IST converted back to UTC
    const startOfTodayUtc = new Date(Date.UTC(year, month, day, 0, 0, 0) - IST_OFFSET_MS);
    const endOfTodayUtc = new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - IST_OFFSET_MS);

    let startUtc;
    let endUtc = new Date(nowUtcMs);
    let label = 'Today';
    let code = 'today';

    const p = String(period || 'today').toLowerCase().trim();

    if (p === 'today') {
        startUtc = startOfTodayUtc;
        label = `Today (${formatIstDateOnly(startOfTodayUtc)})`;
        code = 'today';
    } else if (p === 'yesterday') {
        startUtc = new Date(startOfTodayUtc.getTime() - (24 * 60 * 60 * 1000));
        endUtc = new Date(startOfTodayUtc.getTime() - 1);
        label = `Yesterday (${formatIstDateOnly(startUtc)})`;
        code = 'yesterday';
    } else if (p === 'this_week' || p === 'week') {
        // Monday is day 1. If today is Sunday (0), 6 days since Monday.
        const daysSinceMonday = (dayOfWeek + 6) % 7;
        startUtc = new Date(startOfTodayUtc.getTime() - (daysSinceMonday * 24 * 60 * 60 * 1000));
        label = `This Week (from Monday ${formatIstDateOnly(startUtc)})`;
        code = 'this_week';
    } else if (p === 'last_7_days' || p === '7d') {
        startUtc = new Date(nowUtcMs - (7 * 24 * 60 * 60 * 1000));
        label = 'Last 7 Days';
        code = 'last_7_days';
    } else if (p === 'this_month' || p === 'month') {
        startUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0) - IST_OFFSET_MS);
        label = `This Month (${formatIstDateOnly(startUtc)} to now)`;
        code = 'this_month';
    } else if (p === 'all_time') {
        startUtc = new Date('2020-01-01T00:00:00.000Z');
        label = 'All Time';
        code = 'all_time';
    } else {
        // Custom or fallback to today
        startUtc = startOfTodayUtc;
        label = `Today (${formatIstDateOnly(startOfTodayUtc)})`;
        code = 'today';
    }

    return {
        code,
        label,
        startUtc,
        endUtc,
        startUtcIso: startUtc.toISOString(),
        endUtcIso: endUtc.toISOString(),
        timezone: 'Asia/Kolkata (IST, UTC+05:30)'
    };
}

/**
 * Normalize SKU key for consistent matching and inventory alignment.
 */
function normalizeSkuKey(item) {
    if (item.sku && String(item.sku).trim() && String(item.sku).trim() !== 'null') {
        return String(item.sku).trim().toLowerCase();
    }
    const title = item.title || item.product_name || item.name || 'product';
    const variant = item.variant_title || item.size || '';
    const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const cleanVariant = variant.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return cleanVariant ? `${cleanTitle}-${cleanVariant}` : cleanTitle;
}

/**
 * Extract clean product line name (stripping "- Size" suffix if present in name).
 */
function extractProductName(item) {
    if (item.title && item.title.trim()) return item.title.trim();
    if (item.name) {
        // "HENLEY - 001 ( ACID WASH ) - L" -> "HENLEY - 001 ( ACID WASH )"
        return item.name.replace(/\s*-\s*(?:XS|S|M|L|XL|XXL|2XL|3XL|\d+)\s*$/i, '').trim();
    }
    return 'Unknown Product';
}

/**
 * Pure aggregation function: Groups order rows into SKU and Product metrics.
 */
function aggregateSalesData(rows, filterOptions = {}) {
    const { skuOrProduct, sortBy = 'units', limit = 20 } = filterOptions;

    const skuMap = new Map();
    const productMap = new Map();
    let totalUnits = 0;
    let totalGrossRevenue = 0;
    let totalCancelledUnits = 0;
    let totalCancelledRevenue = 0;
    let totalOrdersCount = rows.length;

    const filterTerm = skuOrProduct ? String(skuOrProduct).toLowerCase().trim() : null;

    for (const r of rows) {
        const isCancelled = ['cancelled', 'canceled'].includes((r.status || '').toLowerCase());
        let items = [];

        if (r.items_json) {
            try {
                items = typeof r.items_json === 'string' ? JSON.parse(r.items_json) : r.items_json;
            } catch {
                items = [];
            }
        }

        if (!Array.isArray(items) || items.length === 0) continue;

        for (const it of items) {
            const qty = parseInt(it.quantity, 10) || 1;
            const price = parseFloat(it.price) || 0;
            const lineRev = price * qty;

            const name = it.name || it.title || 'Unknown Item';
            const productName = extractProductName(it);
            const variant = it.variant_title || it.size || (name.match(/\b(XS|S|M|L|XL|XXL|2XL)\b/i)?.[1]) || 'Standard';
            const skuKey = normalizeSkuKey(it);
            const explicitSku = it.sku && String(it.sku).trim() !== 'null' ? String(it.sku).trim() : null;

            // Global totals (before filter)
            totalUnits += qty;
            totalGrossRevenue += lineRev;
            if (isCancelled) {
                totalCancelledUnits += qty;
                totalCancelledRevenue += lineRev;
            }

            // Filter check if requested
            if (filterTerm) {
                const matchesName = name.toLowerCase().includes(filterTerm);
                const matchesProduct = productName.toLowerCase().includes(filterTerm);
                const matchesSku = (explicitSku && explicitSku.toLowerCase().includes(filterTerm)) || skuKey.includes(filterTerm);
                if (!matchesName && !matchesProduct && !matchesSku) {
                    continue;
                }
            }

            // 1. Variant / SKU Level aggregation
            const skuIdentifier = name;
            if (!skuMap.has(skuIdentifier)) {
                skuMap.set(skuIdentifier, {
                    name,
                    productName,
                    variant,
                    sku: explicitSku,
                    skuKey,
                    unitsSold: 0,
                    grossRevenue: 0,
                    cancelledUnits: 0,
                    netUnitsSold: 0,
                    netRevenue: 0,
                    orderCount: 0,
                    avgUnitPrice: price
                });
            }

            const skuObj = skuMap.get(skuIdentifier);
            skuObj.unitsSold += qty;
            skuObj.grossRevenue += lineRev;
            skuObj.orderCount += 1;
            if (isCancelled) {
                skuObj.cancelledUnits += qty;
            }
            skuObj.netUnitsSold = skuObj.unitsSold - skuObj.cancelledUnits;
            skuObj.netRevenue = skuObj.grossRevenue - (isCancelled ? lineRev : 0);

            // 2. Product Level roll-up aggregation
            if (!productMap.has(productName)) {
                productMap.set(productName, {
                    productName,
                    totalUnits: 0,
                    totalGrossRevenue: 0,
                    totalNetRevenue: 0,
                    cancelledUnits: 0,
                    orderCount: 0,
                    variantsBreakdown: {}
                });
            }
            const prodObj = productMap.get(productName);
            prodObj.totalUnits += qty;
            prodObj.totalGrossRevenue += lineRev;
            prodObj.orderCount += 1;
            if (isCancelled) {
                prodObj.cancelledUnits += qty;
            }
            prodObj.totalNetRevenue = prodObj.totalGrossRevenue - (isCancelled ? lineRev : 0);
            prodObj.variantsBreakdown[variant] = (prodObj.variantsBreakdown[variant] || 0) + qty;
        }
    }

    // Convert to sorted arrays
    const skusList = Array.from(skuMap.values());
    const productsList = Array.from(productMap.values());

    if (sortBy === 'revenue') {
        skusList.sort((a, b) => b.grossRevenue - a.grossRevenue);
        productsList.sort((a, b) => b.totalGrossRevenue - a.totalGrossRevenue);
    } else {
        // Default sort by units sold
        skusList.sort((a, b) => b.unitsSold - a.unitsSold || b.grossRevenue - a.grossRevenue);
        productsList.sort((a, b) => b.totalUnits - a.totalUnits || b.totalGrossRevenue - a.totalGrossRevenue);
    }

    return {
        summary: {
            totalOrders: totalOrdersCount,
            totalUnitsSold: totalUnits,
            totalGrossRevenue: Math.round(totalGrossRevenue * 100) / 100,
            totalNetRevenue: Math.round((totalGrossRevenue - totalCancelledRevenue) * 100) / 100,
            totalCancelledUnits,
            uniqueSkusCount: skuMap.size,
            uniqueProductsCount: productMap.size
        },
        skus: skusList.slice(0, limit),
        allSkusCount: skusList.length,
        products: productsList.slice(0, limit)
    };
}

/**
 * Format specific answers to the 4 target officer questions.
 */
function buildTargetOfficerAnswers({ skus, products, periodInfo, filterTerm }) {
    const periodLabel = periodInfo.label;

    // Q1: "How many units of SKU X sold today?"
    let unitsSoldAnswer = 'No matching SKU found for the specified query.';
    if (filterTerm && skus.length > 0) {
        const topMatch = skus[0];
        const matchProduct = products.find(p => p.productName.toLowerCase() === topMatch.productName.toLowerCase());
        const variantSummary = matchProduct?.variantsBreakdown 
            ? Object.entries(matchProduct.variantsBreakdown).map(([k, v]) => `${k}: ${v}`).join(', ')
            : `${topMatch.variant}: ${topMatch.unitsSold}`;

        unitsSoldAnswer = `${topMatch.name} sold ${topMatch.unitsSold} unit(s) during ${periodLabel} generating ₹${topMatch.grossRevenue.toLocaleString('en-IN')}. (Total product line across sizes: ${matchProduct?.totalUnits || topMatch.unitsSold} units [${variantSummary}]).`;
    } else if (filterTerm && skus.length === 0) {
        unitsSoldAnswer = `0 units sold for "${filterTerm}" during ${periodLabel}.`;
    } else {
        unitsSoldAnswer = `Specify a SKU or product name (e.g. "HENLEY - 001 ( ACID WASH )") to see exact units sold.`;
    }

    // Q2: "What are today's best-selling SKUs?"
    let todayBestSellersAnswer;
    if (skus.length > 0) {
        const top3 = skus.slice(0, 5).map((s, idx) => `${idx + 1}. ${s.name} — ${s.unitsSold} units (₹${s.grossRevenue.toLocaleString('en-IN')})`);
        todayBestSellersAnswer = `Best-selling SKUs for ${periodLabel}:\n${top3.join('\n')}`;
    } else {
        todayBestSellersAnswer = `No sales recorded for ${periodLabel}.`;
    }

    // Q3: "Which SKU sold the most this week?"
    let weekTopSellerAnswer;
    if (skus.length > 0) {
        const topByUnits = [...skus].sort((a, b) => b.unitsSold - a.unitsSold)[0];
        weekTopSellerAnswer = `The #1 best-selling SKU by units is "${topByUnits.name}" with ${topByUnits.unitsSold} units sold (₹${topByUnits.grossRevenue.toLocaleString('en-IN')}) during ${periodLabel}.`;
    } else {
        weekTopSellerAnswer = `No sales recorded during ${periodLabel}.`;
    }

    // Q4: "Which SKU generated the highest revenue?"
    let highestRevenueSkuAnswer;
    if (skus.length > 0) {
        const topByRevenue = [...skus].sort((a, b) => b.grossRevenue - a.grossRevenue)[0];
        highestRevenueSkuAnswer = `The SKU with the highest revenue is "${topByRevenue.name}" generating ₹${topByRevenue.grossRevenue.toLocaleString('en-IN')} (${topByRevenue.unitsSold} units sold) during ${periodLabel}.`;
    } else {
        highestRevenueSkuAnswer = `No revenue recorded during ${periodLabel}.`;
    }

    return {
        unitsSoldAnswer,
        todayBestSellersAnswer,
        weekTopSellerAnswer,
        highestRevenueSkuAnswer
    };
}

/**
 * Build structured, human-readable summary for AI Copilot presentation.
 */
function buildSalesAnalyticsSummary({ summary, skus, products, periodInfo, answers, filterTerm }) {
    const lines = [];

    // Step 6: Explicit data timestamp and Step 5: Timezone
    lines.push(`📊 SKU Sales Analytics [${periodInfo.timezone}]`);
    lines.push(`Period: ${periodInfo.label}`);
    lines.push(`Data as of: ${formatIstDateTime(new Date())} (Live Database)`);
    lines.push('');

    if (filterTerm) {
        lines.push(`🔍 Filter: "${filterTerm}"`);
        lines.push(`Result: ${answers.unitsSoldAnswer}`);
        lines.push('');
    }

    lines.push(`📈 Total Period Volume: ${summary.totalUnitsSold} units across ${summary.totalOrders} order(s) | Gross Revenue: ₹${summary.totalGrossRevenue.toLocaleString('en-IN')}`);
    lines.push('');

    lines.push('🏆 Top-Selling SKUs by Volume:');
    if (skus.length > 0) {
        skus.slice(0, 5).forEach((s, idx) => {
            lines.push(`  ${idx + 1}. ${s.name} — ${s.unitsSold} units sold | ₹${s.grossRevenue.toLocaleString('en-IN')}`);
        });
    } else {
        lines.push('  No SKU sales found matching criteria.');
    }

    lines.push('');
    lines.push(`💰 Highest Revenue SKU: ${answers.highestRevenueSkuAnswer}`);

    return lines.join('\n');
}

/**
 * Main Service API: Get Sales By SKU
 *
 * @param {Object} [params]
 * @param {string} [params.dateRange='today'] - 'today', 'yesterday', 'this_week', 'last_7_days', 'this_month', 'all_time'
 * @param {string} [params.skuOrProduct] - Optional SKU or product name filter
 * @param {string} [params.sortBy='units'] - 'units' or 'revenue'
 * @param {number} [params.limit=10] - Number of top results to return
 * @returns {Promise<Object>} Complete SKU sales analytics
 */
async function getSalesBySku(params = {}) {
    const {
        dateRange = 'today',
        skuOrProduct = null,
        sortBy = 'units',
        limit = 10
    } = params;

    // 1. Calculate IST Period Boundaries (Step 5)
    const periodInfo = getIstPeriodBoundaries(dateRange);

    // 2. Query store_shoppers within the exact IST boundaries
    const rows = await dbAdapter.query(
        `SELECT order_id, status, items_json, order_total, created_at
         FROM store_shoppers
         WHERE created_at >= ? AND created_at <= ? AND items_json IS NOT NULL
         ORDER BY created_at ASC`,
        [periodInfo.startUtcIso, periodInfo.endUtcIso]
    ).catch(err => {
        console.warn('[SKU_SALES] Database query warning:', err.message);
        return [];
    });

    // 3. Aggregate by SKU and Product
    const aggregated = aggregateSalesData(rows, {
        skuOrProduct,
        sortBy,
        limit
    });

    // 4. Build Direct Answers for Target Questions (Step 4)
    const answers = buildTargetOfficerAnswers({
        skus: aggregated.skus,
        products: aggregated.products,
        periodInfo,
        filterTerm: skuOrProduct
    });

    // 5. Build Human-Readable Formatted Summary (Step 6)
    const formattedSummary = buildSalesAnalyticsSummary({
        summary: aggregated.summary,
        skus: aggregated.skus,
        products: aggregated.products,
        periodInfo,
        answers,
        filterTerm: skuOrProduct
    });

    const currentTimestamp = formatIstDateTime(new Date());

    return {
        found: true,
        period: periodInfo.label,
        periodCode: periodInfo.code,
        timeZone: periodInfo.timezone,
        dataTimestamp: currentTimestamp,
        isLive: true,
        source: 'Shoppers Hub & Store Orders Database (Live Verified)',
        filter: skuOrProduct || null,
        summary: aggregated.summary,
        bestSellingSkus: aggregated.skus,
        bestSellingProducts: aggregated.products,
        answers: {
            unitsSoldToday: answers.unitsSoldAnswer,
            unitsSoldAnswer: answers.unitsSoldAnswer,
            todayBestSellers: answers.todayBestSellersAnswer,
            todayBestSellersAnswer: answers.todayBestSellersAnswer,
            weekTopSeller: answers.weekTopSellerAnswer,
            weekTopSellerAnswer: answers.weekTopSellerAnswer,
            highestRevenueSku: answers.highestRevenueSkuAnswer,
            highestRevenueSkuAnswer: answers.highestRevenueSkuAnswer
        },
        formattedText: formattedSummary
    };
}

module.exports = {
    getSalesBySku,
    getIstPeriodBoundaries,
    formatIstDateTime,
    formatIstDateOnly,
    normalizeSkuKey,
    extractProductName,
    aggregateSalesData,
    buildTargetOfficerAnswers,
    buildSalesAnalyticsSummary
};
