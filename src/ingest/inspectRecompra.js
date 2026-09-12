/**
 * Inspeciona o dataset de Programas de Recompra de Ações da CVM,
 * pra descobrir os nomes reais das colunas antes de escrever o
 * parser definitivo (mesmo processo que fizemos com o VLMO).
 *
 * Rode com: npm run inspect-recompra
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");

const URL =
  "https://dados.cvm.gov.br/dados/CIA_ABERTA/EVENTOS/RECOMPRA_ACOES/DADOS/cia_aberta_recompra_acoes.zip";
const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

async function main() {
  console.log(`Baixando: ${URL}`);
  const response = await fetch(URL);
  if (!response.ok) {
    throw new Error(`Falha ao baixar — status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, "recompra.zip");
  fs.writeFileSync(zipPath, buffer);
  console.log(`Salvo em: ${zipPath} (${(buffer.length / 1024).toFixed(0)} KB)`);

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  console.log(`\nO zip contém ${entries.length} arquivo(s):`);
  entries.forEach((e) => console.log(`  - ${e.entryName}`));

  for (const entry of entries) {
    if (!entry.entryName.toLowerCase().endsWith(".csv")) continue;

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

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
