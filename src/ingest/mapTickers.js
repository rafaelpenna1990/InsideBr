/**
 * PASSO 3 — Mapeamento CNPJ/Nome → Ticker (B3)
 *
 * A CVM não inclui o ticker (código de negociação) nos dados de insiders.
 * Esse script busca a lista completa de ativos na brapi.dev e tenta casar
 * pelo nome da empresa. Matches de alta confiança são salvos automaticamente;
 * o resto fica numa lista pra revisão manual.
 *
 * Requer BRAPI_TOKEN no .env (grátis em https://brapi.dev/dashboard)
 *
 * Rode com: npm run map-tickers
 */
require("dotenv").config();
const pool = require("../db/pool");

const BRAPI_TOKEN = process.env.BRAPI_TOKEN;

// Palavras/sufixos societários que atrapalham a comparação de nomes
const NOISE_WORDS = new Set([
  "SA", "S/A", "S.A", "SA.", "PARTICIPACOES", "PARTICIPAÇÕES", "CIA",
  "COMPANHIA", "SOCIEDADE", "ANONIMA", "ANÔNIMA",
  "DO", "DA", "DE", "E",
]);

function normalize(name) {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove acentos
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w))
    .join(" ")
    .trim();
}

function buildIdfWeights(allNames) {
  const docFrequency = new Map();
  const docs = allNames.map((n) => new Set(normalize(n).split(" ").filter(Boolean)));

  for (const doc of docs) {
    for (const word of doc) {
      docFrequency.set(word, (docFrequency.get(word) || 0) + 1);
    }
  }

  const idf = new Map();
  const totalDocs = docs.length;
  for (const [word, freq] of docFrequency) {
    // Palavra rara (aparece em poucas empresas) pesa mais.
    // Palavra genérica (tipo "BANCO", "ENERGIA") pesa perto de zero.
    idf.set(word, Math.log((totalDocs + 1) / (freq + 1)) + 1);
  }
  return idf;
}

function similarityScore(nameA, nameB, idf) {
  const wordsA = normalize(nameA).split(" ").filter(Boolean);
  const setA = new Set(wordsA);
  const setB = new Set(normalize(nameB).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let matchWeight = 0;
  let totalWeight = 0;
  const union = new Set([...setA, ...setB]);

  for (const word of union) {
    const weight = idf.get(word) || 1;
    totalWeight += weight;
    if (setA.has(word) && setB.has(word)) matchWeight += weight;
  }

  return totalWeight === 0 ? 0 : matchWeight / totalWeight;
}

async function fetchAllTickers() {
  console.log("Buscando lista completa de tickers na brapi.dev...");
  const url = `https://brapi.dev/api/quote/list?token=${BRAPI_TOKEN}&type=stock`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Falha ao buscar tickers — status ${response.status}`);
  }

  const data = await response.json();
  console.log(`${data.stocks.length} tickers encontrados na brapi.`);
  return data.stocks; // [{ stock: "PETR4", name: "Petrobras PN", ... }]
}

async function main() {
  if (!BRAPI_TOKEN) {
    throw new Error("Faltando BRAPI_TOKEN no .env — pegue um grátis em https://brapi.dev/dashboard");
  }

  const tickers = await fetchAllTickers();
  const idf = buildIdfWeights(tickers.map((t) => t.name || ""));

  const client = await pool.connect();
  const HIGH_CONFIDENCE = 0.55;
  const MEDIUM_CONFIDENCE = 0.3;

  const autoMapped = [];
  const needsReview = [];
  const noMatch = [];

  try {
    // Reseta tickers de uma rodada anterior (o algoritmo mudou, então
    // qualquer mapeamento antigo pode estar errado e precisa ser refeito).
    await client.query("UPDATE companies SET ticker = NULL");

    const { rows: companies } = await client.query(
      "SELECT id, name, ticker FROM companies WHERE ticker IS NULL"
    );
    console.log(`\n${companies.length} empresas sem ticker ainda.`);

    for (const company of companies) {
      let best = null;
      let bestScore = 0;

      for (const t of tickers) {
        const score = similarityScore(company.name, t.name || "", idf);
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }

      // Segurança: se depois de normalizar sobrou 1 palavra só (ou 0),
      // não tem informação suficiente pra confiar — sempre manda pra
      // revisão manual, mesmo que a pontuação pareça alta.
      const significantWordCount = normalize(company.name).split(" ").filter(Boolean).length;
      const effectiveHighConfidence = significantWordCount <= 1 ? 1.01 : HIGH_CONFIDENCE;

      if (best && bestScore >= effectiveHighConfidence) {
        await client.query("UPDATE companies SET ticker = $1 WHERE id = $2", [
          best.stock,
          company.id,
        ]);
        autoMapped.push({ company: company.name, ticker: best.stock, score: bestScore.toFixed(2) });
      } else if (best && bestScore >= MEDIUM_CONFIDENCE) {
        needsReview.push({ company: company.name, suggestion: best.stock, score: bestScore.toFixed(2) });
      } else {
        noMatch.push(company.name);
      }
    }
  } finally {
    client.release();
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`MAPEADOS AUTOMATICAMENTE (confiança alta): ${autoMapped.length}`);
  console.log("=".repeat(60));
  autoMapped.forEach((m) => console.log(`  ${m.company} → ${m.ticker} (${m.score})`));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PRECISAM DE REVISÃO MANUAL (confiança média): ${needsReview.length}`);
  console.log("=".repeat(60));
  needsReview.forEach((m) => console.log(`  ${m.company} → sugestão: ${m.suggestion} (${m.score})`));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SEM MATCH (provavelmente não listada / capital fechado): ${noMatch.length}`);
  console.log("=".repeat(60));
  noMatch.slice(0, 20).forEach((n) => console.log(`  ${n}`));
  if (noMatch.length > 20) console.log(`  ... e mais ${noMatch.length - 20}`);
}

module.exports = { runMapping: main };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error("Erro:", err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
