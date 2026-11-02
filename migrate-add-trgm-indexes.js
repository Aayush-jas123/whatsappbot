#!/usr/bin/env node
/**
 * Migration: Add pg_trgm indexes for slow LIKE queries
 * 
 * Problem queries from production logs:
 * 1. 5.3s: SELECT COUNT(DISTINCT s.order_id) FROM store_shoppers WHERE phone LIKE '%...%'
 * 2. 1.6s: support_tickets queries with customer_phone LIKE '%...%'
 * 3. 1.3s: SELECT DISTINCT order_id FROM store_shoppers WHERE phone LIKE '%...%'
 * 
 * Solution: Use pg_trgm extension with GIN indexes for fast LIKE/ILIKE searches
 * 
 * Usage: node migrate-add-trgm-indexes.js
 */

require('dotenv').config();
const { pool } = require('./src/database/db');

async function migrate() {
    console.log('🚀 Starting pg_trgm index migration...\n');

    try {
        // Step 1: Enable pg_trgm extension
        console.log('📦 Enabling pg_trgm extension...');
        await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
        console.log('✅ pg_trgm extension enabled\n');

        // Step 2: Create GIN indexes for store_shoppers table
        console.log('🔍 Creating indexes for store_shoppers...');
        
        // Index for phone searches (used in shoppers list and chat unread queries)
        console.log('  - Creating idx_store_shoppers_phone_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_store_shoppers_phone_trgm 
            ON store_shoppers USING gin (phone gin_trgm_ops)
        `);
        
        // Index for name searches
        console.log('  - Creating idx_store_shoppers_name_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_store_shoppers_name_trgm 
            ON store_shoppers USING gin (name gin_trgm_ops)
        `);
        
        // Index for order_id searches
        console.log('  - Creating idx_store_shoppers_order_id_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_store_shoppers_order_id_trgm 
            ON store_shoppers USING gin (order_id gin_trgm_ops)
        `);
        
        console.log('✅ store_shoppers indexes created\n');

        // Step 3: Create GIN indexes for support_tickets table
        console.log('🔍 Creating indexes for support_tickets...');
        
        // Index for customer_phone searches
        console.log('  - Creating idx_support_tickets_customer_phone_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_tickets_customer_phone_trgm 
            ON support_tickets USING gin (customer_phone gin_trgm_ops)
        `);
        
        // Index for customer_name searches
        console.log('  - Creating idx_support_tickets_customer_name_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_tickets_customer_name_trgm 
            ON support_tickets USING gin (customer_name gin_trgm_ops)
        `);
        
        // Index for ticket_number searches
        console.log('  - Creating idx_support_tickets_ticket_number_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_support_tickets_ticket_number_trgm 
            ON support_tickets USING gin (ticket_number gin_trgm_ops)
        `);
        
        console.log('✅ support_tickets indexes created\n');

        // Step 4: Create GIN indexes for messages table
        console.log('🔍 Creating indexes for messages...');
        
        // Index for customer_phone searches (used in conversation thread queries)
        console.log('  - Creating idx_messages_customer_phone_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_customer_phone_trgm 
            ON messages USING gin (customer_phone gin_trgm_ops)
        `);
        
        console.log('✅ messages indexes created\n');

        // Step 5: Create GIN indexes for orders table
        console.log('🔍 Creating indexes for orders...');
        
        // Index for customer_phone searches
        console.log('  - Creating idx_orders_customer_phone_trgm...');
        await pool.query(`
            CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_customer_phone_trgm 
            ON orders USING gin (customer_phone gin_trgm_ops)
        `);
        
        console.log('✅ orders indexes created\n');

        // Step 6: Verify indexes were created
        console.log('🔍 Verifying indexes...');
        const { rows } = await pool.query(`
            SELECT indexname, tablename 
            FROM pg_indexes 
            WHERE indexname LIKE '%_trgm'
            ORDER BY tablename, indexname
        `);
        
        console.log(`\n✅ Created ${rows.length} trigram indexes:`);
        for (const row of rows) {
            console.log(`  - ${row.indexname} on ${row.tablename}`);
        }

        console.log('\n🎉 Migration completed successfully!');
        console.log('\n📊 Expected performance improvements:');
        console.log('  - store_shoppers phone/name/order_id LIKE queries: ~1300ms → ~50ms');
        console.log('  - support_tickets customer_phone/name LIKE queries: ~1600ms → ~100ms');
        console.log('  - messages customer_phone LIKE queries: ~1600ms → ~100ms');
        console.log('  - COUNT(DISTINCT order_id) with search: ~5300ms → ~200ms');

    } catch (error) {
        console.error('\n❌ Migration failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Run migration
migrate();
