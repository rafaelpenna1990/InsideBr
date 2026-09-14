/**
 * PASSO 2 — Parser definitivo
 *
 * Baixa o arquivo consolidado da CVM (vlmo_cia_aberta_con_ANO.csv),
 * filtra só negociações reais de mercado (ignora posse, herança, doação,
 * plano de remuneração, etc.), e popula o banco.
 *
 * Rode com: npm run ingest
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const pool = require("../db/pool");

const BASE_URL =
  process.env.CVM_VLMO_BASE_URL ||
  "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/VLMO/DADOS";

const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

// Tipos de movimentação que representam negociação real de mercado.
// Tudo que não está aqui (posse, herança, doação, plano de remuneração,
// desdobramento, subscrição, etc.) é ignorado no MVP — não é uma decisão
// de "comprar/vender por convicção", é evento societário ou de RH.
const REAL_TRADE_MOVEMENT_TYPES = new Set([
  "Compra à vista",
  "Venda à vista",
  "Compra à termo",
  "Venda à termo",
  "Compra",
  "Venda",
  "Exercício opção de compra",
  "Exercício opção de venda",
]);

// Classes de ação comuns — ignora debêntures, opções, direitos de
// subscrição e a bagunça de valores únicos de séries de emissão.
const VALID_ASSET_CLASSES = new Set(["ON", "PN", "PNA", "PNB", "PNC"]);

function parseNumber(str) {
  if (!str || str.trim() === "") return null;
  // Os arquivos da CVM já usam ponto decimal padrão (ex: "7.7200000000"),
  // não formato brasileiro com vírgula — é só fazer parseFloat direto.
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function parseDate(str) {
  if (!str || str.trim() === "") return null;
  return str; // já vem em formato YYYY-MM-DD
}

function computeHash(row) {
  const key = [
    row.CNPJ_Companhia,
    row.Tipo_Cargo,
    row.Tipo_Movimentacao,
    row.Tipo_Operacao,
    row.Data_Movimentacao,
    row.Quantidade,
    row.Preco_Unitario,
    row.Volume,
    row.Caracteristica_Valor_Mobiliario,
  ].join("|");
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function downloadZip(year) {
  const url = `${BASE_URL}/vlmo_cia_aberta_${year}.zip`;
  console.log(`Baixando: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar ${url} — status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const zipPath = path.join(TMP_DIR, `vlmo_${year}.zip`);

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(zipPath, buffer);

  return zipPath;
}

function extractConsolidatedCsv(zipPath, year) {
  const zip = new AdmZip(zipPath);
  const entry = zip
    .getEntries()
    .find((e) => e.entryName === `vlmo_cia_aberta_con_${year}.csv`);

  if (!entry) {
    throw new Error(`Arquivo consolidado não encontrado no zip de ${year}`);
  }

  const rawContent = zip.readFile(entry).toString("latin1");

  return parse(rawContent, {
    delimiter: ";",
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    escape: "\\",
  });
}

async function upsertCompany(client, cnpj, name) {
  const existing = await client.query(
    "SELECT id FROM companies WHERE cnpj = $1",
    [cnpj]
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const inserted = await client.query(
    "INSERT INTO companies (cnpj, name) VALUES ($1, $2) RETURNING id",
    [cnpj, name]
  );
  return inserted.rows[0].id;
}

async function ingestYear(year) {
  console.log(`\n=== Processando ano ${year} ===`);
  const zipPath = await downloadZip(year);
  const rows = extractConsolidatedCsv(zipPath, year);
  console.log(`${rows.length} linhas no arquivo consolidado`);

  const client = await pool.connect();
  const companyCache = new Map();

  let inserted = 0;
  let skippedNotRealTrade = 0;
  let skippedAssetClass = 0;
  let skippedDuplicate = 0;
  let skippedNoRole = 0;

  try {
    for (const row of rows) {
      if (!REAL_TRADE_MOVEMENT_TYPES.has(row.Tipo_Movimentacao)) {
        skippedNotRealTrade++;
        continue;
      }
      if (!VALID_ASSET_CLASSES.has(row.Caracteristica_Valor_Mobiliario)) {
        skippedAssetClass++;
        continue;
      }
      if (!row.Tipo_Cargo || row.Tipo_Cargo.trim() === "") {
        skippedNoRole++;
        continue;
      }

      const hash = computeHash(row);
      const dup = await client.query(
        "SELECT id FROM transactions WHERE raw_hash = $1",
        [hash]
      );
      if (dup.rows.length > 0) {
        skippedDuplicate++;
        continue;
      }

      let companyId = companyCache.get(row.CNPJ_Companhia);
      if (!companyId) {
        companyId = await upsertCompany(
          client,
          row.CNPJ_Companhia,
          row.Nome_Companhia
        );
        companyCache.set(row.CNPJ_Companhia, companyId);
      }

      const operationType = row.Tipo_Operacao === "Crédito" ? "buy" : "sell";
      const quantity = parseNumber(row.Quantidade);
      const unitPrice = parseNumber(row.Preco_Unitario);
      const volume = parseNumber(row.Volume);
      const totalValue =
        volume ?? (quantity && unitPrice ? quantity * unitPrice : null);

      await client.query(
        `INSERT INTO transactions
          (company_id, role_category, movement_type, operation_type, asset_type, asset_class,
           quantity, unit_price, total_value, transaction_date, filed_date, raw_hash, raw_data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          companyId,
          row.Tipo_Cargo,
          row.Tipo_Movimentacao,
          operationType,
          row.Tipo_Ativo,
          row.Caracteristica_Valor_Mobiliario,
          quantity,
          unitPrice,
          totalValue,
          parseDate(row.Data_Movimentacao) || parseDate(row.Data_Referencia),
          parseDate(row.Data_Referencia),
          hash,
          JSON.stringify(row),
        ]
      );
      inserted++;
    }
  } finally {
    client.release();
  }

  console.log(`\nResultado do ano ${year}:`);
  console.log(`  Inseridas: ${inserted}`);
  console.log(`  Ignoradas (não é negociação real): ${skippedNotRealTrade}`);
  console.log(`  Ignoradas (classe de ativo fora do escopo): ${skippedAssetClass}`);
  console.log(`  Ignoradas (sem categoria de cargo): ${skippedNoRole}`);
  console.log(`  Já existiam (duplicadas): ${skippedDuplicate}`);
}

async function main() {
  const year = process.argv[2] || new Date().getFullYear();

  try {
    await ingestYear(Number(year));
  } catch (err) {
    console.error("Erro durante a ingestão:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

module.exports = { ingestYear };

// Só roda sozinho quando chamado direto via terminal (npm run ingest) —
// quando outro módulo faz require() disso (tipo o endpoint automático),
// não queremos fechar a conexão do banco nem sair do processo.
if (require.main === module) {
  main();
}
