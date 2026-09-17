/**
 * Ingestão do conjunto "Programa de Recompra de Ações" da CVM — dado
 * oficial e estruturado (dataset novo, lançado em nov/2025), no lugar
 * de tentar adivinhar recompra pelo texto do fato relevante.
 *
 * Roda com: npm run ingest-recompra-cvm
 */
require("dotenv").config();
const AdmZip = require("adm-zip");
const pool = require("../db/pool");

const DATA_URL =
  "https://dados.cvm.gov.br/dados/CIA_ABERTA/EVENTOS/RECOMPRA_ACOES/DADOS/cia_aberta_recompra_acoes.zip";

// Parser de CSV simples — os campos da CVM não têm ponto-e-vírgula
// dentro de aspas em nenhuma coluna desse conjunto (conferido na
// inspeção), então um split direto por ";" é seguro aqui.
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
  return str && str.length === 10 ? str : null; // já vem como AAAA-MM-DD
}

function toNumber(str) {
  if (!str) return null;
  const n = Number(str);
  return isNaN(n) ? null : n;
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
  const mainCsv = zip.getEntries().find((e) => e.entryName === "cia_aberta_recompra_acoes.csv");
  const qtyCsv = zip
    .getEntries()
    .find((e) => e.entryName === "cia_aberta_recompra_acoes_quantidades.csv");

  const programs = parseCsv(zip.readFile(mainCsv).toString("latin1"));
  const quantidades = qtyCsv ? parseCsv(zip.readFile(qtyCsv).toString("latin1")) : [];

  // A tabela principal só tem UMA linha de quantidade por classe às
  // vezes vazia — o detalhe de verdade está no arquivo de quantidades,
  // então soma por ID_Programa e tipo de ação, pra ficar num campo só.
  const qtyByProgram = new Map();
  for (const q of quantidades) {
    const id = q.ID_Programa;
    if (!qtyByProgram.has(id)) qtyByProgram.set(id, { ordinaria: 0, preferencial: 0 });
    const bucket = qtyByProgram.get(id);
    const qtd = toNumber(q.Quantidade_Operacao) || 0;
    if (q.Tipo_Acao === "ORDINÁRIAS") bucket.ordinaria += qtd;
    else if (q.Tipo_Acao === "PREFERENCIAIS") bucket.preferencial += qtd;
  }

  console.log(`Programas encontrados: ${programs.length}`);

  let matched = 0;
  let notFound = 0;
  let batch = [];
  const BATCH_SIZE = 200;

  async function flush() {
    if (batch.length === 0) return;
    const values = [];
    const placeholders = [];
    batch.forEach((row, i) => {
      const base = i * 9;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`
      );
      values.push(
        row.company_id,
        row.cvm_program_id,
        row.deliberation_date,
        row.deadline_date,
        row.status,
        row.operation_type,
        row.reason,
        row.qty_ordinary,
        row.qty_preferred
      );
    });
    await pool.query(
      `
      INSERT INTO buyback_programs
        (company_id, cvm_program_id, deliberation_date, deadline_date, status, operation_type, reason, qty_ordinary, qty_preferred)
      VALUES ${placeholders.join(", ")}
      ON CONFLICT (cvm_program_id) DO UPDATE SET
        deliberation_date = EXCLUDED.deliberation_date,
        deadline_date = EXCLUDED.deadline_date,
        status = EXCLUDED.status,
        operation_type = EXCLUDED.operation_type,
        reason = EXCLUDED.reason,
        qty_ordinary = EXCLUDED.qty_ordinary,
        qty_preferred = EXCLUDED.qty_preferred
      `,
      values
    );
    batch = [];
  }

  for (const p of programs) {
    const companyResult = await pool.query("SELECT id FROM companies WHERE cnpj = $1", [
      p.CNPJ_Companhia,
    ]);
    if (companyResult.rows.length === 0) {
      notFound++;
      continue;
    }
    matched++;
    const qty = qtyByProgram.get(p.ID_Programa) || { ordinaria: 0, preferencial: 0 };

    batch.push({
      company_id: companyResult.rows[0].id,
      cvm_program_id: toNumber(p.ID_Programa),
      deliberation_date: toDate(p.Data_Deliberacao),
      deadline_date: toDate(p.Data_Final_Prazo),
      status: p.Situacao || null,
      operation_type: p.Tipo_Operacao || null,
      reason: p.Motivo || null,
      qty_ordinary: toNumber(p.Quantidade_Acoes_Ordinarias) || qty.ordinaria || null,
      qty_preferred: toNumber(p.Quantidade_Acoes_Preferenciais) || qty.preferencial || null,
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  console.log(`\nEmpresas nossas com programa de recompra: ${matched}`);
  console.log(`Programas de empresas que não temos mapeadas: ${notFound}`);

  await pool.end();
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
