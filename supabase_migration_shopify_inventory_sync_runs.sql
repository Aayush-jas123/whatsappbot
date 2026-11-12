-- Shopify ⇄ Stock Room two-way inventory sync — run audit table.
-- One row per sync operation: workbench pulls, workbench pushes, and
-- Bulk In/Out mirrors to Shopify. The Shoppers Hub sync history tab
-- reads this table; the push job runner writes start + finish rows.
--
-- The app also creates this table automatically at startup
-- (src/database/db.js → initializeManualInventoryTables), so running this
-- file is only needed to provision a database ahead of the first deploy.

CREATE TABLE IF NOT EXISTS shopify_inventory_sync_runs (
  id SERIAL PRIMARY KEY,
  direction VARCHAR(12) NOT NULL,          -- 'pull' | 'push' | 'push_delta'
  mode VARCHAR(12),                        -- pull: 'match' | 'fill_zero' | 'new_only'; push: 'absolute' | 'delta'
  status VARCHAR(12) NOT NULL DEFAULT 'running', -- 'running' | 'done' | 'cancelled' | 'failed'
  skus_total INTEGER DEFAULT 0,
  skus_applied INTEGER DEFAULT 0,
  skus_failed INTEGER DEFAULT 0,
  units_delta INTEGER DEFAULT 0,
  detail JSONB,                            -- per-SKU result sample (failures for pulls, last writes for pushes)
  reference VARCHAR(120),
  performed_by VARCHAR(100),
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shopify_sync_runs_created
  ON shopify_inventory_sync_runs(id DESC);
