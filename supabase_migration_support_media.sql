-- ============================================================
-- Support Media Pipeline ▸ lifecycle table
--
-- One row per support image across ALL three surfaces (website
-- Help & Tickets, internal Support Desk, WhatsApp/Instagram
-- portal). Replaces the silent-catch server-proxy upload path:
-- media now uploads straight from the browser to a DEDICATED
-- support Cloudinary account and this table tracks its full
-- lifecycle (upload progress → send → carrier delivery receipts
-- → seen → 45-day retention purge).
--
-- Runs against the shared Supabase Postgres used by whatsappbot
-- (the same pooler DB that holds support_tickets and messages).
-- Every statement is idempotent. The app ALSO self-heals this
-- table at boot (initializeSupportMediaTable in src/database/db.js),
-- so this file is optional — paste it in the Supabase SQL Editor
-- when you want the schema in place before the next deploy.
-- ============================================================

CREATE TABLE IF NOT EXISTS support_media (
  id              SERIAL PRIMARY KEY,
  -- Immutable Cloudinary public_id assigned server-side at intent
  -- time. The browser cannot choose it (pinned into the signature).
  public_id       VARCHAR(300) NOT NULL UNIQUE,
  channel         VARCHAR(20) NOT NULL,          -- website | whatsapp | instagram
  ticket_ref      VARCHAR(100),                  -- ticket_number or portal slug
  direction       VARCHAR(10) NOT NULL,          -- incoming | outgoing
  actor           VARCHAR(100),                  -- phone, agent name, 'customer'
  mime_type       VARCHAR(100),
  file_size       INTEGER,
  width           INTEGER,
  height          INTEGER,
  secure_url      TEXT,                          -- NULL once purged
  thumbnail_url   TEXT,                          -- NULL once purged
  -- Full lifecycle. pending|uploading|uploaded|sending|sent|
  -- delivered|read|seen|failed|expired
  upload_status   VARCHAR(30) DEFAULT 'pending',
  -- Carrier-backed receipts only (WhatsApp webhook). NULL for
  -- website/instagram where receipts don't exist.
  delivery_status VARCHAR(30),
  wa_message_id   VARCHAR(200),                  -- correlation to the WhatsApp status webhook
  thread_entry_idx INTEGER,                      -- index within support_tickets.thread (website only)
  -- Soft link to the portal/whatsapp messages row. No hard FK: this
  -- table is written from webhook paths where the message may be
  -- absent, and referential integrity adds no value to retention.
  message_id      INTEGER,
  retention_due_at TIMESTAMP,                    -- final closure + 45 days; NULL while ticket is open
  purged_at      TIMESTAMP,                      -- set when the Cloudinary asset is destroyed
  error_text     TEXT,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Hot paths: media hydrate per ticket, webhook status update by
-- wa_message_id, and the nightly retention sweep.
CREATE INDEX IF NOT EXISTS idx_media_ticket    ON support_media(ticket_ref);
CREATE INDEX IF NOT EXISTS idx_media_public    ON support_media(public_id);
CREATE INDEX IF NOT EXISTS idx_media_wa_msg    ON support_media(wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_retention ON support_media(retention_due_at) WHERE purged_at IS NULL;

-- ------------------------------------------------------------
-- Check your work
-- ------------------------------------------------------------
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'support_media'
ORDER BY ordinal_position;
