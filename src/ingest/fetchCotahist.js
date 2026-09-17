/**
 * Ingestão do COTAHIST (cotações históricas da B3) — preço diário de
 * cada ação que acompanhamos, sem o limite de 3 meses da brapi.
 *
 * Processa em STREAMING (nunca carrega o arquivo de ~650MB inteiro na
 * memória) e filtra só o que interessa (BDI=02, lote padrão, e só os
 * tickers que já temos mapeados) antes de gravar no banco.
 */
require("dotenv").config();
const unzipper = require("unzipper");
const readline = require("readline");
const pool = require("../db/pool");

function buildCandidateUrls(year) {
  return [
    `https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_A${year}.ZIP`,
    `https://arquivos.b3.com.br/rendafixa/renda-variavel/COTAHIST_A${year}.ZIP`,
  ];
}

async function downloadZipBuffer(year) {
  for (const url of buildCandidateUrls(year)) {
    console.log(`Baixando: ${url}`);
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
    });
    if (!response.ok) {
      console.log(`  Falhou (${response.status}), tentando próxima URL...`);
      continue;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
      return buffer;
    }
  }
  throw new Error(`Nenhuma URL funcionou pro ano ${year}`);
}

// Campos de preço vêm como inteiro com 2 casas decimais embutidas
// (ex: "0000000003744" → 37.44)
function parsePrice(raw) {
  const n = parseInt(raw, 10);
  if (isNaN(n)) return null;
  return n / 100;
}

function parseDate(raw) {
  // formato AAAAMMDD
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

async function ingestYear(year) {
  console.log(`\n=== COTAHIST ${year} ===`);

  const tickersResult = await pool.query(
    "SELECT DISTINCT ticker FROM companies WHERE ticker IS NOT NULL"
  );
  const trackedTickers = new Set(tickersResult.rows.map((r) => r.ticker));
  console.log(`Rastreando ${trackedTickers.size} tickers mapeados.`);

  const zipBuffer = await downloadZipBuffer(year);
  console.log(`Baixado: ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB comprimido`);

  const directory = await unzipper.Open.buffer(zipBuffer);
  const txtFile = directory.files.find((f) => f.path.toUpperCase().includes("COTAHIST"));
  if (!txtFile) throw new Error("Arquivo COTAHIST não encontrado dentro do zip");

  const stream = txtFile.stream();
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineCount = 0;
  let matchedCount = 0;
  let batch = [];
  const BATCH_SIZE = 500;
  let inserted = 0;

  async function flushBatch() {
    if (batch.length === 0) return;
    const values = [];
    const placeholders = [];
    batch.forEach((row, i) => {
      const base = i * 7;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`
      );
      values.push(row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume);
    });

    await pool.query(
      `
      INSERT INTO price_history (ticker, trade_date, open, high, low, close, volume)
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (ticker, trade_date)
      DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                     close = EXCLUDED.close, volume = EXCLUDED.volume
      `,
      values
    );
    inserted += batch.length;
    batch = [];
  }

  for await (const line of rl) {
    lineCount++;
    if (line.slice(0, 2) !== "01") continue; // só linhas de cotação, pula header/trailer
    if (line.slice(10, 12) !== "02") continue; // só lote padrão (BDI=02)

    const ticker = line.slice(12, 24).trim();
    if (!trackedTickers.has(ticker)) continue;

    matchedCount++;
    batch.push({
      ticker,
      date: parseDate(line.slice(2, 10)),
      open: parsePrice(line.slice(56, 69)),
      high: parsePrice(line.slice(69, 82)),
      low: parsePrice(line.slice(82, 95)),
      close: parsePrice(line.slice(108, 121)),
      volume: parseInt(line.slice(152, 170), 10) || null,
    });

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
    }
  }
  await flushBatch();

  console.log(`Linhas processadas: ${lineCount.toLocaleString("pt-BR")}`);
  console.log(`Linhas que batiam com nossos tickers: ${matchedCount.toLocaleString("pt-BR")}`);
  console.log(`Registros gravados/atualizados: ${inserted.toLocaleString("pt-BR")}`);
}

async function main() {
  const yearArg = process.argv[2];
  const years = yearArg ? [Number(yearArg)] : [new Date().getFullYear()];

  try {
    for (const year of years) {
      await ingestYear(year);
    }
  } catch (err) {
    console.error("Erro durante a ingestão:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

module.exports = { ingestYear };

if (require.main === module) {
  main();
}
