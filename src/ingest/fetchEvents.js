/**
 * Baixa o dataset IPE da CVM, filtra só "Fato Relevante" e popula o banco.
 *
 * Rode com: npm run ingest-events [ano]
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const pool = require("../db/pool");

const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

function parseDate(str) {
  if (!str || str.trim() === "") return null;
  return str;
}

function computeHash(row) {
  const key = [row.CNPJ_Companhia, row.Protocolo_Entrega, row.Assunto].join("|");
  return crypto.createHash("sha256").update(key).digest("hex");
}

async function downloadZip(year) {
  const url = `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_${year}.zip`;
  console.log(`Baixando: ${url}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Falha ao baixar ${url} — status ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, `ipe_${year}.zip`);
  fs.writeFileSync(zipPath, buffer);
  return zipPath;
}

function extractRows(zipPath, year) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntries().find((e) => e.entryName === `ipe_cia_aberta_${year}.csv`);
  if (!entry) throw new Error(`Arquivo ipe_cia_aberta_${year}.csv não encontrado no zip`);

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
  console.log(`\n=== Processando fatos relevantes de ${year} ===`);
  const zipPath = await downloadZip(year);
  const rows = extractRows(zipPath, year);
  const events = rows.filter((r) => r.Categoria === "Fato Relevante");
  console.log(`${rows.length} linhas no total, ${events.length} são Fato Relevante`);

  const client = await pool.connect();
  const companyCache = new Map();

  let inserted = 0;
  let skippedDuplicate = 0;

  try {
    for (const row of events) {
      const hash = computeHash(row);
      const dup = await client.query(
        "SELECT id FROM corporate_events WHERE raw_hash = $1",
        [hash]
      );
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
        `INSERT INTO corporate_events
          (company_id, subject, reference_date, filed_date, document_url, raw_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          companyId,
          row.Assunto,
          parseDate(row.Data_Referencia),
          parseDate(row.Data_Entrega),
          row.Link_Download,
          hash,
        ]
      );
      inserted++;
    }
  } finally {
    client.release();
  }

  console.log(`\nResultado: Inseridos ${inserted}, já existiam ${skippedDuplicate}`);
}

async function main() {
  const year = process.argv[2] || new Date().getFullYear();
  try {
    await ingestYear(Number(year));
  } catch (err) {
    console.error("Erro:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
