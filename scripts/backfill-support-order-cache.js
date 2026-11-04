/**
 * Backfill support_order_cache from Shopify for every whitelisted customer.
 *
 * The desk and the storefront "Help & Tickets" tab both read orders from the
 * local cache table, which is normally kept fresh by the Shopify order
 * webhooks. This script populates it for phones added before the webhooks were
 * registered (or after a cache reset).
 *
 * Usage (from whatsappbot-main):
 *   node scripts/backfill-support-order-cache.js
 *
 * Requires SUPABASE_DB_URL, SHOPIFY_STORE (or SHOPIFY_SHOP_URL) and
 * SHOPIFY_ACCESS_TOKEN in .env.
 *
 * 1. Reads all phones from support_whitelist
 * 2. Resolves each phone to its Shopify customer and fetches their orders
 * 3. Upserts every order into support_order_cache (stage/payment/courier computed)
 */
require('dotenv').config();

const SupportSync = require('../src/services/supportSync');
const { pool } = require('../src/database/db');

const SHOP = process.env.SHOPIFY_SHOP_URL || process.env.SHOPIFY_STORE;

async function main() {
    if (!SHOP || !process.env.SHOPIFY_ACCESS_TOKEN) {
        console.error('Missing SHOPIFY_STORE/SHOPIFY_SHOP_URL or SHOPIFY_ACCESS_TOKEN in .env.');
        process.exit(1);
    }

    console.log(`Backfilling support order cache for whitelisted customers (shop: ${SHOP})...\n`);

    const { customers, results } = await SupportSync.syncAllWhitelisted();
    if (!customers) {
        console.log('Nothing to do — add phones to support_whitelist first (desk > Settings > Access).');
        return;
    }

    let total = 0;
    let failed = 0;
    for (const r of results) {
        if (r.error) {
            failed++;
            console.error(`  ${r.phone || '?'}: FAILED — ${r.error}`);
            continue;
        }
        total += r.orders || 0;
        console.log(`  ${r.phone}: ${r.orders} orders ${r.note ? '(' + r.note + ')' : ''}`);
    }

    console.log(`\nDone — ${customers} customer(s) processed, ${total} order(s) cached, ${failed} failure(s).`);
}

main()
    .catch(err => { console.error('Backfill failed:', err); process.exitCode = 1; })
    .finally(() => { pool.end().catch(() => {}); });
