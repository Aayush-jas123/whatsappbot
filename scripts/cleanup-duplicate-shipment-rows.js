/**
 * Revert the duplicate shipment rows created by the 5-Nov bulk-ship stampede.
 *
 * When several bulk runs (or repeated clicks) hit the same order at once,
 * every parallel request used to pass the in-memory idempotency guard and
 * write its own 'failed' audit row — up to 16 rows per order. The ship()
 * flow now claims the order with a 'creating' row before calling the
 * carrier, so this can no longer happen; this script cleans up the fallout.
 *
 * Rule: for every 'failed' shipment row without an AWB, keep only the
 * newest row per order_id (the current state) and delete the older
 * duplicates. Rows with an AWB, cancelled/terminal rows and re-ship
 * lineage are never touched. The carrier side was verified clean for the
 * affected orders (one live waybill per order id), so no Delhivery
 * cancellations are needed.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-shipment-rows.js            # dry run
 *   node scripts/cleanup-duplicate-shipment-rows.js --apply    # delete
 */

require('dotenv').config();
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');

// Only clean the stampede window and later — anything before is normal history
const SINCE = process.env.CLEANUP_SINCE || '2026-11-05';

async function main() {
    const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
    await client.connect();

    const dupes = await client.query(
        `SELECT s.id, s.order_id, s.status, s.error_message,
                to_char(s.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
           FROM shipments s
          WHERE s.created_at > $1
            AND s.status = 'failed'
            AND s.awb IS NULL
            AND s.id NOT IN (
                SELECT MAX(id) FROM shipments
                 WHERE status = 'failed' AND awb IS NULL
                 GROUP BY order_id
            )
          ORDER BY s.order_id, s.id`,
        [SINCE]
    );

    const byOrder = new Map();
    for (const row of dupes.rows) {
        if (!byOrder.has(row.order_id)) byOrder.set(row.order_id, []);
        byOrder.get(row.order_id).push(row);
    }

    console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${dupes.rowCount} duplicate failed rows across ${byOrder.size} orders (since ${SINCE})`);
    for (const [orderId, rows] of [...byOrder.entries()].sort()) {
        const kept = await client.query(
            `SELECT id, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS t FROM shipments
              WHERE order_id = $1 AND status = 'failed' AND awb IS NULL
              ORDER BY id DESC LIMIT 1`,
            [orderId]
        );
        console.log(`  #${orderId}: delete ${rows.length} duplicate(s) [ids ${rows.map(r => r.id).join(', ')}], keep latest [${kept.rows[0]?.id ?? 'n/a'}]`);
    }

    if (!APPLY) {
        console.log('\nDry run only — re-run with --apply to delete.');
        await client.end();
        return;
    }

    const ids = dupes.rows.map(r => r.id);
    if (ids.length) {
        const del = await client.query(
            `DELETE FROM shipments
              WHERE id = ANY($1::int[])
                AND status = 'failed' AND awb IS NULL`,
            [ids]
        );
        console.log(`\nDeleted ${del.rowCount} duplicate shipment rows.`);
    }

    // Any stale 'creating' claims left from the incident window → close them
    const stale = await client.query(
        `UPDATE shipments
            SET status = 'failed',
                error_message = 'In-flight claim left by the bulk-ship stampede, closed by cleanup',
                updated_at = NOW()
          WHERE status = 'creating'
          RETURNING id, order_id`
    );
    if (stale.rowCount) console.log(`Closed ${stale.rowCount} stale 'creating' claim(s): ${stale.rows.map(r => r.id).join(', ')}`);

    await client.end();
}

main().catch(err => {
    console.error('Cleanup failed:', err.message);
    process.exit(1);
});
