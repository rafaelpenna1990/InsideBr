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

// ─────────────────────────────────────────────────────────────
// INSIDER RADAR — detecta atividade incomum de compra e calcula
// um "InsideBR Score" (0-100) medindo o quão fora do padrão está
// a movimentação. O score mede ATIVIDADE, não probabilidade de
// alta — importante deixar isso claro em qualquer lugar que exibe.
// ─────────────────────────────────────────────────────────────
function computeScore({ recentValue, recentRoles, multiplier }) {
  const valueScore = Math.min(recentValue / 5_000_000, 1) * 25;
  const rolesScore = Math.min(recentRoles / 4, 1) * 30;
  const multiplierScore = Math.min(multiplier / 5, 1) * 30;
  // Base de 15 pontos só por ter entrado no radar (atividade recente de verdade)
  const base = 15;
  return Math.round(Math.min(valueScore + rolesScore + multiplierScore + base, 100));
}

function scoreLabel(score) {
  if (score >= 80) return "Atividade muito incomum";
  if (score >= 60) return "Atividade acima do normal";
  if (score >= 40) return "Atividade moderada";
  return "Atividade dentro do padrão";
}

// ─────────────────────────────────────────────────────────────
// RANKING — empresas e categorias de cargo com mais atividade de
// insider (compra), no período pedido (padrão: histórico completo).
// ─────────────────────────────────────────────────────────────
app.get("/api/ranking/companies", async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : null;
    const dateFilter = days ? `AND t.transaction_date >= (CURRENT_DATE - ${Number(days)}::int)` : "";

    const result = await pool.query(`
      SELECT
        c.ticker,
        c.name AS company_name,
        c.cnpj,
        SUM(t.total_value) AS total_bought,
        COUNT(*) AS transaction_count,
        COUNT(DISTINCT t.role_category) AS distinct_roles
      FROM transactions t
      JOIN companies c ON c.id = t.company_id
      WHERE t.operation_type = 'buy'
        AND c.ticker IS NOT NULL
        ${dateFilter}
      GROUP BY c.ticker, c.name, c.cnpj
      ORDER BY total_bought DESC
      LIMIT 20
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/ranking/roles", async (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : null;
    const dateFilter = days ? `AND transaction_date >= (CURRENT_DATE - ${Number(days)}::int)` : "";

    const result = await pool.query(`
      SELECT
        role_category,
        operation_type,
        SUM(total_value) AS total_value,
        COUNT(*) AS transaction_count,
        COUNT(DISTINCT company_id) AS distinct_companies
      FROM transactions
      WHERE role_category IS NOT NULL AND role_category != ''
        ${dateFilter}
      GROUP BY role_category, operation_type
      ORDER BY total_value DESC
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/events/recent", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, c.name AS company_name, c.ticker, c.cnpj
      FROM corporate_events e
      JOIN companies c ON c.id = e.company_id
      WHERE c.ticker IS NOT NULL
      ORDER BY e.filed_date DESC NULLS LAST, e.id DESC
      LIMIT 30
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/companies/:cnpj/events", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT e.*, c.name AS company_name, c.ticker, c.cnpj
      FROM corporate_events e
      JOIN companies c ON c.id = e.company_id
      WHERE c.cnpj = $1
      ORDER BY e.filed_date DESC NULLS LAST, e.id DESC
      LIMIT 20
      `,
      [req.params.cnpj]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/radar", async (req, res) => {
  try {
    const windowDays = Number(req.query.days) || 21;

    const recentResult = await pool.query(
      `
      SELECT
        t.company_id,
        SUM(t.total_value) AS recent_value,
        COUNT(DISTINCT t.role_category) AS recent_roles,
        MAX(t.transaction_date) AS last_date,
        COUNT(*) AS recent_count
      FROM transactions t
      WHERE t.operation_type = 'buy'
        AND t.transaction_date >= (CURRENT_DATE - $1::int)
      GROUP BY t.company_id
      `,
      [windowDays]
    );

    if (recentResult.rows.length === 0) return res.json([]);

    const companyIds = recentResult.rows.map((r) => r.company_id);

    const historicalResult = await pool.query(
      `
      SELECT company_id, AVG(month_value) AS avg_monthly
      FROM (
        SELECT company_id, DATE_TRUNC('month', transaction_date) AS month, SUM(total_value) AS month_value
        FROM transactions
        WHERE operation_type = 'buy' AND company_id = ANY($1::int[])
        GROUP BY company_id, DATE_TRUNC('month', transaction_date)
      ) monthly
      GROUP BY company_id
      `,
      [companyIds]
    );
    const avgByCompany = new Map(
      historicalResult.rows.map((r) => [r.company_id, Number(r.avg_monthly) || 0])
    );

    const companiesResult = await pool.query(
      `SELECT id, name, ticker, cnpj FROM companies WHERE id = ANY($1::int[])`,
      [companyIds]
    );
    const companyById = new Map(companiesResult.rows.map((c) => [c.id, c]));

    const radar = recentResult.rows
      .map((r) => {
        const company = companyById.get(r.company_id);
        if (!company || !company.ticker) return null; // sem ticker, não dá pra linkar na UI

        const recentValue = Number(r.recent_value) || 0;
        const recentRoles = Number(r.recent_roles) || 0;
        const avgMonthly = avgByCompany.get(r.company_id) || 0;
        // Se não tem histórico prévio, considera "infinitamente acima da média"
        // mas usa um teto (10x) pra não distorcer o score
        const multiplier = avgMonthly > 0 ? recentValue / avgMonthly : 10;

        const score = computeScore({ recentValue, recentRoles, multiplier });

        return {
          ticker: company.ticker,
          companyName: company.name,
          cnpj: company.cnpj,
          recentValue,
          recentRoles,
          recentCount: Number(r.recent_count),
          avgMonthly,
          multiplier: Math.round(multiplier * 10) / 10,
          lastDate: r.last_date,
          score,
          label: scoreLabel(score),
          type: recentRoles >= 3 ? "cluster" : "unusual",
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    res.json(radar);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/companies/:cnpj/score", async (req, res) => {
  try {
    const windowDays = Number(req.query.days) || 21;

    const companyResult = await pool.query(
      "SELECT id, name, ticker, cnpj FROM companies WHERE cnpj = $1",
      [req.params.cnpj]
    );
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ status: "não encontrado" });
    }
    const company = companyResult.rows[0];

    const recentResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(total_value), 0) AS recent_value,
        COUNT(DISTINCT role_category) AS recent_roles
      FROM transactions
      WHERE company_id = $1
        AND operation_type = 'buy'
        AND transaction_date >= (CURRENT_DATE - $2::int)
      `,
      [company.id, windowDays]
    );
    const { recent_value, recent_roles } = recentResult.rows[0];

    const historicalResult = await pool.query(
      `
      SELECT AVG(month_value) AS avg_monthly
      FROM (
        SELECT DATE_TRUNC('month', transaction_date) AS month, SUM(total_value) AS month_value
        FROM transactions
        WHERE operation_type = 'buy' AND company_id = $1
        GROUP BY DATE_TRUNC('month', transaction_date)
      ) monthly
      `,
      [company.id]
    );
    const avgMonthly = Number(historicalResult.rows[0].avg_monthly) || 0;

    const recentValue = Number(recent_value);
    const recentRoles = Number(recent_roles);
    const multiplier = avgMonthly > 0 ? recentValue / avgMonthly : recentValue > 0 ? 10 : 0;
    const score = computeScore({ recentValue, recentRoles, multiplier });

    res.json({
      ticker: company.ticker,
      companyName: company.name,
      score,
      label: scoreLabel(score),
      recentValue,
      recentRoles,
      avgMonthly,
      multiplier: Math.round(multiplier * 10) / 10,
    });
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
