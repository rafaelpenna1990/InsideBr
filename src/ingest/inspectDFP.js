/**
 * Inspeção do conjunto DFP (Demonstrações Financeiras Padronizadas) —
 * bem maior que tudo que já processamos, então primeiro só lista o
 * que tem dentro do zip antes de decidir o que vale a pena ingerir.
 *
 * Roda com: npm run inspect-dfp [ano]
 */
require("dotenv").config();
const AdmZip = require("adm-zip");

const YEAR = process.argv[2] || "2025";
const DATA_URL = `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/DFP/DADOS/dfp_cia_aberta_${YEAR}.zip`;

async function main() {
  console.log(`Baixando: ${DATA_URL}`);
  const response = await fetch(DATA_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  console.log(`Status: ${response.status}`);
  if (!response.ok) throw new Error(`Falha (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`Baixado: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  console.log(`\nO zip contém ${entries.length} arquivo(s):`);
  entries.forEach((e) =>
    console.log(`  - ${e.entryName} (${(e.header.size / 1024).toFixed(1)} KB)`)
  );

  // Mostra o cabeçalho + 1 linha de exemplo de cada CSV, só pra
  // entender a forma de cada um sem processar tudo ainda.
  for (const entry of entries.filter((e) => e.entryName.endsWith(".csv"))) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${entry.entryName}`);
    console.log("=".repeat(60));
    const content = zip.readFile(entry).toString("latin1");
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(";");
    console.log(`Colunas: ${JSON.stringify(header)}`);
    console.log(`Total de linhas: ${lines.length}`);
    if (lines[1]) {
      const cols = lines[1].split(";");
      const row = {};
      header.forEach((h, i) => (row[h.trim()] = cols[i]));
      console.log("Exemplo:", JSON.stringify(row));
    }
  }
}

main().catch((err) => console.error("Erro:", err.message));
