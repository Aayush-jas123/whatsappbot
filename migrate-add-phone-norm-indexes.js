#!/usr/bin/env node
/**
 * Migration: normalized-phone expression indexes for the Access-tab aggregates
 *
 * Problem queries from the Nov 23 production logs (whatsappbot-main):
 *   22904ms: WITH seg AS (SELECT DISTINCT ... REGEXP_REPLACE ...
 *    9040ms: SELECT COUNT(DISTINCT (CASE WHEN LENGTH(REGEXP_REPLACE(COALESCE(phone ...
 *    8846ms: SELECT COUNT(*)::int AS granted_invalid FROM support_whitelist w LEFT JOIN ...
 *   3472ms: SELECT COUNT(*) AS granted_dormant FROM support_whitelist w LEFT JOIN ...
 * All of them re-scan support_tickets / support_order_cache / store_shoppers
 * because the phone-normalization CASE + REGEXP_REPLACE is computed per row
 * and cannot be indexed.
 *
 * Solution: mirror supportAccessService.normSql() in an IMMUTABLE SQL function
 * (digit-stripping an ASCII pattern is deterministic) and build b-tree
 * expression indexes on it, so the aggregates can run as index-only scans.
 * Same DDL as initializePerformanceIndexes() in src/database/db.js; the
 * CONCURRENTLY builds here avoid blocking writes on the bigger tables.
 *
 * Usage: node migrate-add-phone-norm-indexes.js
 */

require('dotenv').config();
const { pool } = require('./src/database/db');

async function migrate() {
    console.log('🚀 Starting normalized-phone index migration...\n');

    try {
        // Step 1: the immutable normalization function
        console.log('📦 Creating support_normalize_phone()...');
        await pool.query(`
            CREATE OR REPLACE FUNCTION support_normalize_phone(raw text)
            RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
                SELECT CASE
                    WHEN LENGTH(d) = 10 THEN '91' || d
                    WHEN LENGTH(d) = 11 AND LEFT(d, 1) = '0' THEN '91' || SUBSTRING(d FROM 2)
                    WHEN LENGTH(d) > 12 AND LEFT(d, 4) = '0091' THEN '91' || SUBSTRING(d FROM 5)
                    ELSE d
                END
                FROM (SELECT REGEXP_REPLACE(COALESCE(raw, ''), '[^0-9]', '', 'g') AS d) q
            $fn$
        `);
        console.log('✅ support_normalize_phone() created\n');

        // Sanity check: the function must return the same shape normSql promised.
        const { rows: probe } = await pool.query(`
            SELECT support_normalize_phone('9876543210')  AS ten,
                   support_normalize_phone('09876543210') AS lead0,
                   support_normalize_phone('+91 98765 43210') AS spaced,
                   support_normalize_phone('00919876543210') AS dd
        `);
        const p = probe[0];
        if (p.ten !== '919876543210' || p.lead0 !== p.ten || p.spaced !== p.ten || p.dd !== p.ten) {
            throw new Error('support_normalize_phone() probe mismatch: ' + JSON.stringify(p));
        }
        console.log('✅ Function probe matched (all spellings -> 919876543210)\n');

        // Step 2: expression indexes (CONCURRENTLY — no write locks)
        console.log('🔍 Building idx_support_tickets_phone_norm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_tickets_phone_norm
            ON support_tickets ((support_normalize_phone(customer_phone)))
            INCLUDE (status, priority, team, reason, sub, customer_name, created_at)
        `);

        console.log('🔍 Building idx_support_order_cache_phone_norm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_order_cache_phone_norm
            ON support_order_cache ((support_normalize_phone(customer_phone)))
            INCLUDE (stage, placed_at, total, payment)
        `);

        console.log('🔍 Building idx_store_shoppers_phone_norm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_store_shoppers_phone_norm
            ON store_shoppers ((support_normalize_phone(phone)))
            INCLUDE (name, created_at)
        `);

        console.log('✅ Indexes built\n');

        // Step 3: verify + adoption check. An index the planner ignores is
        // dead weight, so EXPLAIN the two worst logged shapes and report.
        console.log('🔍 Verifying indexes...');
        const { rows: found } = await pool.query(`
            SELECT indexname FROM pg_indexes
            WHERE indexname IN ('idx_support_tickets_phone_norm',
                                'idx_support_order_cache_phone_norm',
                                'idx_store_shoppers_phone_norm')
            ORDER BY indexname
        `);
        console.log(`\n✅ ${found.length}/3 phone-norm indexes present:`);
        for (const r of found) console.log(`  - ${r.indexname}`);

        console.log('\n🔍 Planner adoption (EXPLAIN, top of plan):');
        for (const [label, sql] of [
            ['COUNT(DISTINCT norm) support_tickets',
                "EXPLAIN SELECT COUNT(DISTINCT support_normalize_phone(customer_phone)) FROM support_tickets"],
            ['COUNT(DISTINCT norm) store_shoppers',
                "EXPLAIN SELECT COUNT(DISTINCT support_normalize_phone(phone)) FROM store_shoppers WHERE support_normalize_phone(phone) ~ '^91[0-9]{10}$'"],
        ]) {
            const { rows: plan } = await pool.query(sql);
            const head = plan.map(r => r['QUERY PLAN'][0]).filter(Boolean).join(' | ');
            const adopted = /phone_norm/.test(plan.map(r => r['QUERY PLAN'].join(' ')).join(' '));
            console.log(`  ${adopted ? '✅' : '⚠️'} ${label}: ${head}`);
        }

        console.log('\n🎉 Migration complete.');
        console.log('⚠️ If a plan above shows ⚠️ (Seq Scan instead of the phone_norm index),');
        console.log('   run VACUUM ANALYZE on the table and re-check before trusting the win.');

    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
        // db.js timers keep the event loop alive after pool.end()
        process.exit(0);
    }
}

// Run migration
migrate();
