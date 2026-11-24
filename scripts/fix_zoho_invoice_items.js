/**
 * Bulk fix: Update Zoho invoices from Sep 1 onwards to add missing item_ids
 * so inventory syncs correctly.
 * 
 * Strategy:
 * 1. Load all Zoho items once into memory (with pagination)
 * 2. Query local DB for invoices from Sep 1 onwards
 * 3. For each invoice, fetch from Zoho and check which line items are missing item_id
 * 4. For missing items, search the local item map using normalized name matching
 * 5. Update the invoice in Zoho with the correct item_ids
 * 
 * Matching is delegated to src/services/zohoItemResolver — the same rules the
 * live sync uses. This script used to carry its own matcher, which could not
 * read "BASE - SIZE / COLOUR", so the black side of every vest pack showed up
 * here as "could not find item" too.
 * 
 * Writes to accounting records are opt-in: it runs as a dry report unless you
 * pass --apply.
 * 
 * Usage: node scripts/fix_zoho_invoice_items.js [--apply] [--limit=N]
 */

require('dotenv').config();
const { dbAdapter } = require('../src/database/db');
const zohoService = require('../src/services/zohoService');
const { pickMatchingItem, isChargeLineName, normName } = require('../src/services/zohoItemResolver');

const START_DATE = process.env.FIX_START_DATE || '2026-09-01';
const APPLY = process.argv.includes('--apply');
const DRY_RUN = !APPLY;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || 0;

async function loadAllZohoItems() {
    console.log('\n📦 Loading all Zoho items into memory...');
    const items = [];
    let page = 1;
    const perPage = 200;

    while (true) {
        const result = await zohoService.searchItem({ per_page: perPage, page });
        if (!result || result.length === 0) break;
        items.push(...result);
        console.log(`  Loaded ${items.length} items...`);
        if (result.length < perPage) break;
        page++;
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`✅ Loaded ${items.length} Zoho items\n`);
    return { items };
}

async function main() {
    console.log(`\n🔧 ${DRY_RUN ? 'Reporting' : 'FIXING (writing)'} Zoho invoice item_ids from ${START_DATE} onwards\n`);

    // Load all Zoho items
    const { items: allItems } = await loadAllZohoItems();
    // What an EXISTING item_id points at — a line linked to the wrong item
    // deducts the wrong stock, which is worse than an unlinked line.
    const itemById = new Map(allItems.map(i => [String(i.item_id), i]));

    // Query invoices from local DB
    const syncLogs = await dbAdapter.query(`
        SELECT 
            shopify_order_id,
            zoho_invoice_id,
            original_payload
        FROM zoho_sync_log
        WHERE created_at >= $1
            AND status = 'synced'
            AND zoho_invoice_id IS NOT NULL
        ORDER BY created_at DESC
    `, [START_DATE]) || [];

    console.log(`Found ${syncLogs.length} invoices to check\n`);

    const stats = {
        total: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        itemsFixed: 0,
        mislinked: 0,
        unitsMislinked: 0,
        unitsLinked: 0
    };
    // Names with no catalog item under any spelling — these need a catalog row,
    // not a code fix, so they are collected and printed once at the end.
    const gaps = new Map();

    for (const log of syncLogs) {
        stats.total++;
        
        if (LIMIT > 0 && stats.total > LIMIT) {
            console.log(`\n⏸️  Reached limit of ${LIMIT} invoices`);
            break;
        }

        if (stats.total % 50 === 0) {
            console.log(`\nProgress: ${stats.total}/${syncLogs.length} (Updated: ${stats.updated}, Items fixed: ${stats.itemsFixed})\n`);
        }

        try {
            // Fetch invoice from Zoho
            const zohoInvoice = await zohoService.getInvoice(log.zoho_invoice_id);
            
            if (!zohoInvoice || !zohoInvoice.line_items) {
                stats.skipped++;
                continue;
            }

            // Classify every product line: already right / must be (re)linked /
            // no catalog item at all
            const linesToUpdate = [];
            for (const li of zohoInvoice.line_items) {
                const qty = parseFloat(li.quantity || 1) || 1;
                if (isChargeLineName(li.name)) continue;

                const item = pickMatchingItem(allItems, li.name);
                const current = li.item_id ? itemById.get(String(li.item_id)) : null;

                if (!item) {
                    if (!current) {
                        const g = gaps.get(li.name) || { units: 0, lines: 0 };
                        g.units += qty; g.lines++;
                        gaps.set(li.name, g);
                    }
                    continue;   // nothing to link it to — report, never guess
                }
                if (current && normName(current.name) === normName(item.name)) continue;   // already right

                stats[current ? 'mislinked' : 'itemsFixed']++;
                stats[current ? 'unitsMislinked' : 'unitsLinked'] += qty;
                linesToUpdate.push({
                    line_item_id: li.line_item_id,
                    item_id: item.item_id,
                    name: li.name,
                    qty,
                    zoho_item_name: item.name,
                    wasLinkedTo: current ? current.name : null
                });
            }

            if (linesToUpdate.length === 0) {
                stats.skipped++;
                continue;
            }

            const missing = linesToUpdate.filter(l => !l.wasLinkedTo).length;
            const wrong = linesToUpdate.length - missing;
            console.log(`\nOrder #${log.shopify_order_id} (Invoice ${log.zoho_invoice_id}):`);
            console.log(`  ${missing} line(s) not linked, ${wrong} line(s) linked to the WRONG item`);

            if (DRY_RUN) {
                for (const lu of linesToUpdate) {
                    console.log(`    [DRY RUN] ${lu.qty}u "${lu.name}" → item_id=${lu.item_id} "${lu.zoho_item_name}"${lu.wasLinkedTo ? ` (was "${lu.wasLinkedTo}")` : ''}`);
                }
                stats.updated++;
            } else {
                // Build the update payload with all line items
                const updatePayload = {
                    line_items: zohoInvoice.line_items.map(li => {
                        const update = linesToUpdate.find(lu => lu.line_item_id === li.line_item_id);
                        return {
                            line_item_id: li.line_item_id,
                            item_id: update ? update.item_id : li.item_id,
                            name: li.name,
                            description: li.description,
                            quantity: li.quantity,
                            rate: li.rate,
                            discount: li.discount || 0
                        };
                    }),
                    // Zoho requires a reason when updating sent invoices
                    reason: 'Fixing item_id linkage for inventory sync'
                };

                await zohoService.updateInvoice(log.zoho_invoice_id, updatePayload);
                console.log(`  ✅ Updated invoice with ${linesToUpdate.length} item_ids`);
                
                for (const lu of linesToUpdate) {
                    console.log(`    ✓ ${lu.qty}u "${lu.name}" → item_id=${lu.item_id} "${lu.zoho_item_name}"${lu.wasLinkedTo ? ` (was "${lu.wasLinkedTo}")` : ''}`);
                }

                stats.updated++;
            }

            // Rate limiting
            await new Promise(r => setTimeout(r, 150));
        } catch (err) {
            console.error(`  ❌ Error processing invoice ${log.zoho_invoice_id}: ${err.message}`);
            stats.errors++;
        }
    }

    console.log(`\n\n${'═'.repeat(60)}`);
    console.log(`${DRY_RUN ? '📋 Report complete (no writes — rerun with --apply)' : '✅ Fix complete!'}`);
    console.log(`   Total invoices: ${stats.total}`);
    console.log(`   Invoices with changes: ${stats.updated}`);
    console.log(`   Skipped (no issues): ${stats.skipped}`);
    console.log(`   Errors: ${stats.errors}`);
    console.log(`   Lines to link (missing item_id): ${stats.itemsFixed} lines / ${stats.unitsLinked} units`);
    console.log(`   Lines on the WRONG item: ${stats.mislinked} lines / ${stats.unitsMislinked} units`);

    if (gaps.size) {
        console.log(`\n   ⚠️  No Zoho catalog item for these line names (any spelling) —`);
        console.log(`      they can only be counted once the items exist:`);
        for (const [name, g] of [...gaps].sort((a, b) => b[1].units - a[1].units)) {
            console.log(`      ${g.units}u / ${g.lines} line(s)  "${name}"`);
        }
    }
    console.log(`${'═'.repeat(60)}\n`);

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
