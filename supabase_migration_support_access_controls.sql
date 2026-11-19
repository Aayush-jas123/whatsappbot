-- ============================================================
-- Support Desk ▸ Access tab: expiry, access level and provenance
--
-- The whitelist (support_whitelist) is the only gate on the
-- storefront "Help & Tickets" tab. The Access console now drives it
-- from segments and bulk actions, which need three more columns per
-- grant plus one settings row for the policy.
--
-- Runs against the shared Supabase Postgres used by whatsappbot —
-- the same database supabase_migration_website_support_tickets.sql
-- created. Every statement is idempotent: re-running the file, or
-- running it after the app has already self-healed these columns at
-- boot, is a no-op.
--
-- The app adds the columns itself on startup, so this file is
-- optional. Paste it in the Supabase SQL Editor (whole file at once
-- is safe) when you want the schema in place before the next deploy.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Per-grant controls on the whitelist
--    expires_at   NULL = the grant never expires
--    access_level 'full' may raise tickets, 'view' can only read
--    source       how the row got there (manual, import, auto-ticket,
--                 segment:<id>, desk …) so the list stays auditable
-- ------------------------------------------------------------
ALTER TABLE support_whitelist ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
ALTER TABLE support_whitelist ADD COLUMN IF NOT EXISTS access_level VARCHAR(20) DEFAULT 'full';
ALTER TABLE support_whitelist ADD COLUMN IF NOT EXISTS source VARCHAR(40) DEFAULT 'manual';

-- Rows created before the ALTER above (defaults only apply to inserts).
UPDATE support_whitelist SET access_level = 'full' WHERE access_level IS NULL;
UPDATE support_whitelist SET source = 'manual' WHERE source IS NULL;

-- Anything else in the column would break the check below, and 'full' is
-- the strictest interpretation of an unknown level. Keep this line ahead
-- of the constraint.
UPDATE support_whitelist
   SET access_level = 'full'
 WHERE access_level NOT IN ('full', 'view');

DO $$
BEGIN
  -- Constraints are catalogued in pg_constraint, not by SQLSTATE, so this is
  -- the form that stays idempotent across Postgres versions.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_whitelist_access_level_chk') THEN
    ALTER TABLE support_whitelist
      ADD CONSTRAINT support_whitelist_access_level_chk
      CHECK (access_level IS NULL OR access_level IN ('full', 'view'));
  END IF;
END $$;

-- The console filters an expiring list on every page load and prunes expired
-- grants on demand; only the dated rows matter, so the index stays partial.
CREATE INDEX IF NOT EXISTS idx_support_whitelist_expires
  ON support_whitelist (expires_at)
  WHERE expires_at IS NOT NULL;

-- ------------------------------------------------------------
-- 2. One-off hygiene: canonicalize legacy phone spellings
--
-- Historic rows were written straight from the desk input, so the same
-- person can exist as '9876543210', '09876543210', '+91 98765 43210' and
-- '919876543210'. The console compares normalized phones, so those rows
-- silently stop matching their customer. This collapses duplicates
-- (oldest row wins) and rewrites the survivors to 91XXXXXXXXXX.
--
-- The CASE mirrors the three rules in supportService.normalizePhone. It is
-- inlined twice rather than installed as a helper, so the file leaves no
-- objects behind when it finishes.
-- ------------------------------------------------------------

-- Keep the oldest row for each normalized number, drop the rest. The CTE is
-- snapped before the DELETE runs, so survivors are judged from one view.
WITH n AS (
  SELECT id, created_at,
         CASE
           WHEN LENGTH(d) = 10                        THEN '91' || d
           WHEN LENGTH(d) = 11 AND LEFT(d, 1) = '0'   THEN '91' || SUBSTRING(d FROM 2)
           WHEN LENGTH(d) > 12 AND LEFT(d, 4) = '0091' THEN '91' || SUBSTRING(d FROM 5)
           ELSE d
         END AS norm
  FROM (SELECT id, created_at,
               REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') AS d
        FROM support_whitelist) raw
), dups AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY norm ORDER BY created_at ASC NULLS LAST, id ASC) AS rn
  FROM n
  WHERE norm ~ '^91[0-9]{10}$'
)
DELETE FROM support_whitelist w
USING dups d
WHERE d.id = w.id
  AND d.rn > 1;

-- Rewrite what is left. Anything that does not normalize to a valid Indian
-- mobile is deliberately untouched — the console lists those rows under
-- "Unmatched numbers" and lets the desk decide.
WITH n AS (
  SELECT id,
         CASE
           WHEN LENGTH(d) = 10                        THEN '91' || d
           WHEN LENGTH(d) = 11 AND LEFT(d, 1) = '0'   THEN '91' || SUBSTRING(d FROM 2)
           WHEN LENGTH(d) > 12 AND LEFT(d, 4) = '0091' THEN '91' || SUBSTRING(d FROM 5)
           ELSE d
         END AS norm
  FROM (SELECT id,
               REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g') AS d
        FROM support_whitelist) raw
)
UPDATE support_whitelist w
   SET phone = n.norm
  FROM n
 WHERE n.id = w.id
   AND w.phone <> n.norm
   AND n.norm ~ '^91[0-9]{10}$';

-- ------------------------------------------------------------
-- 3. Access policy (support_settings key 'access')
--    Seeded with the application defaults so the toggles are visible
--    and editable immediately. DO NOTHING: never overwrite a policy
--    an admin has already changed.
--
--    mode                    whitelist | open | closed
--    defaultDays             0 = grants never expire
--    defaultLevel            full | view
--    syncOnGrant             pull Shopify orders when a number is added
--    verifyBeforeGrant       skip numbers seen in no ticket/order/shopper
--    autoGrantNewTickets     add a customer automatically when they write in
--    autoGrantChannel        website | any
--    dormantRevokeDays       0 = off; feeds the dormant segment + cleanup
--    agentMayGrant           desk agents may change the list
--    webhookCacheFollowsList only cache orders for listed numbers
-- ------------------------------------------------------------
INSERT INTO support_settings (key, value) VALUES
('access', '{"mode":"whitelist","defaultDays":0,"defaultLevel":"full","syncOnGrant":true,"verifyBeforeGrant":false,"autoGrantNewTickets":false,"autoGrantChannel":"website","dormantRevokeDays":0,"agentMayGrant":true,"webhookCacheFollowsList":true}')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- 4. Check your work
-- ------------------------------------------------------------
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'support_whitelist'
ORDER BY ordinal_position;

SELECT COUNT(*) AS grants,
       COUNT(*) FILTER (WHERE expires_at IS NOT NULL) AS dated,
       COUNT(*) FILTER (WHERE access_level = 'view') AS read_only,
       COUNT(*) FILTER (WHERE phone !~ '^91[0-9]{10}$') AS still_nonstandard
FROM support_whitelist;
