/**
 * Apply the website support schema migration to the Postgres database.
 *
 * Run it against SUPABASE_DB_URL (the pooler defined in .env) — that is the
 * project which holds support_tickets, requests and the other shared tables.
 *
 * Usage (from whatsappbot-main):
 *   node scripts/apply-website-support-migration.js
 *
 * The SQL file is idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), so it
 * is safe to re-run. It is executed as a single batch, which is why the file
 * must not be split on semicolons — dollar-quoted bodies would break.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('../src/database/db');

const SQL_FILE = path.join(__dirname, '..', 'supabase_migration_website_support_tickets.sql');

async function main() {
    const sql = fs.readFileSync(SQL_FILE, 'utf8');
    console.log(`Applying ${path.basename(SQL_FILE)} (${sql.length} bytes)...`);
    await pool.query(sql);
    console.log('Migration applied.');
}

main()
    .catch(err => { console.error('Migration failed:', err); process.exitCode = 1; })
    .finally(() => { pool.end().catch(() => {}); });
