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

// ─────────────────────────────────────────────────────────────
// NOTÍCIAS — em vez de resumir o PDF do fato relevante com IA (que
// exigiria uma chave paga da Anthropic), usamos o feed público do
// Google Notícias: manchetes reais, já escritas por jornalistas,
// de graça, sem chave de API nenhuma.
// ─────────────────────────────────────────────────────────────
const { XMLParser } = require("fast-xml-parser");
const newsCache = new Map();
const NEWS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

async function fetchCompanyNews(companyName) {
  const cached = newsCache.get(companyName);
  if (cached && Date.now() - cached.fetchedAt < NEWS_CACHE_TTL_MS) {
    return cached.data;
  }

  const query = encodeURIComponent(`"${companyName}"`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  if (!response.ok) throw new Error(`Falha no Google News (${response.status})`);

  const xml = await response.text();
  const parser = new XMLParser();
  const parsed = parser.parse(xml);

  const rawItems = parsed?.rss?.channel?.item || [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]).slice(0, 8).map((item) => ({
    title: typeof item.title === "string" ? item.title : "",
    link: typeof item.link === "string" ? item.link : "",
    source: item.source?.["#text"] || item.source || null,
    pubDate: item.pubDate || null,
  }));

  newsCache.set(companyName, { data: items, fetchedAt: Date.now() });
  return items;
}

app.get("/api/companies/:cnpj/news", async (req, res) => {
  try {
    const companyResult = await pool.query(
      "SELECT name FROM companies WHERE cnpj = $1",
      [req.params.cnpj]
    );
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ status: "não encontrado" });
    }
    const news = await fetchCompanyNews(companyResult.rows[0].name);
    res.json(news);
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
    distinctRoles,
    recentValue,
    multiplier: median > 0 ? recentValue / median : null,
  };
}

// ─────────────────────────────────────────────────────────────
// RANKING — empresas e categorias de cargo com mais atividade de
// insider (compra), no período pedido (padrão: histórico completo).
// ─────────────────────────────────────────────────────────────
// Calcula o score de COMPRA (janela fixa de 21 dias, pra bater com o
// resto do app) pra um lote de empresas de uma vez — evita N+1 query
// quando o feed tem dezenas de empresas diferentes na mesma página.
async function getCompanyBuyScores(companyIds) {
  const scores = new Map();
  if (companyIds.length === 0) return scores;

  const recentResult = await pool.query(
    `
    SELECT company_id, role_category, total_value, transaction_date
    FROM transactions
    WHERE operation_type = 'buy'
      AND company_id = ANY($1::int[])
      AND transaction_date >= (CURRENT_DATE - 21)
    `,
    [companyIds]
  );
  const txByCompany = new Map();
  for (const r of recentResult.rows) {
    if (!txByCompany.has(r.company_id)) txByCompany.set(r.company_id, []);
    txByCompany.get(r.company_id).push({
      roleCategory: r.role_category,
      value: Number(r.total_value) || 0,
      date: r.transaction_date,
    });
  }

  const historicalResult = await pool.query(
    `
    SELECT company_id, DATE_TRUNC('month', transaction_date) AS month, SUM(total_value) AS month_value
    FROM transactions
    WHERE operation_type = 'buy' AND company_id = ANY($1::int[])
    GROUP BY company_id, DATE_TRUNC('month', transaction_date)
    `,
    [companyIds]
  );
  const histByCompany = new Map();
  for (const r of historicalResult.rows) {
    if (!histByCompany.has(r.company_id)) histByCompany.set(r.company_id, []);
    histByCompany.get(r.company_id).push(Number(r.month_value) || 0);
  }

  for (const id of companyIds) {
    const recentTx = txByCompany.get(id) || [];
    const historicalMonthly = histByCompany.get(id) || [];
    const result = computeExplainableScore({ recentTx, historicalMonthly, windowDays: 21 });
    scores.set(id, result);
  }
  return scores;
}

// ─────────────────────────────────────────────────────────────
// FEED UNIFICADO — junta negociações de insiders (compra/venda) e
// fatos relevantes numa lista só, com filtro e ordenação. É o que
// alimenta a tela Radar (tela inicial do app).
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS — estrutura de dados pronta pra receber o
// token do dispositivo. IMPORTANTE: isso só GUARDA o token — ainda
// NÃO existe nenhuma rotina que decide quando disparar uma
// notificação de verdade (precisaria rodar dentro do job semanal
// de ingestão, avaliando as regras de alerta contra o dado novo, e
// chamando a Push API da Expo). Documentado como pendente.
// ─────────────────────────────────────────────────────────────
app.post("/api/push-tokens", async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ status: "erro", message: "token é obrigatório" });

  try {
    await pool.query(
      `
      INSERT INTO push_tokens (expo_push_token)
      VALUES ($1)
      ON CONFLICT (expo_push_token) DO UPDATE SET last_seen_at = NOW()
      `,
      [token]
    );
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// TEMPORÁRIO — só pra conferir se uma migração de verdade aplicou no
// banco. Pode remover depois que confirmar.
// TEMPORÁRIO — só pra investigar os campos originais da CVM.
// TEMPORÁRIO — lista os arquivos que o servidor realmente enxerga numa pasta.
app.get("/api/debug/ls", async (req, res) => {
  try {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "ingest");
    const files = fs.readdirSync(dir);
    res.json({ dir, files });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/debug/sample-transaction", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT raw_data FROM transactions WHERE raw_data IS NOT NULL LIMIT 1"
    );
    res.json(result.rows[0]?.raw_data || {});
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.get("/api/debug/columns/:table", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
      [req.params.table]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.post("/api/push-tokens/:token/preferences", async (req, res) => {
  const { newEvent, multiInsider, minScore, minValue } = req.body || {};
  try {
    const result = await pool.query(
      `
      UPDATE push_tokens
      SET alert_preferences = $1::jsonb
      WHERE expo_push_token = $2
      RETURNING id
      `,
      [JSON.stringify({ newEvent, multiInsider, minScore, minValue }), req.params.token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: "erro", message: "token não registrado" });
    }
    res.json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

app.post("/api/push-tokens/:token/watchlist", async (req, res) => {
  const { tickers } = req.body || {};
  if (!Array.isArray(tickers)) {
    return res.status(400).json({ status: "erro", message: "tickers precisa ser uma lista" });
  }

  try {
    const tokenResult = await pool.query(
      "SELECT id FROM push_tokens WHERE expo_push_token = $1",
      [req.params.token]
    );
    if (tokenResult.rows.length === 0) {
      return res.status(404).json({ status: "erro", message: "token não registrado" });
    }
    const tokenId = tokenResult.rows[0].id;

    // Substitui a lista inteira (mais simples que fazer diff) — o app
    // manda o estado completo toda vez que a lista de acompanhamento muda.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM watchlist_subscriptions WHERE push_token_id = $1", [tokenId]);
      for (const ticker of tickers) {
        await client.query(
          "INSERT INTO watchlist_subscriptions (push_token_id, ticker) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [tokenId, ticker]
        );
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    res.json({ status: "ok", watching: tickers.length });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// Roda depois de cada ingestão automática — avisa por push só quem
// segue uma empresa que teve negociação ou fato relevante NOVO nessa
// rodada (created_at >= o início dessa ingestão), E cujas preferências
// de alerta batem com o que mudou (tipo de evento, score mínimo, etc).
async function sendWatchlistNotifications(since) {
  const newTx = await pool.query(
    `
    SELECT c.ticker, c.id AS company_id, t.role_category, COUNT(*) AS count
    FROM transactions t
    JOIN companies c ON c.id = t.company_id
    WHERE t.created_at >= $1 AND t.operation_type IN ('buy','sell')
    GROUP BY c.ticker, c.id, t.role_category
    `,
    [since]
  );
  const newEvents = await pool.query(
    `
    SELECT c.ticker, c.id AS company_id, COUNT(*) AS count
    FROM corporate_events e
    JOIN companies c ON c.id = e.company_id
    WHERE e.created_at >= $1
    GROUP BY c.ticker, c.id
    `,
    [since]
  );

  // ticker -> { companyId, txCount, distinctRolesChanged, eventCount }
  const changedTickers = new Map();
  for (const r of newTx.rows) {
    const entry = changedTickers.get(r.ticker) || {
      companyId: r.company_id,
      txCount: 0,
      rolesChanged: new Set(),
      eventCount: 0,
    };
    entry.txCount += Number(r.count);
    if (r.role_category) entry.rolesChanged.add(r.role_category);
    changedTickers.set(r.ticker, entry);
  }
  for (const r of newEvents.rows) {
    const entry = changedTickers.get(r.ticker) || {
      companyId: r.company_id,
      txCount: 0,
      rolesChanged: new Set(),
      eventCount: 0,
    };
    entry.eventCount += Number(r.count);
    changedTickers.set(r.ticker, entry);
  }

  if (changedTickers.size === 0) {
    console.log("[auto-ingest] Nenhuma mudança nova pra notificar.");
    return;
  }

  const tickers = [...changedTickers.keys()];
  const companyIds = [...changedTickers.values()].map((v) => v.companyId);
  const scores = await getCompanyBuyScores(companyIds);

  const subsResult = await pool.query(
    `
    SELECT ws.ticker, pt.expo_push_token, pt.alert_preferences
    FROM watchlist_subscriptions ws
    JOIN push_tokens pt ON pt.id = ws.push_token_id
    WHERE ws.ticker = ANY($1::text[])
    `,
    [tickers]
  );

  if (subsResult.rows.length === 0) {
    console.log("[auto-ingest] Ninguém segue as empresas que mudaram — nada a notificar.");
    return;
  }

  const messages = [];
  for (const r of subsResult.rows) {
    const change = changedTickers.get(r.ticker);
    const score = scores.get(change.companyId);
    const prefs = r.alert_preferences || {};

    const hasNewEvent = change.eventCount > 0;
    const hasMultiInsider = change.rolesChanged.size >= 2;
    const scoreValue = score ? score.score : 0;
    const recentValue = score ? score.recentValue : 0;

    // Preferências, com default sensato caso a coluna venha vazia
    const wantsNewEvent = prefs.newEvent !== false;
    const wantsMultiInsider = prefs.multiInsider !== false;
    const minScore = prefs.minScore ?? 30;
    const minValue = prefs.minValue ?? null;

    // Passa se QUALQUER critério ativado bater — não precisa bater todos
    const matchesEvent = hasNewEvent && wantsNewEvent;
    const matchesMultiInsider = hasMultiInsider && wantsMultiInsider;
    const matchesScore = scoreValue >= minScore;
    const matchesValue = minValue == null || recentValue >= minValue;

    const shouldNotify = (matchesEvent || matchesMultiInsider || matchesScore) && matchesValue;
    if (!shouldNotify) continue;

    const parts = [];
    if (change.txCount > 0) parts.push(`${change.txCount} negociação(ões) de insider`);
    if (change.eventCount > 0) parts.push(`${change.eventCount} fato(s) relevante(s)`);

    messages.push({
      to: r.expo_push_token,
      sound: "default",
      title: `Nova movimentação em ${r.ticker}`,
      body: `${parts.join(" e ")} desde a última atualização (score ${scoreValue}/100). Isso não é recomendação de investimento.`,
      data: { ticker: r.ticker },
    });
  }

  if (messages.length === 0) {
    console.log("[auto-ingest] Ninguém tinha preferência batendo com as mudanças — nada enviado.");
    return;
  }

  console.log(`[auto-ingest] Enviando ${messages.length} notificação(ões) push...`);
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      console.error(`[auto-ingest] Falha ao enviar notificações — status ${response.status}`);
    } else {
      console.log("[auto-ingest] Notificações enviadas.");
    }
  } catch (err) {
    console.error("[auto-ingest] Erro enviando notificações:", err.message);
  }
}

app.get("/api/feed", async (req, res) => {
  try {
    // Filtro por data específica: "from" e/ou "to" (formato YYYY-MM-DD).
    // Sem nenhum dos dois, mostra tudo. Só "from" = a partir daquele dia.
    // Só "to" = até aquele dia. Os dois iguais = um dia único.
    const from = req.query.from || null;
    const to = req.query.to || null;
    const type = req.query.type || "all"; // all | buy | sell | evento
    const sort = req.query.sort || "recent"; // recent | score | value | insiders | impact
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const offset = Number(req.query.offset) || 0;

    const includeTx = type !== "evento";
    const includeEvents = type === "all" || type === "evento";
    const txOperationFilter = type === "buy" || type === "sell" ? type : null;

    let txRows = [];
    if (includeTx) {
      const txParams = [];
      const txConditions = ["c.ticker IS NOT NULL"];

      if (from) {
        txParams.push(from);
        txConditions.push(`t.transaction_date >= $${txParams.length}::date`);
      }
      if (to) {
        txParams.push(to);
        txConditions.push(`t.transaction_date <= $${txParams.length}::date`);
      }
      if (txOperationFilter) {
        txParams.push(txOperationFilter);
        txConditions.push(`t.operation_type = $${txParams.length}`);
      } else {
        txConditions.push("t.operation_type IN ('buy','sell')");
      }

      const txResult = await pool.query(
        `
        SELECT t.id, t.company_id, t.role_category, t.operation_type, t.total_value,
               t.transaction_date, t.filed_date, c.ticker, c.name AS company_name, c.cnpj
        FROM transactions t
        JOIN companies c ON c.id = t.company_id
        WHERE ${txConditions.join(" AND ")}
        ORDER BY t.transaction_date DESC NULLS LAST
        LIMIT 500
        `,
        txParams
      );
      txRows = txResult.rows;
    }

    let eventRows = [];
    if (includeEvents) {
      const eventParams = [];
      const eventConditions = ["c.ticker IS NOT NULL"];
      if (from) {
        eventParams.push(from);
        eventConditions.push(`e.filed_date >= $${eventParams.length}::date`);
      }
      if (to) {
        eventParams.push(to);
        eventConditions.push(`e.filed_date <= $${eventParams.length}::date`);
      }

      const eventResult = await pool.query(
        `
        SELECT e.id, e.company_id, e.subject, e.filed_date, e.document_url,
               c.ticker, c.name AS company_name, c.cnpj
        FROM corporate_events e
        JOIN companies c ON c.id = e.company_id
        WHERE ${eventConditions.join(" AND ")}
        ORDER BY e.filed_date DESC NULLS LAST
        LIMIT 500
        `,
        eventParams
      );
      eventRows = eventResult.rows;
    }

    const companyIds = [
      ...new Set([...txRows.map((r) => r.company_id), ...eventRows.map((r) => r.company_id)]),
    ];
    const scores = await getCompanyBuyScores(companyIds);

    const txItems = txRows.map((r) => {
      const s = scores.get(r.company_id);
      return {
        id: `tx-${r.id}`,
        type: r.operation_type, // "buy" | "sell"
        ticker: r.ticker,
        companyName: r.company_name,
        cnpj: r.cnpj,
        value: Number(r.total_value) || 0,
        roleCategory: r.role_category,
        transactionDate: r.transaction_date,
        filedDate: r.filed_date,
        score: s ? s.score : null,
        relevance: s ? s.relevance : null,
        distinctRoles: s ? s.distinctRoles : null,
        multiplier: s ? s.multiplier : null,
      };
    });

    const eventItems = eventRows.map((r) => {
      const s = scores.get(r.company_id);
      return {
        id: `ev-${r.id}`,
        type: "evento",
        ticker: r.ticker,
        companyName: r.company_name,
        cnpj: r.cnpj,
        subject: r.subject,
        documentUrl: r.document_url,
        filedDate: r.filed_date,
        score: s ? s.score : null,
        relevance: s ? s.relevance : null,
        distinctRoles: s ? s.distinctRoles : null,
        multiplier: s ? s.multiplier : null,
      };
    });

    let items = [...txItems, ...eventItems];

    const sorters = {
      recent: (a, b) => new Date(b.filedDate || 0) - new Date(a.filedDate || 0),
      score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
      value: (a, b) => (b.value ?? -1) - (a.value ?? -1),
      insiders: (a, b) => (b.distinctRoles ?? -1) - (a.distinctRoles ?? -1),
      impact: (a, b) => (b.multiplier ?? -1) - (a.multiplier ?? -1),
    };
    items.sort(sorters[sort] || sorters.recent);

    const total = items.length;
    const page = items.slice(offset, offset + limit);

    const lastUpdateResult = await pool.query(
      `SELECT GREATEST(
         (SELECT MAX(created_at) FROM transactions),
         (SELECT MAX(created_at) FROM corporate_events)
       ) AS last_update`
    );

    res.json({
      items: page,
      total,
      hasMore: offset + limit < total,
      lastUpdate: lastUpdateResult.rows[0].last_update,
    });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

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
    const ingestStartedAt = new Date();
    try {
      console.log(`[auto-ingest] Iniciando atualização automática (${ingestStartedAt.toISOString()})`);

      const { ingestYear: ingestVlmo } = require("./ingest/fetchVlmo");
      await ingestVlmo(year);
      console.log("[auto-ingest] VLMO (negociações de insiders) concluído.");

      const { ingestYear: ingestEvents } = require("./ingest/fetchEvents");
      await ingestEvents(year);
      console.log("[auto-ingest] Fatos relevantes concluído.");

      const { runMapping } = require("./ingest/mapTickers");
      await runMapping();
      console.log("[auto-ingest] Mapeamento de tickers concluído.");

      try {
        const { ingestYear: ingestFRE } = require("./ingest/fetchFRE");
        await ingestFRE(year);
        console.log("[auto-ingest] Formulário de Referência (free float/controlador) concluído.");
      } catch (freErr) {
        console.error("[auto-ingest] Falha no FRE (não crítico, seguindo):", freErr.message);
      }

      await sendWatchlistNotifications(ingestStartedAt);

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

app.get("/api/companies/:cnpj/net-position", async (req, res) => {
  try {
    const companyResult = await pool.query(
      "SELECT id FROM companies WHERE cnpj = $1",
      [req.params.cnpj]
    );
    if (companyResult.rows.length === 0) {
      return res.status(404).json({ status: "não encontrado" });
    }
    const companyId = companyResult.rows[0].id;

    // Agrupa por mês (usando a data REAL da operação) — compra soma,
    // venda subtrai. O front acumula esses valores pra desenhar a
    // linha de saldo líquido crescendo/caindo ao longo do tempo.
    const result = await pool.query(
      `
      SELECT
        DATE_TRUNC('month', transaction_date) AS month,
        SUM(CASE WHEN operation_type = 'buy' THEN total_value ELSE 0 END) AS bought,
        SUM(CASE WHEN operation_type = 'sell' THEN total_value ELSE 0 END) AS sold
      FROM transactions
      WHERE company_id = $1 AND transaction_date IS NOT NULL
      GROUP BY DATE_TRUNC('month', transaction_date)
      ORDER BY month ASC
      `,
      [companyId]
    );

    let cumulative = 0;
    const series = result.rows.map((r) => {
      const bought = Number(r.bought) || 0;
      const sold = Number(r.sold) || 0;
      const net = bought - sold;
      cumulative += net;
      return {
        month: r.month,
        bought,
        sold,
        net,
        cumulative,
      };
    });

    res.json({ series });
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
