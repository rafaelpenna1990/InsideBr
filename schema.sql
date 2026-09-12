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
