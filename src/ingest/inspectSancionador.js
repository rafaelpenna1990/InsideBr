/**
 * PASSO 1 — Inspeção do conjunto "Processos Sancionadores" da CVM
 * (Processos Administrativos Sancionadores — PAS).
 *
 * Rode com: npm run inspect-sancionador
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const TMP_DIR = path.join(__dirname, "..", "..", "tmp");
const META_URL = "https://dados.cvm.gov.br/dados/PROCESSO/SANCIONADOR/META/meta_processo_sancionador.zip";
const DATA_URL = "https://dados.cvm.gov.br/dados/PROCESSO/SANCIONADOR/DADOS/processo_sancionador.zip";

async function downloadTo(url, filename) {
  console.log(`\nBaixando: ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  console.log(`  Status: ${response.status}`);
  if (!response.ok) throw new Error(`Falha ao baixar (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const filePath = path.join(TMP_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  console.log(`  Salvo em: ${filePath} (${(buffer.length / 1024).toFixed(1)} KB)`);
  return filePath;
}

function inspectCsv(zipPath, label) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  console.log(`\nO zip "${label}" contém ${entries.length} arquivo(s):`);
  entries.forEach((e) => console.log(`  - ${e.entryName}`));

  entries
    .filter((e) => e.entryName.endsWith(".csv"))
    .forEach((entry) => {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`Inspecionando: ${entry.entryName}`);
      console.log("=".repeat(60));
      const content = zip.readFile(entry).toString("latin1");
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      console.log(`\nTotal de linhas: ${lines.length}`);
      const header = lines[0].split(";").map((h) => h.trim());
      console.log("\nColunas encontradas:");
      console.log(JSON.stringify(header, null, 2));

      console.log("\nPrimeiras 3 linhas (amostra):");
      const sample = lines.slice(1, 4).map((line) => {
        const cols = line.split(";");
        const row = {};
        header.forEach((h, i) => (row[h] = (cols[i] || "").trim()));
        return row;
      });
      console.log(JSON.stringify(sample, null, 2));
    });
}

async function main() {
  const metaPath = await downloadTo(META_URL, "sancionador_meta.zip");
  inspectCsv(metaPath, "dicionário de dados");

  const dataPath = await downloadTo(DATA_URL, "sancionador.zip");
  inspectCsv(dataPath, "dados");

  console.log(`\n${"=".repeat(60)}`);
  console.log("PRÓXIMO PASSO: me manda essa saída inteira.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
