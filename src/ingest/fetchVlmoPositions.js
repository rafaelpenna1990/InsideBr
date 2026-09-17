/**
 * Ingestão de POSIÇÃO detida de cada insider (não é negociação — é
 * "quanto essa pessoa TEM hoje" na empresa) — vem do mesmo arquivo VLMO
 * que já baixamos pras negociações, só que da linha "Saldo Inicial"
 * (que o parser de negociações descarta de propósito).
 *
 * Roda com: npm run ingest-positions [ano]
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const pool = require("../db/pool");

const BASE_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/VLMO/DADOS";
const TMP_DIR = path.join(__dirname, "..", "..", "tmp");
const VALID_ASSET_CLASSES = new Set(["ON", "PN", "PNA", "PNB", "PNC"]);

function parseNumber(str) {
  if (!str || str.trim() === "") return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function computeHash(row) {
  const key = [
    row.CNPJ_Companhia,
    row.Empresa,
    row.Tipo_Cargo,
    row.Caracteristica_Valor_Mobiliario,
    row.Data_Referencia,
    row.Quantidade,
  ].join("|");
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function downloadZip(year) {
  const url = `${BASE_URL}/vlmo_cia_aberta_${year}.zip`;
  console.log(`Baixando: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar ${url} — status ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, `vlmo_pos_${year}.zip`);
  fs.writeFileSync(zipPath, buffer);
  return zipPath;
}

function extractConsolidatedCsv(zipPath, year) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntries().find((e) => e.entryName === `vlmo_cia_aberta_con_${year}.csv`);
  if (!entry) throw new Error(`Arquivo consolidado não encontrado no zip de ${year}`);
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
  const existing = await client.query("SELECT id FROM companies WHERE cnpj = $1", [cnpj]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const inserted = await client.query(
    "INSERT INTO companies (cnpj, name) VALUES ($1, $2) RETURNING id",
    [cnpj, name]
  );
  return inserted.rows[0].id;
}

async function ingestYear(year) {
  console.log(`\n=== Posições ${year} ===`);
  const zipPath = await downloadZip(year);
  const rows = extractConsolidatedCsv(zipPath, year);
  console.log(`${rows.length} linhas no arquivo consolidado`);

  const client = await pool.connect();
  const companyCache = new Map();
  let inserted = 0;
  let skippedNotSaldo = 0;
  let skippedAssetClass = 0;
  let skippedDuplicate = 0;

  try {
    for (const row of rows) {
      if (row.Tipo_Movimentacao !== "Saldo Inicial") {
        skippedNotSaldo++;
        continue;
      }
      if (!VALID_ASSET_CLASSES.has(row.Caracteristica_Valor_Mobiliario)) {
        skippedAssetClass++;
        continue;
      }

      const hash = computeHash(row);
      const dup = await client.query("SELECT id FROM insider_positions WHERE raw_hash = $1", [
        hash,
      ]);
      if (dup.rows.length > 0) {
        skippedDuplicate++;
        continue;
      }

      let companyId = companyCache.get(row.CNPJ_Companhia);
      if (!companyId) {
        companyId = await upsertCompany(client, row.CNPJ_Companhia, row.Nome_Companhia);
        companyCache.set(row.CNPJ_Companhia, companyId);
      }

      await client.query(
        `INSERT INTO insider_positions
          (company_id, holder_name, role_category, asset_class, quantity, reference_date, raw_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          companyId,
          row.Empresa || null,
          row.Tipo_Cargo || null,
          row.Caracteristica_Valor_Mobiliario,
          parseNumber(row.Quantidade),
          row.Data_Referencia || null,
          hash,
        ]
      );
      inserted++;
    }
  } finally {
    client.release();
  }

  console.log(`\nResultado do ano ${year}:`);
  console.log(`  Inseridas: ${inserted}`);
  console.log(`  Ignoradas (não é Saldo Inicial): ${skippedNotSaldo}`);
  console.log(`  Ignoradas (classe de ativo fora do escopo): ${skippedAssetClass}`);
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

main();
