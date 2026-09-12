/**
 * Inspeciona o dataset IPE (Informações Periódicas e Eventuais) da CVM,
 * que deve conter "Fato Relevante" como uma das categorias de documento.
 * Objetivo: descobrir as colunas e confirmar como filtrar só fatos
 * relevantes (sem baixar o PDF/HTML inteiro, só o resumo estruturado).
 *
 * Rode com: npm run inspect-ipe
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");

const YEAR = new Date().getFullYear();
const URL = `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/IPE/DADOS/ipe_cia_aberta_${YEAR}.zip`;
const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

async function main() {
  console.log(`Baixando: ${URL}`);
  const response = await fetch(URL);
  if (!response.ok) {
    throw new Error(`Falha ao baixar — status ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, "ipe.zip");
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

      // Categoria é o campo que provavelmente distingue "Fato Relevante"
      // de outros tipos de documento (comunicado, aviso aos acionistas, etc.)
      if ("Categoria" in (records[0] || {})) {
        const categorias = [...new Set(records.map((r) => r.Categoria))];
        console.log(`\nValores únicos de "Categoria" (${categorias.length}):`);
        console.log(categorias);
      }

      const fatoRelevante = records.filter(
        (r) => r.Categoria && r.Categoria.toLowerCase().includes("fato relevante")
      );
      console.log(`\nLinhas que parecem ser "Fato Relevante": ${fatoRelevante.length}`);
      console.log(`\nPrimeiras 3 amostras de Fato Relevante:`);
      console.log(JSON.stringify(fatoRelevante.slice(0, 3), null, 2));
    } catch (fileErr) {
      console.error(`\nErro ao processar ${entry.entryName}: ${fileErr.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
