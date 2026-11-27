// One-time backfill: store_shoppers.confirmed_by_operator
//
// The column is stamped automatically by the hub write paths from the deploy
// forward (POST /shoppers/:id/status and the item-request apply). Everything
// confirmed before that has no operator on the row, but the hub activity log
// recorded "Shopper <id> → <status>" for every OPERATOR action, so those rows can
// be attributed after the fact.
//
// What this deliberately cannot recover: master-admin actions were never written
// to hub_operator_activity (logOperatorActivity returns early unless
// role === 'operator'), so owner-made confirms stay NULL and show up in the
// analytics as "unrecorded". They are NOT attributed to a guess.
//
//   node backfill-confirmed-by-operator.js            # dry run, reports only
//   node backfill-confirmed-by-operator.js --apply    # writes
//
// Idempotent: only touches rows where confirmed_by_operator IS NULL, so a re-run
// never overwrites a value the app stamped itself.
require('dotenv').config();
const { Client } = require('pg');

const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

// Last recorded status action per shopper wins: a row confirmed by one operator
// and re-confirmed by another should carry the person who actually left it
// confirmed. `store_shoppers.id` is text (shop_<epoch>_<rand>), not an integer.
const MAPPING_SQL = `
    WITH ranked AS (
        SELECT regexp_replace(detail, '^Shopper (.+) → [a-z_]+$', '\\1') AS shopper_id,
               username,
               ROW_NUMBER() OVER (
                   PARTITION BY regexp_replace(detail, '^Shopper (.+) → [a-z_]+$', '\\1')
                   ORDER BY created_at DESC, id DESC
               ) AS rn
        FROM hub_operator_activity
        WHERE action = 'status_update'
          AND detail ~ '^Shopper .+ → (confirmed|cancelled|edit_details|pending)$'
          AND username IS NOT NULL
    )
    SELECT shopper_id, username FROM ranked WHERE rn = 1
`;

async function tableHasColumn(client, table, column) {
    const r = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, column]
    );
    return r.rows.length > 0;
}

(async () => {
    const client = new Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
    await client.connect();
    // Backfill is bounded by row count, not the app's 30s session default.
    await client.query("SET statement_timeout = '120s'");

    if (!(await tableHasColumn(client, 'store_shoppers', 'confirmed_by_operator'))) {
        console.error('ABORT: store_shoppers.confirmed_by_operator does not exist yet.');
        console.error('Deploy the app first — db.js creates the column at boot.');
        await client.end();
        process.exit(1);
    }

    const existing = await client.query(
        `SELECT COUNT(*)::int AS n FROM store_shoppers WHERE confirmed_by_operator IS NOT NULL`
    );
    console.log(`rows already stamped: ${existing.rows[0].n}`);

    const map = await client.query(MAPPING_SQL);
    const byActor = new Map();
    for (const r of map.rows) {
        if (!r.shopper_id || r.shopper_id === r.username) continue; // unmatched regex
        if (!byActor.has(r.username)) byActor.set(r.username, []);
        byActor.get(r.username).push(r.shopper_id);
    }
    const targets = [...byActor.entries()].sort((a, b) => b[1].length - a[1].length);
    console.log(`activity log maps ${map.rows.length} shoppers across ${targets.length} operator handles:`);
    targets.forEach(([u, ids]) => console.log(`  - ${u}: ${ids.length}`));

    if (!APPLY) {
        console.log('\nDRY RUN — nothing written. Re-run with --apply to backfill.');
        await client.end();
        return;
    }

    let updated = 0;
    let scanned = 0;
    for (const [username, ids] of targets) {
        for (let i = 0; i < ids.length; i += BATCH) {
            const chunk = ids.slice(i, i + BATCH);
            const res = await client.query(
                `UPDATE store_shoppers
                    SET confirmed_by_operator = $1
                  WHERE id = ANY($2::text[])
                    AND confirmed_by_operator IS NULL`,
                [username, chunk]
            );
            scanned += chunk.length;
            updated += res.rowCount;
            process.stdout.write(`\r  ${username}: ${updated} rows written (${scanned} candidates)   `);
        }
    }
    console.log('\n');

    const after = await client.query(`
        SELECT COUNT(*)::int                                                          AS confirmed_rows,
               COUNT(*) FILTER (WHERE confirmed_by_operator IS NOT NULL)::int         AS attributed,
               COUNT(*) FILTER (WHERE confirmed_by = 'manual' AND confirmed_by_operator IS NULL)::int AS manual_unrecorded
        FROM store_shoppers WHERE status = 'confirmed'
    `);
    console.log('post-backfill coverage:', JSON.stringify(after.rows[0]));
    console.log(`manual_unrecorded are master-admin confirms (never logged) plus pre-Aug-2026 history.`);

    await client.end();
})().catch(e => { console.error('\nBACKFILL FAILED:', e.message); process.exit(1); });
