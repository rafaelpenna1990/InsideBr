/**
 * Ingestão do conjunto "Processos Sancionadores" da CVM. Sem CNPJ nos
 * dados — a ligação com empresa é por nome EXATO (maiúsculo/sem
 * espaço nas pontas), pra não repetir o erro de mapeamento por
 * aproximação que já corrigimos antes nos tickers.
 *
 * Roda com: npm run ingest-sancionador
 */
require("dotenv").config();
const AdmZip = require("adm-zip");
const pool = require("../db/pool");

const DATA_URL = "https://dados.cvm.gov.br/dados/PROCESSO/SANCIONADOR/DADOS/processo_sancionador.zip";

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

function toDate(str) {
  return str && str.length === 10 ? str : null;
}

async function main() {
  console.log(`Baixando: ${DATA_URL}`);
  const response = await fetch(DATA_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  if (!response.ok) throw new Error(`Falha ao baixar (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`Baixado: ${(buffer.length / 1024).toFixed(1)} KB`);

  const zip = new AdmZip(buffer);
  const mainCsv = zip.getEntries().find((e) => e.entryName === "processo_sancionador.csv");
  const accusedCsv = zip
    .getEntries()
    .find((e) => e.entryName === "processo_sancionador_acusado.csv");

  const processes = parseCsv(zip.readFile(mainCsv).toString("latin1"));
  const accused = parseCsv(zip.readFile(accusedCsv).toString("latin1"));
  console.log(`Processos: ${processes.length} | Acusados: ${accused.length}`);

  // Mapa de nome exato -> company_id, pra não fazer uma query por linha.
  const companiesResult = await pool.query("SELECT id, name FROM companies");
  const nameToId = new Map();
  for (const c of companiesResult.rows) {
    nameToId.set(c.name.trim().toUpperCase(), c.id);
  }

  console.log("\nGravando processos...");
  for (const p of processes) {
    await pool.query(
      `
      INSERT INTO sanctioning_processes (nup, subject, summary, opened_date, current_phase, current_subphase, last_movement_date)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (nup) DO UPDATE SET
        subject = EXCLUDED.subject, summary = EXCLUDED.summary,
        current_phase = EXCLUDED.current_phase, current_subphase = EXCLUDED.current_subphase,
        last_movement_date = EXCLUDED.last_movement_date
      `,
      [
        p.NUP,
        p.Objeto || null,
        p.Ementa || null,
        toDate(p.Data_Abertura),
        p.Fase_Atual || null,
        p.Subfase_Atual || null,
        toDate(p.Data_Ultima_Movimentacao),
      ]
    );
  }

  console.log("Gravando acusados e tentando achar a empresa correspondente...");
  let matched = 0;
  await pool.query("DELETE FROM sanctioning_process_accused"); // reconstrói do zero, mais simples que fazer upsert com chave composta
  let batch = [];
  const BATCH_SIZE = 200;

  async function flush() {
    if (batch.length === 0) return;
    const values = [];
    const placeholders = [];
    batch.forEach((row, i) => {
      const base = i * 5;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
      );
      values.push(row.nup, row.company_id, row.accused_name, row.situation, row.situation_date);
    });
    await pool.query(
      `INSERT INTO sanctioning_process_accused (nup, company_id, accused_name, situation, situation_date)
       VALUES ${placeholders.join(", ")}`,
      values
    );
    batch = [];
  }

  for (const a of accused) {
    const companyId = nameToId.get((a.Nome_Acusado || "").trim().toUpperCase()) || null;
    if (companyId) matched++;
    batch.push({
      nup: a.NUP,
      company_id: companyId,
      accused_name: a.Nome_Acusado || null,
      situation: a.Situacao || null,
      situation_date: toDate(a.Data_Situacao),
    });
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`\nAcusados ligados a uma empresa nossa por nome exato: ${matched}`);
  console.log(`(o resto são pessoas físicas ou empresas com nome escrito diferente do nosso)`);

  await pool.end();
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
