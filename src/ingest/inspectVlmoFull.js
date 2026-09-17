/**
 * Inspeciona TODOS os arquivos dentro do zip do VLMO (não só o de
 * negociações que já usamos) — pra ver se tem tabela de POSIÇÃO/
 * QUANTIDADE DETIDA que ainda não capturamos.
 *
 * Roda com: npm run inspect-vlmo-full
 */
require("dotenv").config();
const AdmZip = require("adm-zip");

const YEAR = process.argv[2] || "2025";
const DATA_URL = `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/VLMO/DADOS/vlmo_cia_aberta_${YEAR}.zip`;

async function main() {
  console.log(`Baixando: ${DATA_URL}`);
  const response = await fetch(DATA_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  console.log(`Status: ${response.status}`);
  if (!response.ok) throw new Error(`Falha (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`Baixado: ${(buffer.length / 1024).toFixed(1)} KB`);

  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();
  console.log(`\nO zip contém ${entries.length} arquivo(s):`);
  entries.forEach((e) => console.log(`  - ${e.entryName} (${(e.header.size / 1024).toFixed(1)} KB)`));

  // Mostra o cabeçalho de CADA csv, pra entender o que cada um guarda
  for (const entry of entries.filter((e) => e.entryName.endsWith(".csv"))) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Cabeçalho de: ${entry.entryName}`);
    console.log("=".repeat(60));
    const content = zip.readFile(entry).toString("latin1");
    const lines = content.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].split(";");
    console.log(JSON.stringify(header, null, 2));
    console.log(`Total de linhas: ${lines.length}`);
    if (lines[1]) {
      console.log("\nExemplo de linha:");
      const cols = lines[1].split(";");
      const row = {};
      header.forEach((h, i) => (row[h.trim()] = cols[i]));
      console.log(JSON.stringify(row, null, 2));
    }
  }
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
