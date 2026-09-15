/**
 * Product & SKU Information Service
 * Provides comprehensive product, variant, and SKU intelligence for the AI Copilot.
 *
 * Implements Requirement 8:
 * - Real-time product/variant/SKU inspection
 * - Product -> Variant -> SKU -> Size -> Colour -> Price -> Stock mapping
 * - Active/Inactive status detection
 * - In-stock / Low-stock / Out-of-stock availability status
 * - SKU alias and normalization handling
 * - Multi-colour and multi-size matrix inspection
 * - Multi-source data unification: Shopify API + manual_inventory + store_shoppers
 * - Authoritative IST timestamps (Data as of: <timestamp> IST)
 */

const { dbAdapter } = require('../database/db');
const shopifyService = require('./shopifyService');
const { extractItemSize } = require('../utils/orderItems');

// Timezone: India Standard Time (IST) = UTC+05:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function getIstTimestamp() {
    const d = new Date(Date.now() + IST_OFFSET_MS);
    const day = String(d.getUTCDate()).padStart(2, '0');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getUTCMonth()];
    const year = d.getUTCFullYear();
    let hours = d.getUTCHours();
    const minutes = String(d.getUTCMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    const formattedHour = String(hours).padStart(2, '0');
    return `${day} ${month} ${year}, ${formattedHour}:${minutes} ${ampm} IST`;
}

// In-memory catalog cache with 5-minute TTL
let _catalogCache = null;
let _catalogCacheAt = 0;
const CATALOG_TTL = 5 * 60 * 1000;

/**
 * Standardize and normalize SKU keys for reliable comparison.
 * e.g. "HL-001-GRY-M" -> "hl-001-gry-m"
 * also strips special chars for alias matching: "hl001grym"
 */
function normalizeSku(sku) {
    if (!sku) return '';
    return String(sku).trim().toLowerCase();
}

function cleanSkuAlphanumeric(sku) {
    if (!sku) return '';
    return String(sku).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Extract colour name from product or variant text.
 */
function extractColor(text) {
    if (!text) return 'Standard';
    const str = String(text);

    // Parenthetical codes: ( B ) -> Black, ( W ) -> White
    if (/\(\s*B\s*\)/i.test(str)) return 'Black';
    if (/\(\s*W\s*\)/i.test(str)) return 'White';
    if (/\(\s*DARK\s*GREY\s*\)/i.test(str)) return 'Dark Grey';
    if (/\(\s*LIGHT\s*GREY\s*\)/i.test(str)) return 'Light Grey';
    if (/\(\s*GREY\s*\)/i.test(str) || /\(\s*GRAY\s*\)/i.test(str)) return 'Grey';
    if (/\(\s*SAGE\s*\)/i.test(str)) return 'Sage';
    if (/\(\s*NAVY\s*\)/i.test(str)) return 'Navy';
    if (/\(\s*BEIGE\s*\)/i.test(str)) return 'Beige';
    if (/\(\s*OLIVE\s*\)/i.test(str)) return 'Olive';
    if (/\(\s*ACID\s*WASH\s*\)/i.test(str) || /acid\s*wash/i.test(str)) return 'Acid Wash';
    if (/\(\s*LIGHT\s*WASH\s*\)/i.test(str) || /light\s*wash/i.test(str)) return 'Light Wash';
    if (/\(\s*DARK\s*WASH\s*\)/i.test(str) || /dark\s*wash/i.test(str)) return 'Dark Wash';

    // Word boundary checks
    if (/\bblack\b/i.test(str)) return 'Black';
    if (/\bwhite\b/i.test(str)) return 'White';
    if (/\bdark\s*grey\b/i.test(str) || /\bdark\s*gray\b/i.test(str)) return 'Dark Grey';
    if (/\blight\s*grey\b/i.test(str) || /\blight\s*gray\b/i.test(str)) return 'Light Grey';
    if (/\bgrey\b/i.test(str) || /\bgray\b/i.test(str)) return 'Grey';
    if (/\bsage\b/i.test(str)) return 'Sage';
    if (/\bnavy\b/i.test(str)) return 'Navy';
    if (/\bbeige\b/i.test(str)) return 'Beige';
    if (/\bolive\b/i.test(str)) return 'Olive';
    if (/\bbrown\b/i.test(str)) return 'Brown';
    if (/\bblue\b/i.test(str)) return 'Blue';

    return 'Standard';
}

/**
 * Build unified product catalog combining Shopify API + manual_inventory + order line items.
 */
async function getUnifiedProductCatalog(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && _catalogCache && (now - _catalogCacheAt < CATALOG_TTL)) {
        return _catalogCache;
    }

    // 1. Fetch Shopify catalog if available
    let shopifyCatalog = [];
    try {
        if (shopifyService && typeof shopifyService.getProductCatalog === 'function') {
            shopifyCatalog = await shopifyService.getProductCatalog(forceRefresh) || [];
        }
    } catch (err) {
        console.warn('⚠️ Shopify catalog fetch non-critical warning:', err.message);
    }

    // 2. Fetch warehouse inventory from manual_inventory table
    let manualInventoryRows = [];
    try {
        manualInventoryRows = await dbAdapter.query(
            'SELECT id, product_name, category, size, sku_key, quantity, reorder_level, updated_at FROM manual_inventory ORDER BY product_name, size'
        );
    } catch (err) {
        console.warn('⚠️ manual_inventory query non-critical warning:', err.message);
    }

    // 3. Fetch recent distinct prices only if Shopify catalog returned no items
    let lineItemPriceMap = new Map();
    if (shopifyCatalog.length === 0) {
        try {
            const recentOrders = await dbAdapter.query(
                'SELECT items_json FROM store_shoppers WHERE items_json IS NOT NULL ORDER BY created_at DESC LIMIT 50'
            );
            for (const row of recentOrders) {
                let items = [];
                try {
                    items = typeof row.items_json === 'string' ? JSON.parse(row.items_json) : (row.items_json || []);
                } catch {
                    continue;
                }
                if (!Array.isArray(items)) continue;
                for (const item of items) {
                    const sku = normalizeSku(item.sku);
                    const title = String(item.title || item.name || '').trim().toLowerCase();
                    const price = parseFloat(item.price) || 0;
                    if (sku && price > 0 && !lineItemPriceMap.has(sku)) {
                        lineItemPriceMap.set(sku, price);
                    }
                    if (title && price > 0 && !lineItemPriceMap.has(title)) {
                        lineItemPriceMap.set(title, price);
                    }
                }
            }
        } catch (err) {
            console.warn('⚠️ store_shoppers pricing lookup non-critical warning:', err.message);
        }
    }

    // 4. Group manual inventory by product_name
    const productsMap = new Map();

    // Ingest Shopify products first if present
    for (const sp of shopifyCatalog) {
        const pTitle = sp.title || 'Untitled Product';
        const pKey = pTitle.toLowerCase().trim();
        productsMap.set(pKey, {
            id: sp.id ? String(sp.id) : null,
            title: pTitle,
            handle: sp.handle || pTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
            image: sp.image || null,
            category: 'Apparel',
            status: 'active',
            source: 'shopify',
            variants: (sp.variants || []).map(v => {
                const vSize = extractItemSize(v) || 'Free Size';
                const vColor = extractColor(v.title || pTitle);
                const stock = typeof v.inventory === 'number' ? v.inventory : 0;
                return {
                    id: v.id ? String(v.id) : null,
                    title: v.title || `${vColor} / ${vSize}`,
                    sku: v.sku || '',
                    size: vSize,
                    color: vColor,
                    price: v.price || 0,
                    compare_at_price: v.compare_at_price || null,
                    stock: stock,
                    reorder_level: 0,
                    stock_status: stock <= 0 ? 'out_of_stock' : 'in_stock',
                    active: true,
                    available: v.available !== false && stock > 0
                };
            })
        });
    }

    // Enrich or add products from manual_inventory
    for (const inv of manualInventoryRows) {
        const pName = (inv.product_name || 'Warehouse Product').trim();
        const pKey = pName.toLowerCase();
        let existing = productsMap.get(pKey);

        const skuKey = inv.sku_key || '';
        const normSku = normalizeSku(skuKey);
        const size = inv.size || extractItemSize({ size: inv.size }) || 'Free Size';
        const color = extractColor(pName);
        const quantity = typeof inv.quantity === 'number' ? inv.quantity : 0;
        const reorderLevel = typeof inv.reorder_level === 'number' ? inv.reorder_level : 0;

        // Determine stock status using authoritative reorder_level
        let stockStatus = 'in_stock';
        if (quantity <= 0) {
            stockStatus = 'out_of_stock';
        } else if (reorderLevel > 0 && quantity <= reorderLevel) {
            stockStatus = 'low_stock';
        }

        const price = lineItemPriceMap.get(normSku) || lineItemPriceMap.get(pKey) || 999;

        const variantObj = {
            id: `inv-${inv.id}`,
            title: `${color} / ${size}`,
            sku: skuKey,
            size: size,
            color: color,
            price: price,
            compare_at_price: null,
            stock: quantity,
            reorder_level: reorderLevel,
            stock_status: stockStatus,
            active: true,
            available: quantity > 0,
            warehouse_stock: quantity,
            last_updated: inv.updated_at
        };

        if (existing) {
            // Find if variant already exists by SKU or size
            const vIdx = existing.variants.findIndex(v =>
                (v.sku && normSku && normalizeSku(v.sku) === normSku) ||
                (v.size.toUpperCase() === size.toUpperCase() && v.color.toLowerCase() === color.toLowerCase())
            );
            if (vIdx >= 0) {
                // Merge warehouse inventory data
                existing.variants[vIdx].warehouse_stock = quantity;
                existing.variants[vIdx].reorder_level = reorderLevel;
                if (!existing.variants[vIdx].sku && skuKey) {
                    existing.variants[vIdx].sku = skuKey;
                }
                // If Shopify stock was 0 or not tracked, use warehouse stock
                if (existing.variants[vIdx].stock === 0 && quantity > 0) {
                    existing.variants[vIdx].stock = quantity;
                }
                existing.variants[vIdx].stock_status =
                    existing.variants[vIdx].stock <= 0 ? 'out_of_stock' :
                    (reorderLevel > 0 && existing.variants[vIdx].stock <= reorderLevel ? 'low_stock' : 'in_stock');
                existing.variants[vIdx].available = existing.variants[vIdx].stock > 0;
            } else {
                existing.variants.push(variantObj);
            }
            if (inv.category && existing.category === 'Apparel') {
                existing.category = inv.category;
            }
        } else {
            // Create new product entry from manual_inventory
            productsMap.set(pKey, {
                id: `p-${inv.id}`,
                title: pName,
                handle: pName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                image: null,
                category: inv.category || 'Apparel',
                status: 'active',
                source: 'manual_inventory',
                variants: [variantObj]
            });
        }
    }

    // Finalize catalog array
    const catalog = Array.from(productsMap.values()).map(p => {
        const totalStock = p.variants.reduce((sum, v) => sum + (v.stock || 0), 0);
        const inStockCount = p.variants.filter(v => v.stock_status === 'in_stock').length;
        const lowStockCount = p.variants.filter(v => v.stock_status === 'low_stock').length;
        const outOfStockCount = p.variants.filter(v => v.stock_status === 'out_of_stock').length;

        const sizes = Array.from(new Set(p.variants.map(v => v.size))).filter(Boolean);
        const colors = Array.from(new Set(p.variants.map(v => v.color))).filter(Boolean);

        return {
            ...p,
            total_stock: totalStock,
            sizes,
            colors,
            in_stock_variants: inStockCount,
            low_stock_variants: lowStockCount,
            out_of_stock_variants: outOfStockCount,
            overall_status: totalStock > 0 ? (lowStockCount > 0 ? 'low_stock' : 'in_stock') : 'out_of_stock'
        };
    });

    _catalogCache = catalog;
    _catalogCacheAt = now;
    return catalog;
}

/**
 * Get product information by query, ID, handle, or SKU.
 */
async function getProductInfo({ query, productId, handle, sku } = {}) {
    const catalog = await getUnifiedProductCatalog();
    const timestamp = getIstTimestamp();

    let targetProduct = null;

    // 1. Match by SKU
    if (sku) {
        const normSku = normalizeSku(sku);
        const cleanSku = cleanSkuAlphanumeric(sku);
        for (const p of catalog) {
            const vMatch = p.variants.find(v => {
                const vNorm = normalizeSku(v.sku);
                const vClean = cleanSkuAlphanumeric(v.sku);
                return vNorm === normSku || (cleanSku && vClean === cleanSku) || (vNorm && vNorm.includes(normSku));
            });
            if (vMatch) {
                targetProduct = p;
                break;
            }
        }
    }

    // 2. Match by Product ID
    if (!targetProduct && productId) {
        const pidStr = String(productId).trim();
        targetProduct = catalog.find(p => String(p.id) === pidStr);
    }

    // 3. Match by Handle
    if (!targetProduct && handle) {
        const hNorm = String(handle).trim().toLowerCase();
        targetProduct = catalog.find(p => p.handle.toLowerCase() === hNorm);
    }

    // 4. Match by Query text (fuzzy / substring)
    if (!targetProduct && query) {
        const qNorm = String(query).trim().toLowerCase();
        // Exact title match first
        targetProduct = catalog.find(p => p.title.toLowerCase() === qNorm);
        if (!targetProduct) {
            // Title includes query
            targetProduct = catalog.find(p => p.title.toLowerCase().includes(qNorm));
        }
        if (!targetProduct) {
            // Query includes title
            targetProduct = catalog.find(p => qNorm.includes(p.title.toLowerCase()));
        }
        if (!targetProduct) {
            // Variant SKU or title match
            targetProduct = catalog.find(p =>
                p.variants.some(v =>
                    normalizeSku(v.sku).includes(qNorm) ||
                    v.title.toLowerCase().includes(qNorm)
                )
            );
        }
    }

    if (!targetProduct) {
        return {
            found: false,
            message: `No product found matching ${JSON.stringify({ query, productId, handle, sku })}`,
            data_as_of: timestamp
        };
    }

    // Build 2D Size x Colour Matrix
    const sizeColorMatrix = targetProduct.variants.map(v => ({
        size: v.size,
        color: v.color,
        sku: v.sku,
        price: v.price,
        compare_at_price: v.compare_at_price,
        stock: v.stock,
        reorder_level: v.reorder_level,
        stock_status: v.stock_status,
        available: v.available
    }));

    return {
        found: true,
        product: {
            id: targetProduct.id,
            title: targetProduct.title,
            handle: targetProduct.handle,
            category: targetProduct.category,
            status: targetProduct.status,
            image: targetProduct.image,
            total_stock: targetProduct.total_stock,
            overall_status: targetProduct.overall_status,
            sizes: targetProduct.sizes,
            colors: targetProduct.colors,
            variants: targetProduct.variants,
            size_color_matrix: sizeColorMatrix,
            in_stock_variants: targetProduct.in_stock_variants,
            low_stock_variants: targetProduct.low_stock_variants,
            out_of_stock_variants: targetProduct.out_of_stock_variants
        },
        data_as_of: timestamp
    };
}

/**
 * Get detailed information for a single variant by SKU.
 * Supports exact SKU, case-insensitive, hyphen-agnostic alias matching.
 */
async function getVariantBySku(sku) {
    if (!sku) {
        return {
            found: false,
            error: 'SKU parameter is required',
            data_as_of: getIstTimestamp()
        };
    }

    const catalog = await getUnifiedProductCatalog();
    const timestamp = getIstTimestamp();
    const normSku = normalizeSku(sku);
    const cleanSku = cleanSkuAlphanumeric(sku);

    let matchedProduct = null;
    let matchedVariant = null;

    // 1. Search in cached catalog
    for (const p of catalog) {
        for (const v of p.variants) {
            const vNorm = normalizeSku(v.sku);
            const vClean = cleanSkuAlphanumeric(v.sku);
            if (vNorm === normSku || (cleanSku && vClean === cleanSku)) {
                matchedProduct = p;
                matchedVariant = v;
                break;
            }
        }
        if (matchedVariant) break;
    }

    // Partial contains match if exact not found
    if (!matchedVariant) {
        for (const p of catalog) {
            for (const v of p.variants) {
                const vNorm = normalizeSku(v.sku);
                if (vNorm && (vNorm.includes(normSku) || normSku.includes(vNorm))) {
                    matchedProduct = p;
                    matchedVariant = v;
                    break;
                }
            }
            if (matchedVariant) break;
        }
    }

    // 2. Direct database query fallback if catalog didn't have it
    if (!matchedVariant) {
        try {
            const rows = await dbAdapter.query(
                `SELECT * FROM manual_inventory 
                 WHERE LOWER(sku_key) = LOWER($1) 
                    OR REPLACE(LOWER(sku_key), '-', '') = $2 
                 LIMIT 1`,
                [normSku, cleanSku]
            );
            if (rows.length > 0) {
                const row = rows[0];
                const qty = typeof row.quantity === 'number' ? row.quantity : 0;
                const reorder = typeof row.reorder_level === 'number' ? row.reorder_level : 0;
                matchedProduct = {
                    id: `inv-${row.id}`,
                    title: row.product_name,
                    category: row.category,
                    status: 'active'
                };
                matchedVariant = {
                    id: `inv-var-${row.id}`,
                    sku: row.sku_key,
                    title: `${extractColor(row.product_name)} / ${row.size}`,
                    size: row.size,
                    color: extractColor(row.product_name),
                    price: 999,
                    compare_at_price: null,
                    stock: qty,
                    reorder_level: reorder,
                    stock_status: qty <= 0 ? 'out_of_stock' : (reorder > 0 && qty <= reorder ? 'low_stock' : 'in_stock'),
                    active: true,
                    available: qty > 0
                };
            }
        } catch (err) {
            console.warn('⚠️ Direct DB SKU lookup warning:', err.message);
        }
    }

    if (!matchedVariant) {
        return {
            found: false,
            sku: sku,
            message: `SKU '${sku}' not found in active catalog or inventory.`,
            data_as_of: timestamp
        };
    }

    return {
        found: true,
        sku: matchedVariant.sku,
        product_name: matchedProduct ? matchedProduct.title : 'Product',
        product_id: matchedProduct ? matchedProduct.id : null,
        category: matchedProduct ? matchedProduct.category : 'Apparel',
        product_status: matchedProduct ? matchedProduct.status : 'active',
        variant_id: matchedVariant.id,
        variant_title: matchedVariant.title,
        size: matchedVariant.size,
        color: matchedVariant.color,
        price: matchedVariant.price,
        compare_at_price: matchedVariant.compare_at_price,
        stock: matchedVariant.stock,
        reorder_level: matchedVariant.reorder_level,
        stock_status: matchedVariant.stock_status,
        active: matchedVariant.active !== false,
        available: matchedVariant.available !== false && matchedVariant.stock > 0,
        mapping: {
            product: matchedProduct ? matchedProduct.title : 'Product',
            variant: matchedVariant.title,
            sku: matchedVariant.sku,
            size: matchedVariant.size,
            color: matchedVariant.color,
            price: matchedVariant.price,
            stock: matchedVariant.stock,
            status: matchedVariant.stock_status
        },
        data_as_of: timestamp
    };
}

/**
 * Search products by query string with relevance ranking.
 */
async function searchProducts({ query, limit = 10 } = {}) {
    const catalog = await getUnifiedProductCatalog();
    const timestamp = getIstTimestamp();

    if (!query || !String(query).trim()) {
        return {
            products: catalog.slice(0, limit),
            total_matches: catalog.length,
            data_as_of: timestamp
        };
    }

    const q = String(query).trim().toLowerCase();
    const qClean = cleanSkuAlphanumeric(q);

    const matches = [];

    for (const p of catalog) {
        let score = 0;
        const pTitle = p.title.toLowerCase();

        if (pTitle === q) score += 100;
        else if (pTitle.startsWith(q)) score += 50;
        else if (pTitle.includes(q)) score += 30;

        // Check variants
        for (const v of p.variants) {
            const vSku = normalizeSku(v.sku);
            const vClean = cleanSkuAlphanumeric(v.sku);
            if (vSku === q || (qClean && vClean === qClean)) {
                score += 80;
            } else if (vSku.includes(q)) {
                score += 40;
            }
            if (v.title.toLowerCase().includes(q)) {
                score += 20;
            }
        }

        if (score > 0) {
            matches.push({ product: p, score });
        }
    }

    matches.sort((a, b) => b.score - a.score);
    const results = matches.slice(0, limit).map(m => m.product);

    return {
        query,
        products: results,
        total_matches: matches.length,
        data_as_of: timestamp
    };
}

/**
 * Format a human-readable summary of product/variant info for AI Copilot responses.
 */
function formatProductSummary(info) {
    if (!info || !info.found) {
        return `[VERIFIED FACT] Product or SKU not found. ${info?.message || ''} (Data as of: ${info?.data_as_of || 'Live'})`;
    }

    if (info.product) {
        const p = info.product;
        const variantLines = p.variants.map(v => 
            `- Size ${v.size} (${v.color}): ₹${v.price} | Stock: ${v.stock} units [${v.stock_status.toUpperCase()}] (SKU: ${v.sku || 'N/A'})`
        ).join('\n');

        return `[VERIFIED FACT] Product: ${p.title}
Status: ${p.status ? p.status.toUpperCase() : 'ACTIVE'} | Category: ${p.category || 'Apparel'}
Total Stock: ${p.total_stock} units across ${p.variants.length} variants
Available Sizes: ${p.sizes.join(', ')}
Available Colours: ${p.colors.join(', ')}

Variants & Availability:
${variantLines}

(Data as of: ${info.data_as_of} — Live Database)`;
    }

    if (info.mapping) {
        const m = info.mapping;
        return `[VERIFIED FACT] SKU: ${m.sku}
Product: ${m.product}
Variant: ${m.variant} (Size: ${m.size}, Colour: ${m.color})
Price: ₹${m.price}
Live Stock: ${m.stock} units
Stock Status: ${m.status.toUpperCase()}${info.reorder_level > 0 ? ` (Reorder Level: ${info.reorder_level})` : ''}
(Data as of: ${info.data_as_of} — Live Database)`;
    }

    return JSON.stringify(info);
}

module.exports = {
    getUnifiedProductCatalog,
    getProductInfo,
    getVariantBySku,
    searchProducts,
    formatProductSummary,
    normalizeSku,
    extractColor,
    getIstTimestamp
};
