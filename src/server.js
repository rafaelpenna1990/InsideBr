require("dotenv").config();
const express = require("express");
const pool = require("./db/pool");

const app = express();
app.use(express.json());

// Libera acesso do app mobile (Expo) pra essa API
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => {
  res.json({ status: "InsideBR API rodando" });
});

app.get("/api/health/db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "ok", dbTime: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/transactions/recent", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.*, c.name AS company_name, c.cnpj, c.ticker
      FROM transactions t
      JOIN companies c ON c.id = t.company_id
      ORDER BY t.transaction_date DESC NULLS LAST, t.id DESC
      LIMIT 50
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/companies/search", async (req, res) => {
  const query = (req.query.q || "").trim();
  if (query.length < 1) return res.json([]);

  try {
    const result = await pool.query(
      `
      SELECT c.name AS company_name, c.ticker, c.cnpj
      FROM companies c
      WHERE c.ticker IS NOT NULL
        AND (c.ticker ILIKE $1 OR c.name ILIKE $1)
        AND EXISTS (SELECT 1 FROM transactions t WHERE t.company_id = c.id)
      ORDER BY
        CASE WHEN c.ticker ILIKE $2 THEN 0 ELSE 1 END,
        c.name
      LIMIT 15
      `,
      [`%${query}%`, `${query}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const totals = await pool.query(`
      SELECT
        operation_type,
        COUNT(*) AS total,
        SUM(total_value) AS valor_total
      FROM transactions
      GROUP BY operation_type
    `);

    const companies = await pool.query(`
      SELECT COUNT(DISTINCT company_id) AS empresas_com_negociacao
      FROM transactions
    `);

    const dateRange = await pool.query(`
      SELECT MIN(transaction_date) AS mais_antiga, MAX(transaction_date) AS mais_recente
      FROM transactions
    `);

    res.json({
      por_tipo_operacao: totals.rows,
      empresas_com_negociacao: companies.rows[0].empresas_com_negociacao,
      periodo: dateRange.rows[0],
    });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/companies/:cnpj/transactions", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT t.*, c.name AS company_name, c.cnpj, c.ticker
      FROM transactions t
      JOIN companies c ON c.id = t.company_id
      WHERE c.cnpj = $1
      ORDER BY t.filed_date DESC NULLS LAST, t.id DESC
      LIMIT 100
      `,
      [req.params.cnpj]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/companies/:cnpj/summary", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        c.name AS company_name,
        t.role_category,
        t.operation_type,
        COUNT(*) AS total_transacoes,
        SUM(t.total_value) AS valor_total
      FROM transactions t
      JOIN companies c ON c.id = t.company_id
      WHERE c.cnpj = $1
      GROUP BY c.name, t.role_category, t.operation_type
      ORDER BY t.role_category, t.operation_type
      `,
      [req.params.cnpj]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`InsideBR API rodando em http://localhost:${PORT}`);
});
