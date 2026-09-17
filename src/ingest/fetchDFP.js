/**
 * Ingestão do DFP (Demonstrações Financeiras Padronizadas) — versão
 * enxuta: só DRE, BPA e BPP consolidados, só contas FIXAS (o "elenco
 * padrão" da CVM, igual pra toda empresa), só o ano mais recente
 * (ORDEM_EXERC = ÚLTIMO). Fluxo de caixa, mutações do patrimônio e
 * valor adicionado ficam de fora por enquanto.
 *
 * Roda com: npm run ingest-dfp [ano]
 */
require("dotenv").config();
const AdmZip = require("adm-zip");
const pool = require("../db/pool");

const BASE_URL = "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS";
const STATEMENTS = ["DRE", "BPA", "BPP"];

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(";").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = line.split(";");
    const row = {};
    header.forEach((h, i) => (row[h] = (cols[i] || "").trim()));
    return row;
  });
}

function toNumber(str) {
  if (!str) return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

function computeHash(companyCnpj, statementType, refDate, accountCode) {
  const crypto = require("crypto");
  return crypto
    .createHash("sha256")
    .update([companyCnpj, statementType, refDate, accountCode].join("|"))
    .digest("hex");
}

async function ingestYear(year) {
  console.log(`\n=== DFP ${year} ===`);
  const url = `${BASE_URL}/dfp_cia_aberta_${year}.zip`;
  console.log(`Baixando: ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  if (!response.ok) throw new Error(`Falha ao baixar (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`Baixado: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  const zip = new AdmZip(buffer);

  // Mapa de CNPJ -> company_id, pra não fazer query por linha.
  const companiesResult = await pool.query("SELECT id, cnpj FROM companies");
  const cnpjToId = new Map(companiesResult.rows.map((c) => [c.cnpj, c.id]));

  let totalInserted = 0;
  let totalNoCompany = 0;

  for (const statementType of STATEMENTS) {
    const entryName = `dfp_cia_aberta_${statementType}_con_${year}.csv`;
    const entry = zip.getEntries().find((e) => e.entryName === entryName);
    if (!entry) {
      console.log(`  ${entryName}: não encontrado, pulando.`);
      continue;
    }
    const rows = parseCsv(zip.readFile(entry).toString("latin1"));
    console.log(`  ${entryName}: ${rows.length} linhas no arquivo`);

    // Algumas empresas reapresentam o DFP (corrigem e reenviam) — fica
    // mais de uma VERSAO pro mesmo período. Mantém só a mais recente
    // por (empresa, conta), senão duas linhas colidem no mesmo hash.
    const latestByKey = new Map();
    for (const row of rows) {
      if (row.ST_CONTA_FIXA !== "S") continue;
      if (row.ORDEM_EXERC !== "ÚLTIMO") continue;
      const key = `${row.CNPJ_CIA}|${row.DT_REFER}|${row.CD_CONTA}`;
      const existing = latestByKey.get(key);
      if (!existing || Number(row.VERSAO) > Number(existing.VERSAO)) {
        latestByKey.set(key, row);
      }
    }
    const dedupedRows = [...latestByKey.values()];
    console.log(`    Após deduplicar por versão: ${dedupedRows.length}`);

    let batch = [];
    const BATCH_SIZE = 200;
    let inserted = 0;

    async function flush() {
      if (batch.length === 0) return;
      const values = [];
      const placeholders = [];
      batch.forEach((row, i) => {
        const base = i * 8;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`
        );
        values.push(
          row.company_id,
          row.statement_type,
          row.reference_date,
          row.period_end,
          row.account_code,
          row.account_description,
          row.value,
          row.raw_hash
        );
      });
      await pool.query(
        `
        INSERT INTO financial_statements
          (company_id, statement_type, reference_date, period_end, account_code, account_description, value, raw_hash)
        VALUES ${placeholders.join(", ")}
        ON CONFLICT (raw_hash) DO UPDATE SET value = EXCLUDED.value
        `,
        values
      );
      batch = [];
    }

    for (const row of dedupedRows) {
      const companyId = cnpjToId.get(row.CNPJ_CIA);
      if (!companyId) {
        totalNoCompany++;
        continue;
      }

      batch.push({
        company_id: companyId,
        statement_type: statementType,
        reference_date: row.DT_REFER,
        period_end: row.DT_FIM_EXERC,
        account_code: row.CD_CONTA,
        account_description: row.DS_CONTA,
        value: toNumber(row.VL_CONTA),
        raw_hash: computeHash(row.CNPJ_CIA, statementType, row.DT_REFER, row.CD_CONTA),
      });
      inserted++;

      if (batch.length >= BATCH_SIZE) await flush();
    }
    await flush();
    console.log(`    Gravadas: ${inserted}`);
    totalInserted += inserted;
  }

  console.log(`\nTotal gravado: ${totalInserted}`);
  console.log(`Linhas de empresas que não temos mapeadas: ${totalNoCompany}`);
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
