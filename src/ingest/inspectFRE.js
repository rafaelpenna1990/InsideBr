/**
 * PASSO 1 — Inspeção do Formulário de Referência (FRE)
 *
 * O FRE tem dezenas de arquivos dentro do zip — só nos interessam 3:
 *  - fre_cia_aberta_distribuicao_capital: free float ano a ano
 *  - fre_cia_plano_recompra: programas de recompra autorizados
 *  - fre_cia_aberta_posicao_acionaria: posição acionária / controlador
 *
 * Rode com: npm run inspect-fre
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");

const BASE_URL =
  process.env.CVM_FRE_BASE_URL || "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/FRE/DADOS";

const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

const TARGET_FILES = [
  "fre_cia_aberta_distribuicao_capital.csv",
  "fre_cia_plano_recompra.csv",
  "fre_cia_aberta_posicao_acionaria.csv",
];

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

  console.log(`Salvo em: ${zipPath} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  return zipPath;
}

function extractAndInspect(zipPath) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  console.log(`\nO zip contém ${entries.length} arquivo(s) no total.`);
  console.log("Arquivos que batem com os que procuramos:");
  const matches = entries.filter((e) =>
    TARGET_FILES.some((t) => e.entryName.toLowerCase().includes(t.toLowerCase().replace(".csv", "")))
  );
  matches.forEach((e) => console.log(`  - ${e.entryName}`));

  if (matches.length === 0) {
    console.log("\nNenhum arquivo bateu com o esperado — lista completa do zip:");
    entries.forEach((e) => console.log(`  - ${e.entryName}`));
    return;
  }

  for (const entry of matches) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Inspecionando: ${entry.entryName}`);
    console.log("=".repeat(60));

    try {
      const rawContent = zip.readFile(entry).toString("latin1");

      const records = parse(rawContent, {
        delimiter: ";",
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
        escape: "\\",
      });

      console.log(`\nTotal de linhas: ${records.length}`);
      console.log(`\nColunas encontradas:`);
      console.log(Object.keys(records[0] || {}));

      console.log(`\nPrimeiras 3 linhas (amostra):`);
      console.log(JSON.stringify(records.slice(0, 3), null, 2));
    } catch (fileErr) {
      console.error(`\nErro ao processar ${entry.entryName}: ${fileErr.message}`);
    }
  }
}

async function main() {
  // FRE de anos anteriores tende a ser mais estável (o ano corrente
  // pode ter poucas empresas que já entregaram) — tenta o ano passado
  // primeiro, que tem mais dado pra inspecionar de verdade.
  const year = new Date().getFullYear() - 1;

  try {
    const zipPath = await downloadZip(year);
    extractAndInspect(zipPath);

    console.log(`\n${"=".repeat(60)}`);
    console.log("PRÓXIMO PASSO:");
    console.log("Copie a saída acima (colunas + amostra dos 3 arquivos) e me");
    console.log("envie — vou usar isso pra escrever o parser definitivo.");
    console.log("=".repeat(60));
  } catch (err) {
    console.error("\nErro durante a inspeção:", err.message);
  }
}

main();
