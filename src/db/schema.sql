-- InsideBR — schema do banco de dados
-- Baseado no plano técnico, adaptado pra usar a fonte oficial (dados.cvm.gov.br)

CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  cvm_code VARCHAR(20) UNIQUE,
  cnpj VARCHAR(20),
  ticker VARCHAR(10),
  name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS ticker VARCHAR(10);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  role_category VARCHAR(100),
  movement_type VARCHAR(100),
  operation_type VARCHAR(10),
  asset_type VARCHAR(50),
  asset_class VARCHAR(20),
  quantity NUMERIC,
  unit_price NUMERIC,
  total_value NUMERIC,
  transaction_date DATE,
  filed_date DATE,
  raw_hash VARCHAR(64) UNIQUE,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_id);
CREATE INDEX IF NOT EXISTS idx_transactions_role ON transactions(role_category);
CREATE INDEX IF NOT EXISTS idx_transactions_filed_date ON transactions(filed_date);

CREATE TABLE IF NOT EXISTS buybacks (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  operation_type VARCHAR(10),
  asset_type VARCHAR(50),
  quantity NUMERIC,
  unit_price NUMERIC,
  total_value NUMERIC,
  transaction_date DATE,
  filed_date DATE,
  raw_hash VARCHAR(64) UNIQUE,
  raw_data JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_buybacks_company ON buybacks(company_id);
CREATE INDEX IF NOT EXISTS idx_buybacks_date ON buybacks(transaction_date);

CREATE TABLE IF NOT EXISTS corporate_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  subject TEXT,
  reference_date DATE,
  filed_date DATE,
  document_url TEXT,
  raw_hash VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_company ON corporate_events(company_id);
CREATE INDEX IF NOT EXISTS idx_events_filed_date ON corporate_events(filed_date);

CREATE TABLE IF NOT EXISTS push_tokens (
  id SERIAL PRIMARY KEY,
  expo_push_token TEXT UNIQUE NOT NULL,
  alert_preferences JSONB DEFAULT '{"newEvent": true, "multiInsider": true, "minScore": 30, "minValue": null}'::jsonb,
  created_at TIMESTAMP DEFAULT NOW(),
  last_seen_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE push_tokens ADD COLUMN IF NOT EXISTS alert_preferences JSONB
  DEFAULT '{"newEvent": true, "multiInsider": true, "minScore": 30, "minValue": null}'::jsonb;

CREATE TABLE IF NOT EXISTS watchlist_subscriptions (
  id SERIAL PRIMARY KEY,
  push_token_id INTEGER REFERENCES push_tokens(id) ON DELETE CASCADE,
  ticker VARCHAR(10) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(push_token_id, ticker)
);

CREATE TABLE IF NOT EXISTS capital_structure (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  reference_date DATE NOT NULL,
  free_float_shares BIGINT,
  free_float_percent NUMERIC(7,3),
  shareholders_pf INTEGER,
  shareholders_pj INTEGER,
  shareholders_institutional INTEGER,
  last_assembly_date DATE,
  raw_hash VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_capital_structure_company ON capital_structure(company_id);
CREATE INDEX IF NOT EXISTS idx_capital_structure_date ON capital_structure(reference_date);

CREATE TABLE IF NOT EXISTS controlling_shareholders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  reference_date DATE NOT NULL,
  shareholder_name TEXT,
  shareholder_document VARCHAR(30),
  percent_total NUMERIC(7,3),
  raw_hash VARCHAR(64) UNIQUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_controlling_company ON controlling_shareholders(company_id);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS alert_rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  rule_type VARCHAR(30),
  ticker VARCHAR(10),
  min_value NUMERIC,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
