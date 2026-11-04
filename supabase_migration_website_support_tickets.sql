-- ============================================================
-- Website Customer Support & Tickets (Help & Tickets tab)
-- Runs against the shared Supabase Postgres used by whatsappbot.
-- Extends support_tickets (WhatsApp/Instagram tickets live there)
-- with website-sourced fields and adds the supporting tables:
--   support_order_cache   (Shopify orders synced via webhooks)
--   support_whitelist     (phones allowed to see Help & Tickets)
--   support_settings      (SLA, teams, canned responses, cost config)
--   ticket_attachments    (per-ticket image links)
-- Run in the Supabase SQL Editor (whole file at once is safe).
-- ============================================================

-- ------------------------------------------------------------
-- 1. Extend support_tickets with website ticket fields
-- ------------------------------------------------------------
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reason VARCHAR(50);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reason_label VARCHAR(100);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sub VARCHAR(80);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sub_label VARCHAR(200);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS other_text TEXT;

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS preference VARCHAR(30);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS contact_via VARCHAR(20) DEFAULT 'whatsapp';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS new_address TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS video_url TEXT;

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(10) DEFAULT 'normal';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS team VARCHAR(30);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(100);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMP;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_customer_at TIMESTAMP;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS last_agent_at TIMESTAMP;

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_type VARCHAR(50);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_label VARCHAR(200);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_at TIMESTAMP;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_by VARCHAR(100);
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat INTEGER;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS reopen_count INTEGER DEFAULT 0;

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS thread JSONB DEFAULT '[]'::jsonb;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS notes JSONB DEFAULT '[]'::jsonb;

-- customer snapshot taken when the ticket is raised (orders/delivered/RTO counts)
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS history JSONB;
-- prepay conversion link created from the desk
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS payment_link TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS payment_link_id VARCHAR(100);

ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'whatsapp';
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS has_images BOOLEAN DEFAULT false;

-- Backfill thread/notes for rows created before this migration
UPDATE support_tickets SET thread = '[]'::jsonb WHERE thread IS NULL;
UPDATE support_tickets SET notes = '[]'::jsonb WHERE notes IS NULL;

-- Single-value index on channel is never chosen over the composites below; it
-- only adds a write per ticket. The desk queue filters channel+status and sorts
-- by last_customer_at, which is what this serves instead.
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON support_tickets(channel, status, last_customer_at);
CREATE INDEX IF NOT EXISTS idx_tickets_reason ON support_tickets(reason) WHERE reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_team ON support_tickets(team) WHERE team IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON support_tickets(priority) WHERE priority = 'high';
CREATE INDEX IF NOT EXISTS idx_tickets_phone_channel ON support_tickets(customer_phone, channel);

-- ------------------------------------------------------------
-- 2. Order cache (synced from Shopify via webhooks)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_order_cache (
  order_id VARCHAR(100) PRIMARY KEY,
  customer_phone VARCHAR(50) NOT NULL,
  customer_name VARCHAR(255),
  customer_email VARCHAR(255),
  order_json JSONB NOT NULL,
  stage VARCHAR(30),
  payment VARCHAR(20),
  courier VARCHAR(50),
  awb VARCHAR(100),
  address TEXT,
  total DECIMAL(10,2),
  -- timestamptz, not timestamp: node-pg parses a plain timestamp back in the
  -- server's local zone, which shifts every instant (eligibility windows, SLA).
  placed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  -- Shopify's own updated_at kept verbatim as sent. Repeat webhooks carrying the
  -- same value are skipped instead of rewriting the row, so a string compare is
  -- used rather than a timestamp one (which would drift across timezones).
  src_updated_at VARCHAR(40),
  replaced_by VARCHAR(100),
  replacements INTEGER DEFAULT 0
);
-- Hot path is "this customer's orders, newest first" (LIMIT 50): the composite
-- index serves it as an index scan with early termination, so the plain phone
-- index would only duplicate write cost.
CREATE INDEX IF NOT EXISTS idx_order_cache_phone ON support_order_cache(customer_phone, placed_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_cache_placed ON support_order_cache(placed_at DESC);

-- ------------------------------------------------------------
-- 3. Phone whitelist (access gate for the Help & Tickets tab)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_whitelist (
  id SERIAL PRIMARY KEY,
  phone VARCHAR(50) UNIQUE NOT NULL,
  added_by VARCHAR(100),
  note TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 4. Admin-configurable settings (seeded with reference defaults)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO support_settings (key, value) VALUES
('sla', '{"high_hours": 4, "normal_hours": 12}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO support_settings (key, value) VALUES
('teams', '{"chat":"Chat support","calling":"Calling team","instagram":"Instagram support","logistics":"Logistics & labels","returns":"Returns & QC","escalation":"Refunds & escalations"}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO support_settings (key, value) VALUES
('canned_responses', '[
  {"key":"paylink","label":"Send payment link","text":"Here''s a secure link to pay {amount} online for order #{order}: [paste payment link]\n\nOnce it''s paid, your order becomes prepaid and we''ll take the next step right away.","mode":"ask"},
  {"key":"video","label":"Ask for unboxing video","text":"To process this, please share a clear unboxing video of the parcel along with photos of the product and the shipping label. You can paste a Google Drive or WhatsApp link here.","mode":"ask"},
  {"key":"address","label":"Ask for full address","text":"Please share your complete address with house number, landmark and PIN code.","mode":"ask"},
  {"key":"courier","label":"Raised with courier","text":"We''ve raised this with {courier} for AWB {awb}. We''ll update you here within 24 hours.","mode":"reply"},
  {"key":"policy","label":"Store credit policy","text":"Returns at Offcomfrt are settled as store credit, issued as a code titled with your order number ({order}). It can be used on any product at offcomfrt.com.","mode":"reply"},
  {"key":"shipped","label":"Already shipped","text":"Order #{order} has already left our warehouse, so it can''t be changed now. Once it''s delivered, you can request an exchange or a return for store credit within 7 days.","mode":"reply"}
]'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO support_settings (key, value) VALUES
('resolution_templates', '{
  "info":"",
  "order_updated":"",
  "declined":"",
  "address_updated":"Your delivery address for order #{order} has been updated.",
  "cancelled":"Order #{order} has been cancelled as requested.",
  "prepaid":"Payment received. Order #{order} is now prepaid.",
  "new_order":"",
  "reshipped":"We''ve reshipped order #{order}. You''ll get the new tracking details on WhatsApp shortly.",
  "pickup_scheduled":"Your reverse pickup for order #{order} is scheduled with Delhivery. Please keep the product unused, with tags, in its original packet.",
  "exchange_dispatched":"Your exchange for order #{order} has been dispatched. Tracking details will follow on WhatsApp.",
  "store_credit":"We''ve issued store credit for order #{order}. Your code is titled {order} and can be applied at checkout on offcomfrt.com.",
  "courier_escalated":"We took this up with {courier} (AWB {awb}) and it''s now resolved.",
  "not_valid":"We checked the order, packing and courier records for #{order} and couldn''t verify this issue. If you have more details, reopen the ticket within 7 days.",
  "no_response":"We''re closing this as we didn''t hear back. You can reopen it within 7 days."
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO support_settings (key, value) VALUES
('cost_config', '{"fwd_ship":75,"rto_ship":75,"reverse_pickup":90,"packing":20,"cod_fee":35,"rto_rate_cod":0.25,"rto_rate_prepaid":0.05,"high_value":2500,"return_window_days":7,"dnr_report_days":3}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO support_settings (key, value) VALUES
('request_labels', '{
  "order/cancel":"Cancel order",
  "order/edit":"Edit order",
  "order/prepay":"Convert COD to prepaid",
  "delivery/address_change":"Change delivery address",
  "delivery/reship_new":"New order to a new address",
  "delivery/pay_reship":"Prepay, then new order to a new address",
  "return/return_credit":"Return for store credit",
  "return/exchange_req":"Exchange"
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------
-- 5. Ticket attachments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticket_attachments (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES support_tickets(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON ticket_attachments(ticket_id);
