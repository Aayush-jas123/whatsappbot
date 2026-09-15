-- ============================================================
-- Instagram Comments Automation — Database Migration
-- ============================================================
-- SAFE: All changes are ADDITIVE only.
--   - Two NEW tables, no existing tables are modified
--   - No existing data is touched
--   - Rollback is a simple DROP of the two new tables
--
-- Purpose:
--   1. instagram_comments      — stores every processed IG comment
--                                with intent classification and
--                                automation status for the Comments Center
--   2. ig_comment_idempotency  — prevents duplicate processing of the
--                                same comment webhook event (separate
--                                from the DM idempotency table)
--
-- Run manually in Supabase SQL Editor or via psql.
-- DO NOT run automatically — requires explicit approval.
-- ============================================================

-- ── 1. instagram_comments — comment records + intelligence ──
CREATE TABLE IF NOT EXISTS instagram_comments (
    id SERIAL PRIMARY KEY,
    comment_id VARCHAR(200) NOT NULL UNIQUE,
    media_id VARCHAR(200),
    media_permalink TEXT,
    media_caption TEXT,
    ig_user_id VARCHAR(100) NOT NULL,
    ig_username VARCHAR(100),
    comment_text TEXT NOT NULL,
    comment_timestamp TIMESTAMP,
    detected_intent VARCHAR(50),
    confidence DECIMAL(3,2),
    sentiment VARCHAR(20),
    automation_action VARCHAR(50),
    public_reply_sent BOOLEAN DEFAULT false,
    private_reply_sent BOOLEAN DEFAULT false,
    dm_started BOOLEAN DEFAULT false,
    status VARCHAR(30) DEFAULT 'new',
    ticket_id INTEGER REFERENCES support_tickets(id),
    conversation_id INTEGER REFERENCES instagram_conversations(id),
    handled_by VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ig_comments_comment_id
    ON instagram_comments(comment_id);

CREATE INDEX IF NOT EXISTS idx_ig_comments_status
    ON instagram_comments(status);

CREATE INDEX IF NOT EXISTS idx_ig_comments_intent
    ON instagram_comments(detected_intent);

CREATE INDEX IF NOT EXISTS idx_ig_comments_media
    ON instagram_comments(media_id);

CREATE INDEX IF NOT EXISTS idx_ig_comments_user
    ON instagram_comments(ig_user_id);

CREATE INDEX IF NOT EXISTS idx_ig_comments_created
    ON instagram_comments(created_at DESC);

-- ── 2. ig_comment_idempotency — dedup for comment events ────
-- Instagram may deliver the same comment webhook multiple times.
-- The comment ID is the idempotency key: first delivery wins,
-- subsequent deliveries are safely ignored.
CREATE TABLE IF NOT EXISTS ig_comment_idempotency (
    id SERIAL PRIMARY KEY,
    ig_comment_id VARCHAR(200) NOT NULL UNIQUE,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    handler_result VARCHAR(50)
);

CREATE INDEX IF NOT EXISTS idx_ig_comment_idem_id
    ON ig_comment_idempotency(ig_comment_id);

CREATE INDEX IF NOT EXISTS idx_ig_comment_idem_time
    ON ig_comment_idempotency(processed_at);

-- ============================================================
-- VERIFICATION QUERIES (run after migration)
-- ============================================================
-- SELECT COUNT(*) AS ig_comments FROM instagram_comments;
-- SELECT COUNT(*) AS ig_comment_idem FROM ig_comment_idempotency;

-- ============================================================
-- ROLLBACK (only if something goes wrong)
-- ============================================================
-- DROP TABLE IF EXISTS ig_comment_idempotency;
-- DROP TABLE IF EXISTS instagram_comments;
