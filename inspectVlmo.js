/**
 * PASSO 1 — Inspeção da fonte de dados
 *
 * Antes de escrever o parser final, precisamos ver a estrutura REAL
 * do arquivo que a CVM publica: nomes de colunas, separador, encoding.
 *
 * Este script:
 *  1. Baixa o zip do ano atual de dados.cvm.gov.br
 *  2. Extrai o(s) CSV(s) de dentro
 *  3. Imprime os cabeçalhos e as 3 primeiras linhas de cada arquivo
 *
 * Rode com: npm run inspect-cvm
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");
const { parse } = require("csv-parse/sync");

const BASE_URL =
  process.env.CVM_VLMO_BASE_URL ||
  "https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/VLMO/DADOS";

const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

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

  console.log(`Salvo em: ${zipPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
  return zipPath;
}

function extractAndInspect(zipPath) {
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
      // Os arquivos da CVM geralmente usam encoding Latin-1 (ISO-8859-1)
      // e separador ";" — se a saída vier com caracteres estranhos,
      // é sinal de que precisamos ajustar o encoding aqui.
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

      // Pra colunas categóricas importantes, lista todos os valores únicos —
      // isso é essencial pra saber diferenciar "saldo" de "transação real"
      // (tipo Compra/Venda) na hora de escrever o parser definitivo.
      const categoricalCols = [
        "Tipo_Movimentacao",
        "Tipo_Operacao",
        "Tipo_Cargo",
        "Tipo_Ativo",
        "Caracteristica_Valor_Mobiliario",
      ];
      for (const col of categoricalCols) {
        if (!(col in (records[0] || {}))) continue;
        const uniqueValues = [...new Set(records.map((r) => r[col]))];
        console.log(`\nValores únicos de "${col}" (${uniqueValues.length}):`);
        console.log(uniqueValues);
      }
    } catch (fileErr) {
      console.error(`\nErro ao processar ${entry.entryName}: ${fileErr.message}`);
      console.error("Pulando para o próximo arquivo...");
    }
  }
}

async function main() {
  const year = new Date().getFullYear();

  try {
    const zipPath = await downloadZip(year);
    extractAndInspect(zipPath);

    console.log(`\n${"=".repeat(60)}`);
    console.log("PRÓXIMO PASSO:");
    console.log(
      "Copie os nomes de colunas acima e me envie — vou usar isso pra"
    );
    console.log(
      "escrever o parser definitivo (fetchVlmo.js) mapeando cada campo"
    );
    console.log("certinho pro schema do banco.");
    console.log("=".repeat(60));
  } catch (err) {
    console.error("\nErro durante a inspeção:", err.message);
    console.error(
      "\nSe o erro for 404, tente trocar o ano no script (talvez o arquivo do ano atual ainda não exista — use o ano anterior pra testar)."
    );
  }
}

main();
