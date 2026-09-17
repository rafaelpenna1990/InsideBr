require("dotenv").config();
const AdmZip = require("adm-zip");

const YEAR = process.argv[2] || "2025";
const DATA_URL = `https://dados.cvm.gov.br/dados/CIA_ABERTA/DOC/VLMO/DADOS/vlmo_cia_aberta_${YEAR}.zip`;

async function main() {
  console.log(`Baixando: ${DATA_URL}`);
  const response = await fetch(DATA_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((e) => e.entryName === `vlmo_cia_aberta_con_${YEAR}.csv`);
  const content = zip.readFile(entry).toString("latin1");
  const lines = content.split(/\r?\n/).filter((l) => l.trim());
  const header = lines[0].split(";").map((h) => h.trim());
  const idxMov = header.indexOf("Tipo_Movimentacao");
  const idxCargo = header.indexOf("Tipo_Cargo");

  const movTypes = new Map();
  const cargoTypes = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(";");
    const mov = cols[idxMov];
    const cargo = cols[idxCargo];
    movTypes.set(mov, (movTypes.get(mov) || 0) + 1);
    cargoTypes.set(cargo, (cargoTypes.get(cargo) || 0) + 1);
  }

  console.log("\n--- Tipo_Movimentacao (todos os valores distintos) ---");
  [...movTypes.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v.toString().padStart(6)}  "${k}"`));

  console.log("\n--- Tipo_Cargo (todos os valores distintos) ---");
  [...cargoTypes.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v.toString().padStart(6)}  "${k}"`));

  // Mostra uma linha de exemplo de Saldo Final, se existir
  const finalIdx = lines.findIndex((l, i) => i > 0 && l.split(";")[idxMov] === "Saldo Final");
  if (finalIdx > 0) {
    console.log("\n--- Exemplo de linha 'Saldo Final' ---");
    const cols = lines[finalIdx].split(";");
    const row = {};
    header.forEach((h, i) => (row[h] = cols[i]));
    console.log(JSON.stringify(row, null, 2));
  }
}

main().catch((err) => console.error("Erro:", err.message));
