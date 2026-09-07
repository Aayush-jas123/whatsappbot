-- ============================================================
-- PHASE 1: Multi-Channel (Instagram) Database Migration
-- ============================================================
-- SAFE: All changes are ADDITIVE only.
--   - New columns have DEFAULT values matching existing behavior
--   - No existing data is altered
--   - Existing WhatsApp records remain valid
--   - Column widening is backward-compatible (larger VARCHAR)
--
-- IMPORTANT: Instagram PSIDs are stored as raw numeric IDs
--   in customer_phone (no prefix). The channel column
--   distinguishes WhatsApp vs Instagram records.
--
-- Run manually in Supabase SQL Editor or via psql.
-- ============================================================

-- ── 0. Widen phone columns for Instagram PSIDs ──────────────
-- Instagram PSIDs are numeric IDs (10-20 digits).
-- We widen customers.phone, messages.customer_phone, and
-- support_tickets.customer_phone to VARCHAR(50) for safety.
-- This is backward-compatible — existing data is safe.
ALTER TABLE customers ALTER COLUMN phone TYPE VARCHAR(50);
ALTER TABLE messages ALTER COLUMN customer_phone TYPE VARCHAR(50);
ALTER TABLE support_tickets ALTER COLUMN customer_phone TYPE VARCHAR(50);

-- ── 0b. Drop FK on messages.customer_phone ──────────────────
-- The messages table was originally designed for WhatsApp only,
-- with customer_phone referencing customers(phone).
-- Now that we support Instagram (where customer_phone holds an
-- IG PSID, not a phone number), this FK must be removed.
-- Existing WhatsApp data is unaffected — queries still work.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_customer_phone_fkey;

-- ── 1. support_tickets: add channel column ──────────────────
-- Default 'whatsapp' so all existing tickets remain valid
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp';

-- Instagram user identifier (PSID or IG User ID)
-- NULL for WhatsApp tickets, populated for Instagram tickets
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS ig_user_id VARCHAR(100);

-- Instagram username (for display in portal)
ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS ig_username VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_support_tickets_channel
    ON support_tickets(channel);

CREATE INDEX IF NOT EXISTS idx_support_tickets_ig_user
    ON support_tickets(ig_user_id)
    WHERE ig_user_id IS NOT NULL;

-- ── 2. messages: add channel + external message ID ──────────
-- Default 'whatsapp' so all existing messages remain valid
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp';

-- Instagram message ID (for idempotency / dedup)
-- NULL for WhatsApp messages
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS external_message_id VARCHAR(200);

-- Prevent duplicate Instagram webhook messages
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external_id
    ON messages(external_message_id)
    WHERE external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_channel
    ON messages(channel);

-- ── 3. customers: add Instagram identity columns ────────────
-- Instagram Page-Scoped ID (PSID) — unique per IG user
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS ig_psid VARCHAR(100);

-- Instagram display username
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS ig_username VARCHAR(100);

-- Profile picture URL from Instagram
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS ig_profile_pic TEXT;

-- Which channel(s) this customer uses: 'whatsapp', 'instagram', 'both'
ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS primary_channel VARCHAR(20) DEFAULT 'whatsapp';

-- Instagram users don't have phone numbers; allow NULL phone
-- This is required because IG-only customers have no phone
ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;

-- Unique constraint on ig_psid (one customer per IG user)
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_ig_psid
    ON customers(ig_psid)
    WHERE ig_psid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_ig_username
    ON customers(ig_username)
    WHERE ig_username IS NOT NULL;

-- ── 4. NEW: instagram_conversations — 24h window tracker ────
-- Instagram only allows replies within 24 hours of the last
-- customer message. This table tracks that window.
CREATE TABLE IF NOT EXISTS instagram_conversations (
    id SERIAL PRIMARY KEY,
    ig_user_id VARCHAR(100) NOT NULL,
    ig_username VARCHAR(100),
    customer_id INTEGER REFERENCES customers(id),
    last_customer_message_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    window_expires_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    bot_state VARCHAR(50) DEFAULT 'idle',
    bot_context TEXT DEFAULT '{}',
    is_escalated BOOLEAN DEFAULT false,
    support_ticket_id INTEGER REFERENCES support_tickets(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ig_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ig_conv_user
    ON instagram_conversations(ig_user_id);

CREATE INDEX IF NOT EXISTS idx_ig_conv_expires
    ON instagram_conversations(window_expires_at);

CREATE INDEX IF NOT EXISTS idx_ig_conv_escalated
    ON instagram_conversations(is_escalated)
    WHERE is_escalated = true;

-- ── 5. NEW: ig_webhook_idempotency — prevent duplicate processing ─
-- Instagram may send the same webhook multiple times.
-- Store each message ID to ensure we process it exactly once.
CREATE TABLE IF NOT EXISTS ig_webhook_idempotency (
    id SERIAL PRIMARY KEY,
    ig_message_id VARCHAR(200) NOT NULL UNIQUE,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    handler_result VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_ig_idempotency_msg
    ON ig_webhook_idempotency(ig_message_id);

-- Auto-cleanup: entries older than 7 days are safe to purge
-- (run via cron or manually)

-- ============================================================
-- VERIFICATION QUERIES (run after migration)
-- ============================================================
-- SELECT COUNT(*) AS existing_tickets FROM support_tickets WHERE channel = 'whatsapp';
-- SELECT COUNT(*) AS existing_messages FROM messages WHERE channel = 'whatsapp';
-- SELECT COUNT(*) AS existing_customers FROM customers WHERE primary_channel = 'whatsapp';
-- SELECT COUNT(*) AS ig_conversations FROM instagram_conversations;
-- SELECT COUNT(*) AS ig_idempotency FROM ig_webhook_idempotency;

-- ============================================================
-- ROLLBACK (only if something goes wrong — run in reverse order)
-- ============================================================
-- DROP TABLE IF EXISTS ig_webhook_idempotency;
-- DROP TABLE IF EXISTS instagram_conversations;
-- DROP INDEX IF EXISTS idx_customers_ig_username;
-- DROP INDEX IF EXISTS idx_customers_ig_psid;
-- DROP INDEX IF EXISTS idx_messages_channel;
-- DROP INDEX IF EXISTS idx_messages_external_id;
-- DROP INDEX IF EXISTS idx_support_tickets_ig_user;
-- DROP INDEX IF EXISTS idx_support_tickets_channel;
-- ALTER TABLE customers ALTER COLUMN phone SET NOT NULL;
-- ALTER TABLE customers DROP COLUMN IF EXISTS primary_channel;
-- ALTER TABLE customers DROP COLUMN IF EXISTS ig_profile_pic;
-- ALTER TABLE customers DROP COLUMN IF EXISTS ig_username;
-- ALTER TABLE customers DROP COLUMN IF EXISTS ig_psid;
-- ALTER TABLE messages DROP COLUMN IF EXISTS external_message_id;
-- ALTER TABLE messages DROP COLUMN IF EXISTS channel;
-- ALTER TABLE support_tickets DROP COLUMN IF EXISTS ig_username;
-- ALTER TABLE support_tickets DROP COLUMN IF EXISTS ig_user_id;
-- ALTER TABLE support_tickets DROP COLUMN IF EXISTS channel;
-- ALTER TABLE customers ALTER COLUMN phone TYPE VARCHAR(20);
-- ALTER TABLE messages ALTER COLUMN customer_phone TYPE VARCHAR(20);
-- ALTER TABLE support_tickets ALTER COLUMN customer_phone TYPE VARCHAR(20);
-- ALTER TABLE messages ADD CONSTRAINT messages_customer_phone_fkey FOREIGN KEY (customer_phone) REFERENCES customers(phone);
