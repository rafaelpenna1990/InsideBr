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
// ─────────────────────────────────────────────────────────────
// INSIDER RADAR / SCORE — mede o quão relevante e fora do padrão
// está a atividade de compra ou venda, NUNCA previsão de preço.
//
// 5 pilares, adaptados ao dado que realmente temos disponível:
//  1. Valor da movimentação (30 pts) — tamanho absoluto em R$.
//     O ideal seria comparar com o volume negociado no mercado
//     daquela ação, mas não temos esse dado hoje — fica documentado
//     como limitação, não fingimos ter o que não temos.
//  2. Diversidade de cargos (25 pts) — proxy pra "insiders distintos".
//     A CVM não dá nome individual no dado aberto que usamos, só
//     categoria (Diretor, Conselho, Controlador...) — usamos isso
//     honestamente, sem fingir que é contagem de pessoas.
//  3. Concentração temporal (15 pts) — várias operações numa janela
//     curta pesa mais que a mesma quantidade espalhada.
//  4. Comparação histórica (20 pts) — vs. a MEDIANA mensal histórica
//     da própria empresa (mediana é mais robusta que média a outliers).
//  5. Qualidade dos dados (10 pts) — penaliza quando a fonte não
//     informou o valor da operação (acontece às vezes na CVM).
// ─────────────────────────────────────────────────────────────
function computeExplainableScore({ recentTx, historicalMonthly, windowDays }) {
  const recentValue = recentTx.reduce((sum, t) => sum + t.value, 0);
  const distinctRoles = new Set(recentTx.map((t) => t.roleCategory).filter(Boolean)).size;
  const txCount = recentTx.length;
  const validValueCount = recentTx.filter((t) => t.value > 0).length;

  const hasHistory = historicalMonthly.length >= 3; // menos de 3 meses = histórico insuficiente
  const sortedHist = [...historicalMonthly].filter((v) => v > 0).sort((a, b) => a - b);
  const median = sortedHist.length ? sortedHist[Math.floor(sortedHist.length / 2)] : 0;

  // Pilar 1 — Valor da movimentação (30 pts)
  const p1 = Math.min(recentValue / 5_000_000, 1) * 30;

  // Pilar 2 — Diversidade de cargos (25 pts)
  const p2 = Math.min(distinctRoles / 4, 1) * 25;

  // Pilar 3 — Concentração temporal (15 pts)
  let p3 = 0;
  let concentrationDetail = "Menos de 2 operações no período — não dá pra avaliar concentração.";
  if (txCount >= 2) {
    const dates = recentTx.map((t) => new Date(t.date).getTime());
    const spanDays = (Math.max(...dates) - Math.min(...dates)) / 86400000;
    const ratio = 1 - Math.min(spanDays / windowDays, 1);
    p3 = ratio * 15;
    concentrationDetail = `${txCount} operações em ${spanDays.toFixed(0)} dia(s), dentro da janela de ${windowDays} dias analisada.`;
  }

  // Pilar 4 — Comparação histórica (20 pts)
  let p4 = 0;
  let historyDetail;
  if (!hasHistory) {
    historyDetail = "Histórico insuficiente (menos de 3 meses de dados) pra essa empresa — pilar não pontuado.";
  } else if (median <= 0) {
    p4 = recentValue > 0 ? 20 : 0;
    historyDetail = "Sem mediana histórica válida — comparação limitada.";
  } else {
    const multiplier = recentValue / median;
    p4 = Math.min(multiplier / 5, 1) * 20;
    historyDetail = `${multiplier.toFixed(1)}× a mediana histórica mensal dessa empresa.`;
  }

  // Pilar 5 — Qualidade dos dados (10 pts)
  let p5 = 10;
  let qualityDetail = "Sem operações recentes pra avaliar.";
  if (txCount > 0) {
    const completeness = validValueCount / txCount;
    p5 = completeness * 10;
    qualityDetail =
      validValueCount === txCount
        ? "Todas as operações do período têm valor informado pela fonte."
        : `${txCount - validValueCount} de ${txCount} operação(ões) sem valor informado pela CVM.`;
  }

  const score = Math.round(p1 + p2 + p3 + p4 + p5);

  let relevance = "Baixa relevância";
  if (score >= 75) relevance = "Relevância muito alta";
  else if (score >= 55) relevance = "Alta relevância";
  else if (score >= 30) relevance = "Relevância moderada";

  const breakdown = [
    {
      key: "valor",
      label: "Valor da movimentação",
      points: Math.round(p1),
      max: 30,
      detail: `R$ ${recentValue.toLocaleString("pt-BR")} no período.`,
    },
    {
      key: "cargos",
      label: "Diversidade de cargos",
      points: Math.round(p2),
      max: 25,
      detail: `${distinctRoles} categoria(s) de cargo distinta(s) (proxy — CVM não informa nome individual).`,
    },
    {
      key: "concentracao",
      label: "Concentração temporal",
      points: Math.round(p3),
      max: 15,
      detail: concentrationDetail,
    },
    {
      key: "historico",
      label: "Comparação histórica",
      points: Math.round(p4),
      max: 20,
      detail: historyDetail,
    },
    {
      key: "qualidade",
      label: "Qualidade dos dados",
      points: Math.round(p5),
      max: 10,
      detail: qualityDetail,
    },
  ];

  let explanation;
  if (txCount === 0) {
    explanation =
      "Sem operações registradas nesse período. O score reflete a ausência de atividade recente, não um evento negativo.";
  } else {
    const historyPart = median > 0 ? `, ${(recentValue / median).toFixed(1)}× a mediana histórica da empresa` : "";
    explanation = `Score ${score}/100 (${relevance.toLowerCase()}) porque ${distinctRoles} categoria(s) de cargo realizaram operações somando R$ ${recentValue.toLocaleString("pt-BR")} em ${windowDays} dias${historyPart}. Isso não é recomendação de investimento.`;
  }

  return {
    score,
    relevance,
    breakdown,
    explanation,
    hasRecentActivity: txCount > 0,
    historySufficient: hasHistory,
  };
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

// ─────────────────────────────────────────────────────────────
// ATUALIZAÇÃO AUTOMÁTICA — chamado por um workflow agendado do
// GitHub Actions (já que o Cron Job nativo do Render exige plano
// pago). Protegido por uma chave secreta simples no header.
// Responde na hora e roda em segundo plano, porque a ingestão
// inteira pode levar alguns minutos — não dá pra deixar o GitHub
// Actions esperando isso tudo dentro de um único request HTTP.
// ─────────────────────────────────────────────────────────────
app.post("/api/internal/ingest-all", async (req, res) => {
  const providedKey = req.header("x-ingest-key");
  if (!process.env.INGEST_SECRET || providedKey !== process.env.INGEST_SECRET) {
    return res.status(401).json({ status: "não autorizado" });
  }

  res.status(202).json({ status: "iniciado", message: "Atualização rodando em segundo plano." });

  // A partir daqui, roda sem o cliente esperar — erros só vão pro log do Render.
  (async () => {
    const year = new Date().getFullYear();
    try {
      console.log(`[auto-ingest] Iniciando atualização automática (${new Date().toISOString()})`);

      const { ingestYear: ingestVlmo } = require("./ingest/fetchVlmo");
      await ingestVlmo(year);
      console.log("[auto-ingest] VLMO (negociações de insiders) concluído.");

      const { ingestYear: ingestEvents } = require("./ingest/fetchEvents");
      await ingestEvents(year);
      console.log("[auto-ingest] Fatos relevantes concluído.");

      const { runMapping } = require("./ingest/mapTickers");
      await runMapping();
      console.log("[auto-ingest] Mapeamento de tickers concluído.");

      console.log(`[auto-ingest] Atualização automática concluída com sucesso (${new Date().toISOString()})`);
    } catch (err) {
      console.error("[auto-ingest] Erro durante a atualização automática:", err.message);
    }
  })();
});

app.get("/api/radar", async (req, res) => {
  try {
    const windowDays = Number(req.query.days) || 21;

    // Transações individuais no período (precisamos das linhas, não só
    // do agregado, pra calcular concentração temporal e qualidade dos dados)
    const recentTxResult = await pool.query(
      `
      SELECT company_id, role_category, total_value, transaction_date
      FROM transactions
      WHERE operation_type = 'buy'
        AND transaction_date >= (CURRENT_DATE - $1::int)
      `,
      [windowDays]
    );

    if (recentTxResult.rows.length === 0) return res.json({ items: [], totalBoughtPeriod: 0 });

    const txByCompany = new Map();
    for (const r of recentTxResult.rows) {
      if (!txByCompany.has(r.company_id)) txByCompany.set(r.company_id, []);
      txByCompany.get(r.company_id).push({
        roleCategory: r.role_category,
        value: Number(r.total_value) || 0,
        date: r.transaction_date,
      });
    }

    const companyIds = [...txByCompany.keys()];

    const historicalResult = await pool.query(
      `
      SELECT company_id, DATE_TRUNC('month', transaction_date) AS month, SUM(total_value) AS month_value
      FROM transactions
      WHERE operation_type = 'buy' AND company_id = ANY($1::int[])
      GROUP BY company_id, DATE_TRUNC('month', transaction_date)
      `,
      [companyIds]
    );
    const historicalByCompany = new Map();
    for (const r of historicalResult.rows) {
      if (!historicalByCompany.has(r.company_id)) historicalByCompany.set(r.company_id, []);
      historicalByCompany.get(r.company_id).push(Number(r.month_value) || 0);
    }

    const companiesResult = await pool.query(
      `SELECT id, name, ticker, cnpj FROM companies WHERE id = ANY($1::int[])`,
      [companyIds]
    );
    const companyById = new Map(companiesResult.rows.map((c) => [c.id, c]));

    const RADAR_MIN_SCORE = 30; // abaixo de "relevância moderada" não entra no radar

    const totalBoughtPeriod = recentTxResult.rows.reduce(
      (sum, r) => sum + (Number(r.total_value) || 0),
      0
    );

    const radar = companyIds
      .map((companyId) => {
        const company = companyById.get(companyId);
        if (!company || !company.ticker) return null; // sem ticker, não dá pra linkar na UI

        const recentTx = txByCompany.get(companyId);
        const historicalMonthly = historicalByCompany.get(companyId) || [];

        const result = computeExplainableScore({ recentTx, historicalMonthly, windowDays });
        if (result.score < RADAR_MIN_SCORE) return null;

        const recentValue = recentTx.reduce((sum, t) => sum + t.value, 0);
        const distinctRoles = new Set(recentTx.map((t) => t.roleCategory)).size;
        const lastDate = recentTx.reduce(
          (max, t) => (new Date(t.date) > new Date(max) ? t.date : max),
          recentTx[0].date
        );

        return {
          ticker: company.ticker,
          companyName: company.name,
          cnpj: company.cnpj,
          recentValue,
          recentRoles: distinctRoles,
          recentCount: recentTx.length,
          lastDate,
          score: result.score,
          relevance: result.relevance,
          explanation: result.explanation,
          type: distinctRoles >= 3 ? "cluster" : "unusual",
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);

    res.json({ items: radar, totalBoughtPeriod });
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

    async function computeForOperation(operationType) {
      const recentResult = await pool.query(
        `
        SELECT role_category, total_value, transaction_date
        FROM transactions
        WHERE company_id = $1
          AND operation_type = $2
          AND transaction_date >= (CURRENT_DATE - $3::int)
        `,
        [company.id, operationType, windowDays]
      );
      const recentTx = recentResult.rows.map((r) => ({
        roleCategory: r.role_category,
        value: Number(r.total_value) || 0,
        date: r.transaction_date,
      }));

      const historicalResult = await pool.query(
        `
        SELECT SUM(total_value) AS month_value
        FROM transactions
        WHERE operation_type = $1 AND company_id = $2
        GROUP BY DATE_TRUNC('month', transaction_date)
        `,
        [operationType, company.id]
      );
      const historicalMonthly = historicalResult.rows.map((r) => Number(r.month_value) || 0);

      return computeExplainableScore({ recentTx, historicalMonthly, windowDays });
    }

    const [buy, sell] = await Promise.all([
      computeForOperation("buy"),
      computeForOperation("sell"),
    ]);

    res.json({
      ticker: company.ticker,
      companyName: company.name,
      windowDays,
      buy,
      sell,
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
