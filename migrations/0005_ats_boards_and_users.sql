-- ATS board catalog (replaces SOURCES_JSON for production)
CREATE TABLE ats_boards (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('greenhouse', 'lever', 'ashby')),
  slug TEXT NOT NULL,
  company_name TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'standard' CHECK (tier IN ('priority', 'standard')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sector TEXT,
  last_polled_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, slug)
);

CREATE INDEX idx_ats_boards_active_tier_polled
  ON ats_boards (active, tier, last_polled_at);

-- Multi-tenant-ready users (Phase 1: single default operator)
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  telegram_chat_id TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_profiles (
  user_id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Default operator (profile blob filled from app_config / env at runtime if missing)
INSERT INTO users (id, display_name, telegram_chat_id, active, created_at, updated_at)
VALUES (
  'default',
  'Default operator',
  NULL,
  1,
  '2026-08-04T00:00:00.000Z',
  '2026-08-04T00:00:00.000Z'
);

-- Priority Greenhouse boards
INSERT INTO ats_boards (id, provider, slug, company_name, tier, active, sector, created_at, updated_at) VALUES
  ('gh-anthropic', 'greenhouse', 'anthropic', 'Anthropic', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-xai', 'greenhouse', 'xai', 'xAI', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-scaleai', 'greenhouse', 'scaleai', 'Scale AI', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-togetherai', 'greenhouse', 'togetherai', 'Together AI', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-cloudflare', 'greenhouse', 'cloudflare', 'Cloudflare', 'priority', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-vercel', 'greenhouse', 'vercel', 'Vercel', 'priority', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-figma', 'greenhouse', 'figma', 'Figma', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-discord', 'greenhouse', 'discord', 'Discord', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-airbnb', 'greenhouse', 'airbnb', 'Airbnb', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-stripe', 'greenhouse', 'stripe', 'Stripe', 'priority', 1, 'fintech', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-coinbase', 'greenhouse', 'coinbase', 'Coinbase', 'priority', 1, 'fintech', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-robinhood', 'greenhouse', 'robinhood', 'Robinhood', 'priority', 1, 'fintech', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-datadog', 'greenhouse', 'datadog', 'Datadog', 'priority', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-dropbox', 'greenhouse', 'dropbox', 'Dropbox', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-airtable', 'greenhouse', 'airtable', 'Airtable', 'priority', 1, 'saas', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-duolingo', 'greenhouse', 'duolingo', 'Duolingo', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-shopify', 'greenhouse', 'shopify', 'Shopify', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-doordash', 'greenhouse', 'doordash', 'DoorDash', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-twilio', 'greenhouse', 'twilio', 'Twilio', 'priority', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');

-- Priority Lever boards
INSERT INTO ats_boards (id, provider, slug, company_name, tier, active, sector, created_at, updated_at) VALUES
  ('lv-spotify', 'lever', 'spotify', 'Spotify', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('lv-palantir', 'lever', 'palantir', 'Palantir', 'priority', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('lv-netflix', 'lever', 'netflix', 'Netflix', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('lv-twitch', 'lever', 'twitch', 'Twitch', 'priority', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');

-- Priority Ashby boards
INSERT INTO ats_boards (id, provider, slug, company_name, tier, active, sector, created_at, updated_at) VALUES
  ('as-ramp', 'ashby', 'ramp', 'Ramp', 'priority', 1, 'fintech', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-openai', 'ashby', 'openai', 'OpenAI', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-notion', 'ashby', 'notion', 'Notion', 'priority', 1, 'saas', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-linear', 'ashby', 'linear', 'Linear', 'priority', 1, 'saas', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-cursor', 'ashby', 'cursor', 'Cursor', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-replit', 'ashby', 'replit', 'Replit', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-supabase', 'ashby', 'supabase', 'Supabase', 'priority', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-plaid', 'ashby', 'plaid', 'Plaid', 'priority', 1, 'fintech', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-cohere', 'ashby', 'cohere', 'Cohere', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-perplexity', 'ashby', 'perplexity', 'Perplexity', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-elevenlabs', 'ashby', 'elevenlabs', 'ElevenLabs', 'priority', 1, 'ai', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-ashby', 'ashby', 'ashby', 'Ashby', 'priority', 1, 'saas', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');

-- Standard rotation pool (polled round-robin after priority each cycle)
INSERT INTO ats_boards (id, provider, slug, company_name, tier, active, sector, created_at, updated_at) VALUES
  ('gh-gitlab', 'greenhouse', 'gitlab', 'GitLab', 'standard', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-pinterest', 'greenhouse', 'pinterest', 'Pinterest', 'standard', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-reddit', 'greenhouse', 'reddit', 'Reddit', 'standard', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-lyft', 'greenhouse', 'lyft', 'Lyft', 'standard', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-instacart', 'greenhouse', 'instacart', 'Instacart', 'standard', 1, 'consumer', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('gh-block', 'greenhouse', 'block', 'Block', 'standard', 1, 'fintech', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('lv-affirm', 'lever', 'affirm', 'Affirm', 'standard', 1, 'fintech', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('lv-sentry', 'lever', 'sentry', 'Sentry', 'standard', 1, 'infra', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'),
  ('as-rippling', 'ashby', 'rippling', 'Rippling', 'standard', 1, 'saas', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z');
