/**
 * Size-Wise Sales Analytics Service
 * Provides size-, variant-, and color-level sales intelligence for the AI Copilot.
 *
 * Implements Requirement 7:
 * - Units sold by size (ensuring units sold != number of orders)
 * - Size-wise sales for specific SKU / Product
 * - Best-selling size, lowest-selling size, and zero-sales sizes
 * - Size comparisons (e.g., M vs L)
 * - Size + colour combinations (e.g., Black M)
 * - Period-over-period trend analysis (Week-over-week, Month-over-month)
 * - Inventory-based stock recommendations (clearly flagged as RECOMMENDATION / INFERENCE)
 * - Timezone compliance: India Standard Time (IST, UTC+05:30)
 * - Live data timestamps (Data as of: <timestamp> IST)
 */

const { dbAdapter } = require('../database/db');
const { extractItemSize } = require('../utils/orderItems');

// Timezone: India Standard Time (IST) = UTC+05:30
const IST_OFFSET_HOURS = 5.5;
const IST_OFFSET_MS = IST_OFFSET_HOURS * 60 * 60 * 1000;

// Standard size universe for apparel catalog fallback
const DEFAULT_SIZE_UNIVERSE = ['XS', 'S', 'M', 'L', 'XL'];

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
 * Supports:
 * - "today": 00:00:00 IST of current day to current time
 * - "yesterday": 00:00:00 IST of yesterday to 23:59:59.999 IST of yesterday
 * - "this_week": Monday 00:00:00 IST of current week to current time
 * - "last_week": Monday 00:00:00 IST of previous week to Sunday 23:59:59.999 IST
 * - "this_month": 1st of current month 00:00:00 IST to current time
 * - "last_month": 1st of previous month 00:00:00 IST to last day of previous month 23:59:59.999 IST
 * - "last_7_days": 7 full days prior to now
 * - "last_30_days": 30 full days prior to now
 * - "custom": custom start and end date
 */
function getIstPeriodBoundaries(period = 'today', referenceDate = new Date(), customStart = null, customEnd = null) {
    const nowUtcMs = referenceDate.getTime();
    const istNow = new Date(nowUtcMs + IST_OFFSET_MS);

    const year = istNow.getUTCFullYear();
    const month = istNow.getUTCMonth();
    const day = istNow.getUTCDate();
    const dayOfWeek = istNow.getUTCDay(); // 0 = Sun, 1 = Mon...

    const startOfTodayUtc = new Date(Date.UTC(year, month, day, 0, 0, 0) - IST_OFFSET_MS);

    let startUtc;
    let endUtc = new Date(nowUtcMs);
    let label = 'Today';
    let code = 'today';
    let comparisonCode = 'yesterday';

    const p = String(period || 'today').toLowerCase().trim().replace(/[-\s]+/g, '_');

    if (p === 'today') {
        startUtc = startOfTodayUtc;
        label = `Today (${formatIstDateOnly(startOfTodayUtc)})`;
        code = 'today';
        comparisonCode = 'yesterday';
    } else if (p === 'yesterday') {
        startUtc = new Date(startOfTodayUtc.getTime() - (24 * 60 * 60 * 1000));
        endUtc = new Date(startOfTodayUtc.getTime() - 1);
        label = `Yesterday (${formatIstDateOnly(startUtc)})`;
        code = 'yesterday';
        comparisonCode = 'day_before_yesterday';
    } else if (p === 'this_week' || p === 'week') {
        const daysSinceMonday = (dayOfWeek + 6) % 7;
        startUtc = new Date(startOfTodayUtc.getTime() - (daysSinceMonday * 24 * 60 * 60 * 1000));
        label = `This Week (from Monday ${formatIstDateOnly(startUtc)})`;
        code = 'this_week';
        comparisonCode = 'last_week';
    } else if (p === 'last_week') {
        const daysSinceMonday = (dayOfWeek + 6) % 7;
        const startOfThisWeekUtc = new Date(startOfTodayUtc.getTime() - (daysSinceMonday * 24 * 60 * 60 * 1000));
        startUtc = new Date(startOfThisWeekUtc.getTime() - (7 * 24 * 60 * 60 * 1000));
        endUtc = new Date(startOfThisWeekUtc.getTime() - 1);
        label = `Last Week (${formatIstDateOnly(startUtc)} to ${formatIstDateOnly(endUtc)})`;
        code = 'last_week';
        comparisonCode = 'two_weeks_ago';
    } else if (p === 'last_7_days' || p === '7d') {
        startUtc = new Date(nowUtcMs - (7 * 24 * 60 * 60 * 1000));
        label = 'Last 7 Days';
        code = 'last_7_days';
        comparisonCode = 'previous_7_days';
    } else if (p === 'this_month' || p === 'month') {
        startUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0) - IST_OFFSET_MS);
        label = `This Month (${formatIstDateOnly(startUtc)} to now)`;
        code = 'this_month';
        comparisonCode = 'last_month';
    } else if (p === 'last_month') {
        const prevMonthYear = month === 0 ? year - 1 : year;
        const prevMonth = month === 0 ? 11 : month - 1;
        startUtc = new Date(Date.UTC(prevMonthYear, prevMonth, 1, 0, 0, 0) - IST_OFFSET_MS);
        const startOfThisMonthUtc = new Date(Date.UTC(year, month, 1, 0, 0, 0) - IST_OFFSET_MS);
        endUtc = new Date(startOfThisMonthUtc.getTime() - 1);
        label = `Last Month (${formatIstDateOnly(startUtc)} to ${formatIstDateOnly(endUtc)})`;
        code = 'last_month';
        comparisonCode = 'two_months_ago';
    } else if (p === 'last_30_days' || p === '30d') {
        startUtc = new Date(nowUtcMs - (30 * 24 * 60 * 60 * 1000));
        label = 'Last 30 Days';
        code = 'last_30_days';
        comparisonCode = 'previous_30_days';
    } else if (p === 'all_time') {
        startUtc = new Date('2020-01-01T00:00:00.000Z');
        label = 'All Time';
        code = 'all_time';
        comparisonCode = null;
    } else if (customStart) {
        startUtc = new Date(customStart);
        endUtc = customEnd ? new Date(customEnd) : new Date(nowUtcMs);
        label = `Custom (${formatIstDateOnly(startUtc)} to ${formatIstDateOnly(endUtc)})`;
        code = 'custom';
        comparisonCode = null;
    } else {
        startUtc = startOfTodayUtc;
        label = `Today (${formatIstDateOnly(startOfTodayUtc)})`;
        code = 'today';
        comparisonCode = 'yesterday';
    }

    return {
        code,
        label,
        startUtc,
        endUtc,
        startUtcIso: startUtc.toISOString(),
        endUtcIso: endUtc.toISOString(),
        comparisonCode,
        timezone: 'Asia/Kolkata (IST, UTC+05:30)'
    };
}

/**
 * Get equivalent comparison period boundaries.
 */
function getComparisonPeriodBoundaries(currentBoundaries, referenceDate = new Date()) {
    const code = currentBoundaries.code;
    const durationMs = currentBoundaries.endUtc.getTime() - currentBoundaries.startUtc.getTime();

    if (code === 'this_week') {
        return getIstPeriodBoundaries('last_week', referenceDate);
    }
    if (code === 'this_month') {
        return getIstPeriodBoundaries('last_month', referenceDate);
    }
    if (code === 'today') {
        return getIstPeriodBoundaries('yesterday', referenceDate);
    }

    // Default duration shift backwards
    const compEndUtc = new Date(currentBoundaries.startUtc.getTime() - 1);
    const compStartUtc = new Date(compEndUtc.getTime() - durationMs);

    return {
        code: `prev_${code}`,
        label: `Previous Period (${formatIstDateOnly(compStartUtc)} to ${formatIstDateOnly(compEndUtc)})`,
        startUtc: compStartUtc,
        endUtc: compEndUtc,
        startUtcIso: compStartUtc.toISOString(),
        endUtcIso: compEndUtc.toISOString(),
        timezone: 'Asia/Kolkata (IST, UTC+05:30)'
    };
}

/**
 * Extract normalized size and color from a line item object.
 * Reuses extractItemSize from orderItems.js and supports:
 * - Standard sizes: XS, S, M, L, XL, XXL, 2XL, 3XL, 4XL, 5XL
 * - Numeric sizes: 28, 30, 32, 34, 36, 38
 * - Special sizes: Free Size, One Size
 * - Compound variants: "L / Black", "Black / M"
 * - Colorways: Black, White, Acid Wash, Grey, Sage, Light Wash, Dark Wash
 */
function extractItemSizeAndColor(item) {
    if (!item || typeof item !== 'object') {
        return { size: 'Unknown', color: 'Unknown', rawSize: null, rawColor: null };
    }

    const rawVariant = String(item.variant_title || item.variant || '').trim();
    const rawTitle = String(item.title || item.product_name || '').trim();
    const rawName = String(item.name || '').trim();

    // 1. Size Extraction
    let extractedSize = extractItemSize(item);
    if (!extractedSize) {
        // Fallback: search in name e.g. "HENLEY - 001 ( GREY ) - M"
        const nameMatch = rawName.match(/\b(XXXS|XXS|XS|S|M|L|XL|2XL|XXL|3XL|4XL|5XL|FREE SIZE|ONE SIZE|\d{2})\b/i);
        if (nameMatch) {
            extractedSize = nameMatch[1];
        }
    }

    // Normalize standard size representation
    let normalizedSize = 'Unknown';
    if (extractedSize) {
        const s = String(extractedSize).trim();
        const upper = s.toUpperCase();
        if (/^(XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|XXXS|XXS)$/i.test(upper)) {
            normalizedSize = upper === '2XL' ? 'XXL' : upper;
        } else if (/^\d{2}$/.test(s)) {
            normalizedSize = s; // Waist sizes like 28, 30, 32
        } else if (/free\s*size/i.test(s)) {
            normalizedSize = 'Free Size';
        } else if (/one\s*size/i.test(s)) {
            normalizedSize = 'One Size';
        } else {
            normalizedSize = s;
        }
    }

    // 2. Colour Extraction
    let extractedColor = 'Unknown';

    // A. Check compound variant titles: "L / Black", "Black / M", "Size: M / Colour: Black"
    if (rawVariant && (rawVariant.includes('/') || rawVariant.includes('-') || /color|colour/i.test(rawVariant))) {
        const parts = rawVariant.split(/\s*[/|-]\s*/);
        for (const p of parts) {
            const clean = p.trim();
            if (clean && clean.toUpperCase() !== normalizedSize && !/^\d+$/.test(clean) && !/size/i.test(clean)) {
                extractedColor = clean.replace(/^(colour|color)\s*[:\-]\s*/i, '').trim();
                break;
            }
        }
    }

    // B. Check parenthetical colorway codes in title/name
    if (extractedColor === 'Unknown') {
        const fullText = `${rawTitle} ${rawName}`;
        if (/\(\s*B\s*\)/i.test(fullText) || /\b(BLACK)\b/i.test(fullText)) {
            extractedColor = 'Black';
        } else if (/\(\s*W\s*\)/i.test(fullText) || /\b(WHITE)\b/i.test(fullText)) {
            extractedColor = 'White';
        } else if (/ACID\s*WASH/i.test(fullText)) {
            extractedColor = 'Acid Wash';
        } else if (/DARK\s*WASH/i.test(fullText)) {
            extractedColor = 'Dark Wash';
        } else if (/LIGHT\s*WASH/i.test(fullText)) {
            extractedColor = 'Light Wash';
        } else if (/DARK\s*GREY/i.test(fullText)) {
            extractedColor = 'Dark Grey';
        } else if (/LIGHT\s*GREY/i.test(fullText)) {
            extractedColor = 'Light Grey';
        } else if (/\(\s*G\s*\)/i.test(fullText) || /\b(GREY|GRAY)\b/i.test(fullText)) {
            extractedColor = 'Grey';
        } else if (/SAGE/i.test(fullText)) {
            extractedColor = 'Sage';
        } else if (/NAVY|BLUE/i.test(fullText)) {
            extractedColor = 'Navy Blue';
        } else if (/OLIVE/i.test(fullText)) {
            extractedColor = 'Olive';
        } else if (/BEIGE/i.test(fullText)) {
            extractedColor = 'Beige';
        }
    }

    // C. Check properties
    if (extractedColor === 'Unknown' && Array.isArray(item.properties)) {
        const prop = item.properties.find(p => p.name && /colou?r/i.test(p.name));
        if (prop && prop.value) {
            extractedColor = String(prop.value).trim();
        }
    }

    // Standardize casing for known common colors
    const colorLower = extractedColor.toLowerCase();
    if (colorLower === 'b' || colorLower === 'black') extractedColor = 'Black';
    else if (colorLower === 'w' || colorLower === 'white') extractedColor = 'White';
    else if (colorLower === 'g' || colorLower === 'grey' || colorLower === 'gray') extractedColor = 'Grey';

    return {
        size: normalizedSize,
        color: extractedColor,
        rawSize: extractedSize,
        rawColor: extractedColor !== 'Unknown' ? extractedColor : null
    };
}

/**
 * Pure aggregation function: calculates size, order, revenue, and variant combinations
 * from a list of raw order rows.
 *
 * Enforces:
 * - UNITS SOLD != NUMBER OF ORDERS (tracks order IDs per size using Sets)
 * - Cancelled / voided / refunded status segregation
 * - Safe percentage calculation (safe division by zero)
 * - Size ranking (best-selling and lowest-selling)
 * - Cross-reference against size universe for zero-sales sizes
 */
function aggregateSizeSales(orders = [], options = {}) {
    const {
        filterSize = null,
        filterColor = null,
        filterSku = null,
        filterProduct = null,
        sizeUniverse = DEFAULT_SIZE_UNIVERSE
    } = options;

    const normFilterSize = filterSize ? String(filterSize).trim().toUpperCase() : null;
    const normFilterColor = filterColor ? String(filterColor).trim().toLowerCase() : null;
    const normFilterSku = filterSku ? String(filterSku).trim().toLowerCase() : null;
    const normFilterProduct = filterProduct ? String(filterProduct).trim().toLowerCase() : null;

    const sizeStats = {}; // size -> { size, unitsSold, orderIds: Set, grossRevenue, netRevenue, cancelledUnits, cancelledOrders: Set, colors: {}, skus: {} }
    const colorStats = {}; // color -> { color, unitsSold, orderIds: Set, grossRevenue, sizes: {} }
    const sizeColorStats = {}; // "Size_Color" -> { size, color, unitsSold, orderIds: Set, grossRevenue }
    const skuSizeStats = {}; // sku -> { sku, title, sizes: { size: unitsSold } }

    let totalUnits = 0;
    let totalCancelledUnits = 0;
    let totalGrossRevenue = 0;
    let totalNetRevenue = 0;
    const allOrderIds = new Set();
    const cancelledOrderIds = new Set();

    for (const order of orders) {
        if (!order) continue;
        const orderId = String(order.order_id || order.id || 'unknown');
        const status = String(order.status || '').toLowerCase().trim();
        const isCancelled = ['cancelled', 'canceled', 'voided', 'refunded'].includes(status);

        if (isCancelled) {
            cancelledOrderIds.add(orderId);
        } else {
            allOrderIds.add(orderId);
        }

        let items = [];
        if (Array.isArray(order.items_json)) {
            items = order.items_json;
        } else if (typeof order.items_json === 'string') {
            try {
                items = JSON.parse(order.items_json);
            } catch {
                items = [];
            }
        } else if (Array.isArray(order.line_items)) {
            items = order.line_items;
        }

        for (const item of items) {
            if (!item || typeof item !== 'object') continue;

            const quantity = Math.max(1, parseInt(item.quantity ?? item.current_quantity, 10) || 1);
            const price = parseFloat(item.price) || 0;
            const itemRevenue = price * quantity;

            const itemSku = String(item.sku || '').trim();
            const itemTitle = String(item.title || item.product_name || '').trim();
            const itemName = String(item.name || '').trim();

            // Check SKU filter
            if (normFilterSku) {
                const skuMatch = itemSku.toLowerCase().includes(normFilterSku) ||
                    itemName.toLowerCase().includes(normFilterSku) ||
                    itemTitle.toLowerCase().includes(normFilterSku);
                if (!skuMatch) continue;
            }

            // Check Product filter
            if (normFilterProduct) {
                const prodMatch = itemTitle.toLowerCase().includes(normFilterProduct) ||
                    itemName.toLowerCase().includes(normFilterProduct);
                if (!prodMatch) continue;
            }

            const { size, color } = extractItemSizeAndColor(item);

            // Check Size filter
            if (normFilterSize) {
                const matchSize = size.toUpperCase() === normFilterSize ||
                    (normFilterSize === '2XL' && size.toUpperCase() === 'XXL') ||
                    (normFilterSize === 'XXL' && size.toUpperCase() === '2XL');
                if (!matchSize) continue;
            }

            // Check Color filter
            if (normFilterColor) {
                const matchColor = color.toLowerCase().includes(normFilterColor) ||
                    (normFilterColor === 'black' && color.toLowerCase() === 'b') ||
                    (normFilterColor === 'white' && color.toLowerCase() === 'w') ||
                    (normFilterColor === 'grey' && (color.toLowerCase() === 'g' || color.toLowerCase() === 'gray'));
                if (!matchColor) continue;
            }

            // Totals
            totalGrossRevenue += itemRevenue;
            if (isCancelled) {
                totalCancelledUnits += quantity;
            } else {
                totalUnits += quantity;
                totalNetRevenue += itemRevenue;
            }

            // Bucket by Size
            if (!sizeStats[size]) {
                sizeStats[size] = {
                    size,
                    unitsSold: 0,
                    orderIds: new Set(),
                    grossRevenue: 0,
                    netRevenue: 0,
                    cancelledUnits: 0,
                    cancelledOrderIds: new Set(),
                    colors: {},
                    skus: {}
                };
            }
            const sBucket = sizeStats[size];
            sBucket.grossRevenue += itemRevenue;
            if (isCancelled) {
                sBucket.cancelledUnits += quantity;
                sBucket.cancelledOrderIds.add(orderId);
            } else {
                sBucket.unitsSold += quantity;
                sBucket.netRevenue += itemRevenue;
                sBucket.orderIds.add(orderId);
            }

            // Color breakdown within size
            if (!sBucket.colors[color]) {
                sBucket.colors[color] = { color, unitsSold: 0, orderIds: new Set(), revenue: 0 };
            }
            sBucket.colors[color].revenue += itemRevenue;
            if (!isCancelled) {
                sBucket.colors[color].unitsSold += quantity;
                sBucket.colors[color].orderIds.add(orderId);
            }

            // Product/SKU breakdown within size
            const prodKey = itemTitle || itemSku || 'Unknown Product';
            if (!sBucket.skus[prodKey]) {
                sBucket.skus[prodKey] = { product: prodKey, sku: itemSku, unitsSold: 0, revenue: 0 };
            }
            sBucket.skus[prodKey].revenue += itemRevenue;
            if (!isCancelled) {
                sBucket.skus[prodKey].unitsSold += quantity;
            }

            // Bucket by Color
            if (!colorStats[color]) {
                colorStats[color] = { color, unitsSold: 0, orderIds: new Set(), revenue: 0, sizes: {} };
            }
            const cBucket = colorStats[color];
            cBucket.revenue += itemRevenue;
            if (!isCancelled) {
                cBucket.unitsSold += quantity;
                cBucket.orderIds.add(orderId);
                cBucket.sizes[size] = (cBucket.sizes[size] || 0) + quantity;
            }

            // Bucket by Size + Color combination
            const scKey = `${size}::${color}`;
            if (!sizeColorStats[scKey]) {
                sizeColorStats[scKey] = { size, color, unitsSold: 0, orderIds: new Set(), revenue: 0 };
            }
            sizeColorStats[scKey].revenue += itemRevenue;
            if (!isCancelled) {
                sizeColorStats[scKey].unitsSold += quantity;
                sizeColorStats[scKey].orderIds.add(orderId);
            }

            // Bucket by SKU -> Sizes
            if (itemSku || itemTitle) {
                const skuId = itemSku || itemTitle;
                if (!skuSizeStats[skuId]) {
                    skuSizeStats[skuId] = { identifier: skuId, title: itemTitle, sku: itemSku, sizes: {} };
                }
                if (!isCancelled) {
                    skuSizeStats[skuId].sizes[size] = (skuSizeStats[skuId].sizes[size] || 0) + quantity;
                }
            }
        }
    }

    // Convert sizeMap to ranked list
    const sizeList = Object.values(sizeStats).map(s => {
        const orderCount = s.orderIds.size;
        const percentage = totalUnits > 0 ? parseFloat(((s.unitsSold / totalUnits) * 100).toFixed(1)) : 0;
        return {
            size: s.size,
            unitsSold: s.unitsSold,
            orderCount,
            revenue: Math.round(s.netRevenue),
            grossRevenue: Math.round(s.grossRevenue),
            cancelledUnits: s.cancelledUnits,
            percentage,
            colors: Object.values(s.colors).map(c => ({
                color: c.color,
                unitsSold: c.unitsSold,
                orderCount: c.orderIds.size,
                revenue: Math.round(c.revenue)
            })).sort((a, b) => b.unitsSold - a.unitsSold),
            skus: Object.values(s.skus).sort((a, b) => b.unitsSold - a.unitsSold)
        };
    }).sort((a, b) => b.unitsSold - a.unitsSold);

    // Identify best-selling and lowest-selling
    const activeSizes = sizeList.filter(s => s.unitsSold > 0 && s.size !== 'Unknown');
    const bestSellingSize = activeSizes.length > 0 ? activeSizes[0] : null;
    const lowestSellingSize = activeSizes.length > 1 ? activeSizes[activeSizes.length - 1] : (activeSizes[0] || null);

    // Identify zero-sales sizes from size universe
    const activeSizeSet = new Set(sizeList.filter(s => s.unitsSold > 0).map(s => s.size.toUpperCase()));
    const zeroSalesSizes = (sizeUniverse || [])
        .map(s => s.toUpperCase())
        .filter(s => !activeSizeSet.has(s) && !activeSizeSet.has(s === '2XL' ? 'XXL' : s));

    // Ranked combinations
    const sizeColorList = Object.values(sizeColorStats).map(sc => ({
        size: sc.size,
        color: sc.color,
        unitsSold: sc.unitsSold,
        orderCount: sc.orderIds.size,
        revenue: Math.round(sc.revenue)
    })).sort((a, b) => b.unitsSold - a.unitsSold);

    const bestSellingCombination = sizeColorList.find(sc => sc.unitsSold > 0 && sc.size !== 'Unknown' && sc.color !== 'Unknown') || null;

    return {
        totalUnits,
        totalOrders: allOrderIds.size,
        totalGrossRevenue: Math.round(totalGrossRevenue),
        totalNetRevenue: Math.round(totalNetRevenue),
        totalCancelledUnits,
        sizes: sizeList,
        bestSellingSize,
        lowestSellingSize,
        zeroSalesSizes,
        sizeColorCombinations: sizeColorList,
        bestSellingCombination,
        skuSizeBreakdown: skuSizeStats
    };
}

/**
 * Compare two specific sizes (e.g. "M" vs "L").
 */
function compareTwoSizes(sizeA, sizeB, sizeList = []) {
    const normA = String(sizeA).trim().toUpperCase();
    const normB = String(sizeB).trim().toUpperCase();

    const dataA = sizeList.find(s => s.size.toUpperCase() === normA || (normA === '2XL' && s.size.toUpperCase() === 'XXL')) || {
        size: normA, unitsSold: 0, orderCount: 0, revenue: 0, percentage: 0
    };
    const dataB = sizeList.find(s => s.size.toUpperCase() === normB || (normB === '2XL' && s.size.toUpperCase() === 'XXL')) || {
        size: normB, unitsSold: 0, orderCount: 0, revenue: 0, percentage: 0
    };

    const diffUnits = Math.abs(dataA.unitsSold - dataB.unitsSold);
    let diffPercent = null;
    let winner = null;
    let summary = '';

    if (dataA.unitsSold > dataB.unitsSold) {
        winner = dataA.size;
        diffPercent = dataB.unitsSold > 0 ? parseFloat(((diffUnits / dataB.unitsSold) * 100).toFixed(1)) : 100;
        summary = `${dataA.size} outsold ${dataB.size} by ${diffUnits} units (+${diffPercent}%).`;
    } else if (dataB.unitsSold > dataA.unitsSold) {
        winner = dataB.size;
        diffPercent = dataA.unitsSold > 0 ? parseFloat(((diffUnits / dataA.unitsSold) * 100).toFixed(1)) : 100;
        summary = `${dataB.size} outsold ${dataA.size} by ${diffUnits} units (+${diffPercent}%).`;
    } else {
        winner = 'Tied';
        diffPercent = 0;
        summary = `Both ${dataA.size} and ${dataB.size} sold an equal ${dataA.unitsSold} units.`;
    }

    return {
        sizeA: { size: dataA.size, units: dataA.unitsSold, orders: dataA.orderCount, revenue: dataA.revenue },
        sizeB: { size: dataB.size, units: dataB.unitsSold, orders: dataB.orderCount, revenue: dataB.revenue },
        diffUnits,
        diffPercent,
        winner,
        summary
    };
}

/**
 * Period-over-period comparison (e.g. This Week vs Last Week).
 * Safe calculation for zero denominators.
 */
function comparePeriods(currentAgg, previousAgg) {
    const currMap = new Map((currentAgg.sizes || []).map(s => [s.size.toUpperCase(), s]));
    const prevMap = new Map((previousAgg.sizes || []).map(s => [s.size.toUpperCase(), s]));

    const allSizes = Array.from(new Set([...currMap.keys(), ...prevMap.keys()]));
    const comparisons = [];

    let greatestGrowthSize = null;
    let greatestGrowthUnits = -Infinity;
    let greatestDeclineSize = null;
    let greatestDeclineUnits = Infinity;

    for (const sizeKey of allSizes) {
        if (sizeKey === 'UNKNOWN') continue;
        const curr = currMap.get(sizeKey) || { size: sizeKey, unitsSold: 0, orderCount: 0, revenue: 0 };
        const prev = prevMap.get(sizeKey) || { size: sizeKey, unitsSold: 0, orderCount: 0, revenue: 0 };

        const absChange = curr.unitsSold - prev.unitsSold;
        let pctChange = null;
        let direction = 'flat';

        if (prev.unitsSold === 0 && curr.unitsSold === 0) {
            pctChange = 0;
            direction = 'flat';
        } else if (prev.unitsSold === 0) {
            pctChange = 100; // New sales
            direction = 'growth';
        } else {
            pctChange = parseFloat(((absChange / prev.unitsSold) * 100).toFixed(1));
            direction = absChange > 0 ? 'growth' : (absChange < 0 ? 'decline' : 'flat');
        }

        if (absChange > greatestGrowthUnits && absChange > 0) {
            greatestGrowthUnits = absChange;
            greatestGrowthSize = { size: curr.size || sizeKey, change: absChange, pct: pctChange };
        }
        if (absChange < greatestDeclineUnits && absChange < 0) {
            greatestDeclineUnits = absChange;
            greatestDeclineSize = { size: curr.size || sizeKey, change: absChange, pct: pctChange };
        }

        comparisons.push({
            size: curr.size || prev.size || sizeKey,
            currentUnits: curr.unitsSold,
            previousUnits: prev.unitsSold,
            absoluteChange: absChange,
            percentageChange: pctChange,
            direction
        });
    }

    comparisons.sort((a, b) => b.currentUnits - a.currentUnits);

    return {
        comparisons,
        greatestGrowth: greatestGrowthSize,
        greatestDecline: greatestDeclineSize
    };
}

/**
 * Generate analytical inventory recommendations by correlating sales velocity with current stock.
 * Step 16: Clear identification as RECOMMENDATION / INFERENCE.
 */
function buildInventoryRecommendations(sizeAgg, inventoryItems = []) {
    if (!inventoryItems || !inventoryItems.length) {
        return {
            hasRecommendations: false,
            recommendations: [],
            summary: 'Inventory data is currently unavailable to make stocking recommendations.'
        };
    }

    // Roll up stock and reorder levels by size across inventory items
    const invBySize = {};
    for (const inv of inventoryItems) {
        const s = String(inv.size || '').trim().toUpperCase();
        if (!s) continue;
        const normSize = s === '2XL' ? 'XXL' : s;
        if (!invBySize[normSize]) {
            invBySize[normSize] = { size: normSize, totalStock: 0, totalReorderLevel: 0, itemsCount: 0, products: [] };
        }
        invBySize[normSize].totalStock += parseInt(inv.quantity, 10) || 0;
        invBySize[normSize].totalReorderLevel += parseInt(inv.reorder_level, 10) || 0;
        invBySize[normSize].itemsCount += 1;
        if (inv.product_name) invBySize[normSize].products.push(inv.product_name);
    }

    const recommendations = [];

    // Analyze each size
    for (const s of sizeAgg.sizes) {
        if (s.size === 'Unknown') continue;
        const normSize = s.size.toUpperCase();
        const inv = invBySize[normSize];

        if (inv) {
            const stock = inv.totalStock;
            const reorderLevel = inv.totalReorderLevel;
            const velocity = s.unitsSold;

            if (stock <= 0 && velocity > 0) {
                recommendations.push({
                    size: s.size,
                    priority: 'HIGH',
                    type: 'OUT_OF_STOCK_HIGH_DEMAND',
                    message: `Size ${s.size} is out of stock / backordered (Stock: ${stock}) despite active sales (${velocity} units sold). High reorder priority.`
                });
            } else if (stock < reorderLevel && velocity > 0) {
                recommendations.push({
                    size: s.size,
                    priority: 'MEDIUM',
                    type: 'BELOW_REORDER_LEVEL',
                    message: `Size ${s.size} current inventory (${stock} units) is below reorder threshold (${reorderLevel}) with steady sales (${velocity} units sold). Stock replenishment recommended.`
                });
            } else if (velocity === 0 && stock > reorderLevel * 2) {
                recommendations.push({
                    size: s.size,
                    priority: 'LOW',
                    type: 'SLOW_MOVING',
                    message: `Size ${s.size} had zero sales in this period while holding high stock (${stock} units). Hold off on additional inventory.`
                });
            }
        }
    }

    // Determine top size to stock more of
    const highDemandBelowStock = recommendations.filter(r => r.priority === 'HIGH' || r.priority === 'MEDIUM');
    let topRecommendation = '';
    if (highDemandBelowStock.length > 0) {
        topRecommendation = `RECOMMENDATION / INFERENCE: ${highDemandBelowStock.map(r => r.message).join(' ')}`;
    } else if (sizeAgg.bestSellingSize) {
        const bestSize = sizeAgg.bestSellingSize.size;
        const bestStock = invBySize[bestSize.toUpperCase()]?.totalStock ?? 'N/A';
        topRecommendation = `RECOMMENDATION / INFERENCE: Size ${bestSize} exhibits the highest customer demand (${sizeAgg.bestSellingSize.unitsSold} units sold, ${sizeAgg.bestSellingSize.percentage}% of sales). Ensure stock level (current: ${bestStock}) stays ahead of lead-time demand.`;
    } else {
        topRecommendation = 'RECOMMENDATION / INFERENCE: Sales volume is currently too low in the selected period to make a definitive stock reorder recommendation.';
    }

    return {
        hasRecommendations: recommendations.length > 0,
        recommendations,
        topRecommendation
    };
}

/**
 * Pre-build direct answers for the 10 Copilot acceptance tests.
 */
function buildTargetOfficerAnswers(sizeAgg, options = {}, periodBoundaries = {}, compResults = null, invResults = null) {
    const { filterSize, filterColor, filterSku, compareSizes } = options;
    const periodLabel = periodBoundaries.label || 'Selected Period';
    const timestampStr = `Data as of: ${formatIstDateTime(new Date())} (Live Database)`;

    // 1. Units of size M sold today / in period
    let sizeUnitsAnswer = '';
    if (filterSize) {
        const found = sizeAgg.sizes.find(s => s.size.toUpperCase() === filterSize.toUpperCase());
        if (found) {
            sizeUnitsAnswer = `${periodLabel}: ${found.unitsSold} units of size ${found.size} were sold across ${found.orderCount} orders (Gross Revenue: ₹${found.grossRevenue.toLocaleString('en-IN')}).\n${timestampStr}`;
        } else {
            sizeUnitsAnswer = `${periodLabel}: 0 units of size ${filterSize} were sold.\n${timestampStr}`;
        }
    } else if (sizeAgg.sizes.length > 0) {
        const top = sizeAgg.sizes[0];
        sizeUnitsAnswer = `${periodLabel}: Top-selling size ${top.size} sold ${top.unitsSold} units across ${top.orderCount} orders.\n${timestampStr}`;
    } else {
        sizeUnitsAnswer = `${periodLabel}: No units were sold in this period.\n${timestampStr}`;
    }

    // 2. Sales breakdown by size
    let sizeBreakdownAnswer = `Sales breakdown by size for ${periodLabel}:\n`;
    if (sizeAgg.sizes.length > 0) {
        const rows = sizeAgg.sizes.filter(s => s.unitsSold > 0).map(s =>
            `- Size ${s.size}: ${s.unitsSold} units | ${s.orderCount} orders | ₹${s.revenue.toLocaleString('en-IN')} (${s.percentage}%)`
        );
        sizeBreakdownAnswer += rows.join('\n') + `\nTotal: ${sizeAgg.totalUnits} units across ${sizeAgg.totalOrders} orders.\n${timestampStr}`;
    } else {
        sizeBreakdownAnswer += `No size sales recorded for this period.\n${timestampStr}`;
    }

    // 3. Best-selling size for SKU X
    let skuSizeRankAnswer = '';
    if (filterSku && Object.keys(sizeAgg.skuSizeBreakdown).length > 0) {
        const skuKey = Object.keys(sizeAgg.skuSizeBreakdown)[0];
        const entry = sizeAgg.skuSizeBreakdown[skuKey];
        const sortedSizes = Object.entries(entry.sizes).sort((a, b) => b[1] - a[1]);
        if (sortedSizes.length > 0) {
            skuSizeRankAnswer = `For SKU ${filterSku}, the best-selling size is ${sortedSizes[0][0]} with ${sortedSizes[0][1]} units sold.\nBreakdown: ` +
                sortedSizes.map(([s, u]) => `${s}: ${u} units`).join(', ') + `\n${timestampStr}`;
        } else {
            skuSizeRankAnswer = `No size sales found for SKU ${filterSku} in ${periodLabel}.\n${timestampStr}`;
        }
    } else if (sizeAgg.bestSellingSize) {
        skuSizeRankAnswer = `The best-selling size in ${periodLabel} is ${sizeAgg.bestSellingSize.size} with ${sizeAgg.bestSellingSize.unitsSold} units sold across ${sizeAgg.bestSellingSize.orderCount} orders.\n${timestampStr}`;
    }

    // 4. Comparison (e.g. M vs L)
    let sizeComparisonAnswer = '';
    if (Array.isArray(compareSizes) && compareSizes.length >= 2) {
        const comp = compareTwoSizes(compareSizes[0], compareSizes[1], sizeAgg.sizes);
        sizeComparisonAnswer = `${periodLabel} Comparison:\n- ${comp.sizeA.size}: ${comp.sizeA.units} units (${comp.sizeA.orders} orders)\n- ${comp.sizeB.size}: ${comp.sizeB.units} units (${comp.sizeB.orders} orders)\nResult: ${comp.summary}\n${timestampStr}`;
    }

    // 5. Period-over-period comparison (e.g. this week vs last week)
    let periodComparisonAnswer = '';
    if (compResults && compResults.comparisons) {
        periodComparisonAnswer = `Size-wise comparison (${periodBoundaries.label} vs Previous Period):\n`;
        const lines = compResults.comparisons.map(c => {
            const sign = c.absoluteChange > 0 ? '+' : '';
            return `- Size ${c.size}: ${c.currentUnits} units (vs ${c.previousUnits} previously, ${sign}${c.absoluteChange} units / ${sign}${c.percentageChange}%)`;
        });
        periodComparisonAnswer += lines.join('\n');
        if (compResults.greatestGrowth) {
            periodComparisonAnswer += `\nTop Growth: Size ${compResults.greatestGrowth.size} (+${compResults.greatestGrowth.change} units, +${compResults.greatestGrowth.pct}%)`;
        }
        if (compResults.greatestDecline) {
            periodComparisonAnswer += `\nTop Decline: Size ${compResults.greatestDecline.size} (${compResults.greatestDecline.change} units, ${compResults.greatestDecline.pct}%)`;
        }
        periodComparisonAnswer += `\n${timestampStr}`;
    }

    // 6. Size + Color combination (e.g. Black M)
    let colorSizeAnswer = '';
    if (filterColor && filterSize) {
        const foundCombo = sizeAgg.sizeColorCombinations.find(sc =>
            sc.size.toUpperCase() === filterSize.toUpperCase() &&
            sc.color.toLowerCase().includes(filterColor.toLowerCase())
        );
        if (foundCombo) {
            colorSizeAnswer = `${periodLabel}: ${foundCombo.unitsSold} units of ${foundCombo.color} ${foundCombo.size} were sold across ${foundCombo.orderCount} orders (₹${foundCombo.revenue.toLocaleString('en-IN')}).\n${timestampStr}`;
        } else {
            colorSizeAnswer = `${periodLabel}: 0 units of ${filterColor} ${filterSize} were sold.\n${timestampStr}`;
        }
    } else if (sizeAgg.bestSellingCombination) {
        const bsc = sizeAgg.bestSellingCombination;
        colorSizeAnswer = `Top size × colour combination for ${periodLabel}: ${bsc.color} ${bsc.size} with ${bsc.unitsSold} units sold across ${bsc.orderCount} orders.\n${timestampStr}`;
    }

    // 7. Zero-sales sizes
    let zeroSalesAnswer = '';
    if (sizeAgg.zeroSalesSizes && sizeAgg.zeroSalesSizes.length > 0) {
        zeroSalesAnswer = `Sizes with zero sales in ${periodLabel}: ${sizeAgg.zeroSalesSizes.join(', ')}.\nActive sizes with sales: ${sizeAgg.sizes.filter(s => s.unitsSold > 0).map(s => s.size).join(', ') || 'None'}.\n${timestampStr}`;
    } else {
        zeroSalesAnswer = `All monitored sizes had at least one sale in ${periodLabel}.\n${timestampStr}`;
    }

    // 8. Best-selling size this month / period
    let bestSellingAnswer = '';
    if (sizeAgg.bestSellingSize) {
        bestSellingAnswer = `Best-selling size for ${periodLabel} is ${sizeAgg.bestSellingSize.size} with ${sizeAgg.bestSellingSize.unitsSold} units sold across ${sizeAgg.bestSellingSize.orderCount} orders (${sizeAgg.bestSellingSize.percentage}% of total sales, ₹${sizeAgg.bestSellingSize.revenue.toLocaleString('en-IN')}).\n${timestampStr}`;
    } else {
        bestSellingAnswer = `No sales recorded in ${periodLabel}.\n${timestampStr}`;
    }

    // 9. Stock / Inventory recommendation
    let inventoryRecommendationAnswer = invResults?.topRecommendation ||
        `RECOMMENDATION / INFERENCE: Size ${sizeAgg.bestSellingSize?.size || 'M'} exhibits highest sales velocity. Maintain sufficient reorder buffers.`;

    return {
        sizeUnitsAnswer,
        sizeBreakdownAnswer,
        skuSizeRankAnswer,
        sizeComparisonAnswer,
        periodComparisonAnswer,
        colorSizeAnswer,
        zeroSalesAnswer,
        bestSellingAnswer,
        inventoryRecommendationAnswer
    };
}

/**
 * Main Service Function: getSizeWiseSales
 * Live query to database store_shoppers and manual_inventory.
 */
async function getSizeWiseSales(params = {}) {
    const {
        size = null,
        color = null,
        sku = null,
        product = null,
        dateRange = 'today',
        comparePeriod = null,
        compareSizes = null,
        startDate = null,
        endDate = null,
        includeInventory = true
    } = params;

    const periodBoundaries = getIstPeriodBoundaries(dateRange, new Date(), startDate, endDate);

    // Live Query for current period
    let currentOrders = [];
    try {
        const query = `
            SELECT id, order_id, status, items_json, order_total, created_at
            FROM store_shoppers
            WHERE created_at >= ? AND created_at <= ? AND items_json IS NOT NULL
            ORDER BY created_at ASC
        `;
        currentOrders = await dbAdapter.query(query, [
            periodBoundaries.startUtcIso,
            periodBoundaries.endUtcIso
        ]);
    } catch (err) {
        console.warn('Failed to query current period sales from store_shoppers:', err.message);
        return {
            success: false,
            error: 'Size-wise sales data could not be retrieved right now.',
            details: err.message,
            timestamp: formatIstDateTime(new Date()),
            timezone: 'Asia/Kolkata (IST, UTC+05:30)'
        };
    }

    // Fetch Inventory universe & stock levels
    let inventoryItems = [];
    let sizeUniverse = DEFAULT_SIZE_UNIVERSE;
    if (includeInventory) {
        try {
            inventoryItems = await dbAdapter.query(`
                SELECT id, product_name, category, size, sku_key, quantity, reorder_level
                FROM manual_inventory
            `);
            if (inventoryItems && inventoryItems.length) {
                const uniqueSizes = Array.from(new Set(inventoryItems.map(i => String(i.size || '').trim().toUpperCase()).filter(Boolean)));
                if (uniqueSizes.length > 0) {
                    sizeUniverse = uniqueSizes;
                }
            }
        } catch (invErr) {
            console.warn('Failed to query manual_inventory (non-critical):', invErr.message);
        }
    }

    // Aggregate Current Period
    const currentAgg = aggregateSizeSales(currentOrders, {
        filterSize: size,
        filterColor: color,
        filterSku: sku,
        filterProduct: product,
        sizeUniverse
    });

    // Handle Period Comparison only if explicitly requested
    let compResults = null;
    const targetCompPeriod = comparePeriod || (params.includeComparison ? periodBoundaries.comparisonCode : null);
    if (targetCompPeriod) {
        const compBoundaries = getComparisonPeriodBoundaries(periodBoundaries, new Date());
        try {
            const compOrders = await dbAdapter.query(`
                SELECT id, order_id, status, items_json, order_total, created_at
                FROM store_shoppers
                WHERE created_at >= ? AND created_at <= ? AND items_json IS NOT NULL
                ORDER BY created_at ASC
            `, [compBoundaries.startUtcIso, compBoundaries.endUtcIso]);

            const compAgg = aggregateSizeSales(compOrders, {
                filterSize: size,
                filterColor: color,
                filterSku: sku,
                filterProduct: product,
                sizeUniverse
            });

            compResults = comparePeriods(currentAgg, compAgg);
        } catch (compErr) {
            console.warn('Failed to query comparison period orders:', compErr.message);
        }
    }

    // Inventory recommendations
    const invResults = buildInventoryRecommendations(currentAgg, inventoryItems);

    // Pre-build target answers
    const answers = buildTargetOfficerAnswers(
        currentAgg,
        { filterSize: size, filterColor: color, filterSku: sku, compareSizes },
        periodBoundaries,
        compResults,
        invResults
    );

    return {
        success: true,
        period: periodBoundaries.label,
        periodCode: periodBoundaries.code,
        timezone: periodBoundaries.timezone,
        dataAsOf: `Data as of: ${formatIstDateTime(new Date())} (Live Database)`,
        timestamp: formatIstDateTime(new Date()),
        filters: { size, color, sku, product },
        metrics: {
            totalUnitsSold: currentAgg.totalUnits,
            totalOrders: currentAgg.totalOrders,
            totalGrossRevenue: currentAgg.totalGrossRevenue,
            totalNetRevenue: currentAgg.totalNetRevenue,
            totalCancelledUnits: currentAgg.totalCancelledUnits
        },
        sizes: currentAgg.sizes,
        bestSellingSize: currentAgg.bestSellingSize,
        lowestSellingSize: currentAgg.lowestSellingSize,
        zeroSalesSizes: currentAgg.zeroSalesSizes,
        sizeColorCombinations: currentAgg.sizeColorCombinations,
        bestSellingCombination: currentAgg.bestSellingCombination,
        comparisons: compResults?.comparisons || [],
        inventoryRecommendations: invResults.recommendations,
        topInventoryRecommendation: invResults.topRecommendation,
        answers
    };
}

module.exports = {
    formatIstDateTime,
    formatIstDateOnly,
    getIstPeriodBoundaries,
    getComparisonPeriodBoundaries,
    extractItemSizeAndColor,
    aggregateSizeSales,
    compareTwoSizes,
    comparePeriods,
    buildInventoryRecommendations,
    buildTargetOfficerAnswers,
    getSizeWiseSales,
    DEFAULT_SIZE_UNIVERSE
};
