/**
 * Inventory Intelligence Service
 * Provides real-time stock levels, low-stock detection, stock-out detection,
 * inventory-vs-demand run-out rate analysis, and data-driven restocking recommendations.
 *
 * Implements Requirement 9:
 * - Real-time stock query by SKU, size, colour, and product
 * - Dynamic low-stock detection using per-SKU configured reorder_level (NEVER hardcoded constants)
 * - Out-of-stock items detection (quantity <= 0)
 * - Multi-channel stock aggregation (manual_inventory warehouse + Shopify online)
 * - Inventory vs Sales Demand analysis: sales velocity & run-out days
 * - Restocking recommendations clearly labeled: RECOMMENDATION / INFERENCE
 * - Negative and corrupted inventory anomaly handling
 * - Timezone compliance: India Standard Time (IST, UTC+05:30)
 * - Authoritative IST timestamps (Data as of: <timestamp> IST)
 */

const { dbAdapter } = require('../database/db');
const { getUnifiedProductCatalog, getVariantBySku, normalizeSku, extractColor, getIstTimestamp } = require('./productInfoService');

// Timezone: India Standard Time (IST) = UTC+05:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Get inventory stock items with optional filters.
 * Returns both warehouse and Shopify inventory levels.
 */
async function getInventoryStock({ sku, productName, size, color, category, lowStockOnly = false, outOfStockOnly = false, limit = 100 } = {}) {
    const timestamp = getIstTimestamp();
    const catalog = await getUnifiedProductCatalog();

    let allItems = [];

    // Flatten all variants across the catalog
    for (const p of catalog) {
        for (const v of p.variants) {
            const stock = typeof v.stock === 'number' ? v.stock : 0;
            const reorder = typeof v.reorder_level === 'number' ? v.reorder_level : 0;
            const isOos = stock <= 0;
            const isLow = !isOos && reorder > 0 && stock <= reorder;

            allItems.push({
                product_id: p.id,
                product_name: p.title,
                category: p.category || 'Apparel',
                variant_id: v.id,
                variant_title: v.title,
                sku: v.sku || '',
                size: v.size || 'Free Size',
                color: v.color || extractColor(p.title),
                price: v.price || 0,
                stock: stock,
                warehouse_stock: typeof v.warehouse_stock === 'number' ? v.warehouse_stock : stock,
                reorder_level: reorder,
                stock_status: isOos ? 'out_of_stock' : (isLow ? 'low_stock' : 'in_stock'),
                is_anomaly: stock < 0,
                available: stock > 0
            });
        }
    }

    // Apply filters
    let filtered = allItems;

    if (sku) {
        const norm = normalizeSku(sku);
        filtered = filtered.filter(i => normalizeSku(i.sku) === norm || normalizeSku(i.sku).includes(norm));
    }

    if (productName) {
        const pNorm = String(productName).trim().toLowerCase();
        filtered = filtered.filter(i => i.product_name.toLowerCase().includes(pNorm));
    }

    if (size) {
        const sNorm = String(size).trim().toUpperCase();
        filtered = filtered.filter(i => String(i.size).toUpperCase() === sNorm);
    }

    if (color) {
        const cNorm = String(color).trim().toLowerCase();
        filtered = filtered.filter(i => i.color.toLowerCase().includes(cNorm));
    }

    if (category) {
        const catNorm = String(category).trim().toLowerCase();
        filtered = filtered.filter(i => i.category.toLowerCase().includes(catNorm));
    }

    if (outOfStockOnly) {
        filtered = filtered.filter(i => i.stock_status === 'out_of_stock');
    } else if (lowStockOnly) {
        filtered = filtered.filter(i => i.stock_status === 'low_stock');
    }

    const totalMatching = filtered.length;
    const paginated = filtered.slice(0, limit);

    const summary = {
        total_items: totalMatching,
        in_stock_items: filtered.filter(i => i.stock_status === 'in_stock').length,
        low_stock_items: filtered.filter(i => i.stock_status === 'low_stock').length,
        out_of_stock_items: filtered.filter(i => i.stock_status === 'out_of_stock').length,
        negative_stock_anomalies: filtered.filter(i => i.is_anomaly).length
    };

    return {
        items: paginated,
        summary,
        filters: { sku, productName, size, color, category, lowStockOnly, outOfStockOnly },
        data_as_of: timestamp
    };
}

/**
 * Get low-stock items based strictly on configured per-SKU reorder_level.
 * An item is low stock when: 0 < quantity <= reorder_level.
 * NEVER uses hardcoded constants!
 */
async function getLowStockItems({ limit = 50, category, size } = {}) {
    return getInventoryStock({ lowStockOnly: true, limit, category, size });
}

/**
 * Get out-of-stock items (quantity <= 0).
 */
async function getOutOfStockItems({ limit = 50, category } = {}) {
    return getInventoryStock({ outOfStockOnly: true, limit, category });
}

/**
 * Analyze inventory vs recent sales demand to calculate sales velocity,
 * estimated days until stockout (run-out days), and generate restocking recommendations.
 */
async function analyzeStockVsDemand({ sku, productName, days = 30 } = {}) {
    const timestamp = getIstTimestamp();
    const catalog = await getUnifiedProductCatalog();

    // 1. Identify target items
    let targetItems = [];
    if (sku) {
        const norm = normalizeSku(sku);
        for (const p of catalog) {
            for (const v of p.variants) {
                if (normalizeSku(v.sku) === norm || normalizeSku(v.sku).includes(norm)) {
                    targetItems.push({ product: p, variant: v });
                }
            }
        }
    } else if (productName) {
        const pNorm = String(productName).trim().toLowerCase();
        for (const p of catalog) {
            if (p.title.toLowerCase().includes(pNorm)) {
                for (const v of p.variants) {
                    targetItems.push({ product: p, variant: v });
                }
            }
        }
    } else {
        // Sample all items with low stock or top items
        for (const p of catalog) {
            for (const v of p.variants) {
                if (v.stock_status === 'low_stock' || v.stock <= 50) {
                    targetItems.push({ product: p, variant: v });
                }
            }
        }
    }

    // 2. Fetch sales over specified days window from store_shoppers
    const sinceDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
    let salesBySku = new Map();
    let salesByTitle = new Map();

    try {
        const orders = await dbAdapter.query(
            `SELECT items_json FROM store_shoppers 
             WHERE created_at >= $1 
               AND status NOT IN ('cancelled', 'voided') 
             LIMIT 1000`,
            [sinceDate]
        );

        for (const order of orders) {
            let items = [];
            try {
                items = typeof order.items_json === 'string' ? JSON.parse(order.items_json) : (order.items_json || []);
            } catch {
                continue;
            }
            if (!Array.isArray(items)) continue;

            for (const item of items) {
                const qty = parseInt(item.quantity, 10) || 1;
                const iSku = normalizeSku(item.sku);
                const iTitle = String(item.title || item.name || '').trim().toLowerCase();

                if (iSku) {
                    salesBySku.set(iSku, (salesBySku.get(iSku) || 0) + qty);
                }
                if (iTitle) {
                    salesByTitle.set(iTitle, (salesByTitle.get(iTitle) || 0) + qty);
                }
            }
        }
    } catch (err) {
        console.warn('⚠️ Sales velocity query warning:', err.message);
    }

    // 3. Compute velocity, run-out days, and restock recommendation per item
    const analyses = [];

    for (const { product, variant } of targetItems) {
        const vSkuNorm = normalizeSku(variant.sku);
        const pTitleNorm = product.title.toLowerCase();

        const unitsSold = salesBySku.get(vSkuNorm) || salesByTitle.get(pTitleNorm) || 0;
        const dailyVelocity = parseFloat((unitsSold / Math.max(1, days)).toFixed(2));
        const currentStock = typeof variant.stock === 'number' ? variant.stock : 0;
        const reorderLevel = typeof variant.reorder_level === 'number' ? variant.reorder_level : 0;

        let runOutDays = null;
        let runOutStatus = 'adequate';
        let recommendedRestockQty = 0;

        if (currentStock <= 0) {
            runOutDays = 0;
            runOutStatus = 'already_out_of_stock';
            // Suggest restocking based on reorder level or 30-day forecast
            recommendedRestockQty = Math.max(reorderLevel > 0 ? reorderLevel * 2 : 100, Math.ceil(dailyVelocity * 30));
        } else if (dailyVelocity > 0) {
            runOutDays = parseFloat((currentStock / dailyVelocity).toFixed(1));
            if (runOutDays <= 7 || (reorderLevel > 0 && currentStock <= reorderLevel)) {
                runOutStatus = 'urgent_restock';
            } else if (runOutDays <= 14) {
                runOutStatus = 'moderate_restock';
            } else {
                runOutStatus = 'adequate';
            }
            // Target 45 days of forward cover minus current stock
            const targetCoverUnits = Math.max(reorderLevel > 0 ? reorderLevel * 2 : 100, Math.ceil(dailyVelocity * 45));
            recommendedRestockQty = Math.max(0, targetCoverUnits - currentStock);
        } else {
            // No recent sales
            runOutDays = 999;
            runOutStatus = currentStock <= reorderLevel && reorderLevel > 0 ? 'low_stock_slow_moving' : 'adequate';
            if (reorderLevel > 0 && currentStock <= reorderLevel) {
                recommendedRestockQty = Math.max(0, (reorderLevel * 2) - currentStock);
            }
        }

        analyses.push({
            sku: variant.sku,
            product_name: product.title,
            variant_title: variant.title,
            size: variant.size,
            color: variant.color,
            current_stock: currentStock,
            reorder_level: reorderLevel,
            stock_status: variant.stock_status,
            analysis_period_days: days,
            units_sold_in_period: unitsSold,
            daily_sales_velocity: dailyVelocity,
            estimated_days_remaining: runOutDays === 999 ? 'No stockout risk (>90 days)' : runOutDays,
            run_out_days_numeric: runOutDays,
            run_out_status: runOutStatus,
            restock_recommendation: {
                urgency: runOutStatus === 'already_out_of_stock' || runOutStatus === 'urgent_restock' ? 'HIGH' :
                         (runOutStatus === 'moderate_restock' || runOutStatus === 'low_stock_slow_moving' ? 'MEDIUM' : 'LOW'),
                recommended_units: recommendedRestockQty,
                type: 'RECOMMENDATION / INFERENCE',
                rationale: currentStock <= 0 
                    ? `Item is currently OUT OF STOCK. Recommended batch: ${recommendedRestockQty} units based on 30-day velocity and reorder level.`
                    : dailyVelocity > 0
                    ? `At current sales velocity of ${dailyVelocity} units/day, existing stock (${currentStock} units) will run out in ~${runOutDays} days. Recommend reordering ${recommendedRestockQty} units to maintain 45 days of supply.`
                    : `Stock is at ${currentStock} units (reorder level: ${reorderLevel}). Recommended replenishment: ${recommendedRestockQty} units.`
            }
        });
    }

    // Sort by urgency: out of stock first, then lowest run-out days
    analyses.sort((a, b) => a.run_out_days_numeric - b.run_out_days_numeric);

    return {
        analyses,
        total_analyzed: analyses.length,
        urgent_restock_count: analyses.filter(a => a.restock_recommendation.urgency === 'HIGH').length,
        data_as_of: timestamp
    };
}

/**
 * Get prioritized list of urgent restocking recommendations.
 */
async function getRestockingRecommendations({ limit = 20 } = {}) {
    const analysis = await analyzeStockVsDemand({ days: 30 });
    const prioritized = analysis.analyses
        .filter(a => a.restock_recommendation.urgency === 'HIGH' || a.restock_recommendation.urgency === 'MEDIUM')
        .slice(0, limit);

    return {
        recommendations: prioritized,
        total_recommended: prioritized.length,
        disclaimer: 'RECOMMENDATION / INFERENCE: Reorder quantities are calculated from current warehouse stock, configured reorder levels, and historical sales velocity.',
        data_as_of: analysis.data_as_of
    };
}

/**
 * Format a human-readable summary for AI Copilot responses.
 */
function formatInventorySummary(result) {
    if (!result) return 'No inventory data available.';

    if (result.analyses && result.analyses.length > 0) {
        const top = result.analyses.slice(0, 5);
        const lines = top.map(a => 
            `- ${a.product_name} | Size ${a.size} (${a.color}) | SKU: ${a.sku}: Stock = ${a.current_stock}, Velocity = ${a.daily_sales_velocity}/day, Run-out = ~${a.estimated_days_remaining} days. [${a.restock_recommendation.urgency} URGENCY - Restock ${a.restock_recommendation.recommended_units} units]`
        ).join('\n');

        return `[VERIFIED FACT] Inventory vs Demand Analysis (Past 30 Days):
Total Items Analyzed: ${result.total_analyzed} | Urgent Restock: ${result.urgent_restock_count}

${lines}

[RECOMMENDATION / INFERENCE]
Reorder urgency is determined by per-SKU reorder levels and daily sales run-rate. Prioritize items running out in <7 days.
(Data as of: ${result.data_as_of} — Live Database)`;
    }

    if (result.items) {
        const summary = result.summary || {};
        const sampleLines = result.items.slice(0, 8).map(i =>
            `- ${i.product_name} | Size ${i.size} (${i.color}): ${i.stock} units [${i.stock_status.toUpperCase()}] (Reorder Level: ${i.reorder_level}, SKU: ${i.sku})`
        ).join('\n');

        return `[VERIFIED FACT] Inventory Status:
Total Matching: ${summary.total_items || result.items.length} | In Stock: ${summary.in_stock_items || 0} | Low Stock: ${summary.low_stock_items || 0} | Out of Stock: ${summary.out_of_stock_items || 0}

${sampleLines}

(Data as of: ${result.data_as_of} — Live Database)`;
    }

    return JSON.stringify(result);
}

module.exports = {
    getInventoryStock,
    getLowStockItems,
    getOutOfStockItems,
    analyzeStockVsDemand,
    getRestockingRecommendations,
    formatInventorySummary
};
