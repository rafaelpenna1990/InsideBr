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

// Cache simples em memória pra não estourar o limite gratuito da brapi
// a cada abertura do app — atualiza no máximo a cada 5 minutos.
let marketCache = { data: null, fetchedAt: 0 };
const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;

async function getMarketQuotes() {
  const now = Date.now();
  if (marketCache.data && now - marketCache.fetchedAt < MARKET_CACHE_TTL_MS) {
    return marketCache.data;
  }

  const token = process.env.BRAPI_TOKEN;
  if (!token) throw new Error("BRAPI_TOKEN não configurado");

  const url = `https://brapi.dev/api/quote/list?token=${token}&type=stock`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha na brapi (${response.status})`);

  const json = await response.json();
  const quotes = (json.stocks || [])
    .map((item) => ({
      ticker: item.stock,
      name: item.name,
      price: item.close ?? item.regularMarketPrice ?? null,
      changePercent: item.change ?? item.regularMarketChangePercent ?? null,
    }))
    .filter((q) => q.price != null && q.changePercent != null);

  marketCache = { data: quotes, fetchedAt: now };
  return quotes;
}

// O plano gratuito da brapi limita histórico a ~3 meses e não libera
// granularidade intraday (15m/60m) de forma confiável — então sempre
// buscamos o máximo disponível (3 meses, diário) UMA vez só. Os botões
// de período no app recortam esse mesmo conjunto de pontos, em vez de
// pedir de novo pra API a cada clique.
const historyCache = new Map();
const HISTORY_CACHE_TTL_MS = 15 * 60 * 1000;

app.get("/api/market/history/:ticker", async (req, res) => {
  const ticker = req.params.ticker.toUpperCase();

  const cached = historyCache.get(ticker);
  if (cached && Date.now() - cached.fetchedAt < HISTORY_CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const token = process.env.BRAPI_TOKEN;
    const url = `https://brapi.dev/api/quote/${ticker}?token=${token}&range=3mo&interval=1d`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Falha na brapi (${response.status})`);

    const json = await response.json();
    const result = (json.results || [])[0];
    if (!result) return res.json({ points: [] });

    const points = (result.historicalDataPrice || []).map((p) => ({
      date: p.date, // timestamp unix
      close: p.close,
    }));

    const payload = {
      points,
      currentPrice: result.regularMarketPrice ?? null,
      changePercent: result.regularMarketChangePercent ?? null,
      name: result.shortName || result.longName || ticker,
    };

    historyCache.set(ticker, { data: payload, fetchedAt: Date.now() });
    res.json(payload);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/companies/by-ticker/:ticker", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT c.name AS company_name, c.ticker, c.cnpj
      FROM companies c
      WHERE c.ticker = $1
        AND EXISTS (SELECT 1 FROM transactions t WHERE t.company_id = c.id)
      LIMIT 1
      `,
      [req.params.ticker]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: "não encontrado" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/market/search", async (req, res) => {
  const query = (req.query.q || "").trim().toLowerCase();
  if (query.length < 1) return res.json([]);

  try {
    const quotes = await getMarketQuotes();
    const matches = quotes
      .filter(
        (q) =>
          q.ticker.toLowerCase().includes(query) ||
          (q.name && q.name.toLowerCase().includes(query))
      )
      .sort((a, b) => {
        const aStarts = a.ticker.toLowerCase().startsWith(query) ? 0 : 1;
        const bStarts = b.ticker.toLowerCase().startsWith(query) ? 0 : 1;
        return aStarts - bStarts;
      })
      .slice(0, 20);

    res.json(matches);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/market/summary", async (req, res) => {
  try {
    const quotes = await getMarketQuotes();

    // Empresas que a gente já tem no banco entram na fita de cotação
    const { rows: ourCompanies } = await pool.query(
      "SELECT DISTINCT ticker FROM companies WHERE ticker IS NOT NULL"
    );
    const ourTickers = new Set(ourCompanies.map((c) => c.ticker));

    const tapeCandidates = quotes.filter((q) => ourTickers.has(q.ticker));
    const tickerTape = (tapeCandidates.length >= 8 ? tapeCandidates : quotes).slice(0, 12);

    const sorted = [...quotes].sort((a, b) => b.changePercent - a.changePercent);
    const topGainers = sorted.slice(0, 5);
    const topLosers = sorted.slice(-5).reverse();

    res.json({ tickerTape, topGainers, topLosers, updatedAt: new Date(marketCache.fetchedAt) });
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
