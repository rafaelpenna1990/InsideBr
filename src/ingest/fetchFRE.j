require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");
const pool = require("../db/pool");

const BASE_URL =
  process.env.CVM_FRE_BASE_URL || "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FRE/DADOS";
const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

async function downloadZip(year) {
  const url = `${BASE_URL}/fre_cia_aberta_${year}.zip`;
  console.log(`Baixando: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Falha ao baixar ${url} — status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const zipPath = path.join(TMP_DIR, `fre_${year}.zip`);

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.writeFileSync(zipPath, buffer);
  return zipPath;
}

function readCsvFromZip(zip, filenameSuffix) {
  const entry = zip
    .getEntries()
    .find((e) => e.entryName.toLowerCase().includes(filenameSuffix.toLowerCase()));
  if (!entry) return [];

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

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : value; // já vem em formato ISO (YYYY-MM-DD)
}

function parseIntSafe(value) {
  const n = parseInt(value, 10);
  return isNaN(n) ? null : n;
}

function parseFloatSafe(value) {
  const n = parseFloat(value);
  return isNaN(n) ? null : n;
}

function hashRow(...parts) {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
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
  console.log(`\n=== FRE ${year} ===`);
  const zipPath = await downloadZip(year);
  const zip = new AdmZip(zipPath);

  const capitalRows = readCsvFromZip(zip, "distribuicao_capital_" + year);
  const shareholderRows = readCsvFromZip(zip, "posicao_acionaria_" + year);

  console.log(
    `${capitalRows.length} linhas de distribuição de capital, ${shareholderRows.length} linhas de posição acionária`
  );

  const client = await pool.connect();
  const companyCache = new Map();

  // ── Estrutura de capital (free float) ──
  let capitalInserted = 0;
  let capitalSkipped = 0;
  for (const row of capitalRows) {
    if (!row.CNPJ_Companhia || !row.Data_Referencia) continue;

    let companyId = companyCache.get(row.CNPJ_Companhia);
    if (!companyId) {
      companyId = await upsertCompany(client, row.CNPJ_Companhia, row.Nome_Companhia);
      companyCache.set(row.CNPJ_Companhia, companyId);
    }

    const hash = hashRow("capital", row.CNPJ_Companhia, row.Data_Referencia, row.Versao);
    const existing = await client.query(
      "SELECT id FROM capital_structure WHERE raw_hash = $1",
      [hash]
    );
    if (existing.rows.length > 0) {
      capitalSkipped++;
      continue;
    }

    await client.query(
      `
      INSERT INTO capital_structure
        (company_id, reference_date, free_float_shares, free_float_percent,
         shareholders_pf, shareholders_pj, shareholders_institutional,
         last_assembly_date, raw_hash)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        companyId,
        parseDate(row.Data_Referencia),
        parseIntSafe(row.Quantidade_Total_Acoes_Circulacao),
        parseFloatSafe(row.Percentual_Total_Acoes_Circulacao),
        parseIntSafe(row.Quantidade_Acionistas_PF),
        parseIntSafe(row.Quantidade_Acionistas_PJ),
        parseIntSafe(row.Quantidade_Acionistas_Investidores_Institucionais),
        parseDate(row.Data_Ultima_Assembleia),
        hash,
      ]
    );
    capitalInserted++;
  }
  console.log(`Estrutura de capital: ${capitalInserted} inseridas, ${capitalSkipped} já existiam`);

  // ── Acionista controlador (só as linhas marcadas como controlador) ──
  let controllerInserted = 0;
  let controllerSkipped = 0;
  for (const row of shareholderRows) {
    if (row.Acionista_Controlador !== "S") continue;
    if (!row.CNPJ_Companhia || !row.Data_Referencia) continue;

    let companyId = companyCache.get(row.CNPJ_Companhia);
    if (!companyId) {
      companyId = await upsertCompany(client, row.CNPJ_Companhia, row.Nome_Companhia);
      companyCache.set(row.CNPJ_Companhia, companyId);
    }

    const hash = hashRow(
      "controller",
      row.CNPJ_Companhia,
      row.Data_Referencia,
      row.Versao,
      row.ID_Acionista
    );
    const existing = await client.query(
      "SELECT id FROM controlling_shareholders WHERE raw_hash = $1",
      [hash]
    );
    if (existing.rows.length > 0) {
      controllerSkipped++;
      continue;
    }

    await client.query(
      `
      INSERT INTO controlling_shareholders
        (company_id, reference_date, shareholder_name, shareholder_document, percent_total, raw_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        companyId,
        parseDate(row.Data_Referencia),
        row.Acionista,
        row.CPF_CNPJ_Acionista || null,
        parseFloatSafe(row.Percentual_Total_Acoes_Circulacao),
        hash,
      ]
    );
    controllerInserted++;
  }
  console.log(
    `Acionista controlador: ${controllerInserted} inseridas, ${controllerSkipped} já existiam`
  );

  client.release();
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
