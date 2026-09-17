/**
 * PASSO 1 — Inspeção do COTAHIST (cotações históricas da B3)
 *
 * Formato diferente de tudo que já ingerimos até agora: é um arquivo
 * de LARGURA FIXA (fixed-width), não CSV com separador. Cada linha
 * tem exatamente 245 caracteres, com campos em posições fixas.
 *
 * Rode com: npm run inspect-cotahist [ano]
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const TMP_DIR = path.join(__dirname, "..", "..", "tmp");

// Candidatos de URL — a B3 não documenta isso num link direto e
// estável (o portal deles é uma página em JavaScript), então testamos
// o padrão mais usado por ferramentas open-source há mais de uma
// década. Se o primeiro falhar, tentamos o próximo.
function buildCandidateUrls(year) {
  return [
    `https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_A${year}.ZIP`,
    `https://arquivos.b3.com.br/rendafixa/renda-variavel/COTAHIST_A${year}.ZIP`,
    `https://www.b3.com.br/pesquisapregao/download?filelist=COTAHIST_A${year}.ZIP`,
  ];
}

async function tryDownload(url) {
  console.log(`Tentando: ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  console.log(`  Status: ${response.status} ${response.statusText}`);
  console.log(`  Content-Type: ${response.headers.get("content-type")}`);
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`  Tamanho: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  // Confere se realmente é um ZIP (assinatura "PK") — às vezes um
  // link errado devolve uma página HTML de erro com status 200.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    console.log("  ⚠️  Não parece ser um arquivo ZIP de verdade (sem assinatura PK).");
    console.log("  Primeiros 300 caracteres da resposta:");
    console.log("  " + buffer.toString("utf-8", 0, 300).replace(/\n/g, " "));
    return null;
  }

  return buffer;
}

async function main() {
  const year = process.argv[2] || new Date().getFullYear() - 1;
  const candidates = buildCandidateUrls(year);

  let buffer = null;
  let usedUrl = null;
  for (const url of candidates) {
    try {
      buffer = await tryDownload(url);
      if (buffer) {
        usedUrl = url;
        break;
      }
    } catch (err) {
      console.log(`  Erro: ${err.message}`);
    }
  }

  if (!buffer) {
    console.log("\n❌ Nenhuma das URLs candidatas funcionou.");
    console.log("Preciso que você confirme a URL certa — abre esse link no navegador,");
    console.log("baixa o arquivo do ano manualmente, e me diz qual foi o link real:");
    console.log("https://www.b3.com.br/pt_br/market-data-e-indices/servicos-de-dados/market-data/historico/mercado-a-vista/cotacoes-historicas/");
    return;
  }

  console.log(`\n✅ Sucesso com: ${usedUrl}`);

  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, `cotahist_${year}.zip`);
  fs.writeFileSync(zipPath, buffer);

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  console.log(`\nArquivos dentro do zip:`);
  entries.forEach((e) => console.log(`  - ${e.entryName} (${e.header.size} bytes)`));

  const txtEntry = entries.find((e) => e.entryName.toUpperCase().includes("COTAHIST"));
  if (!txtEntry) {
    console.log("Não achei um arquivo COTAHIST dentro do zip.");
    return;
  }

  const content = zip.readFile(txtEntry).toString("latin1");
  const lines = content.split(/\r?\n/).filter(Boolean);
  console.log(`\nTotal de linhas: ${lines.length}`);

  console.log(`\n--- Linha 1 (deveria ser o HEADER, tipo 00) ---`);
  console.log(lines[0]);
  console.log(`Tamanho da linha: ${lines[0].length} caracteres`);

  console.log(`\n--- Linha 2 (primeira cotação, tipo 01) ---`);
  console.log(lines[1]);

  console.log(`\n--- Última linha (deveria ser o TRAILER, tipo 99) ---`);
  console.log(lines[lines.length - 1]);

  // Recorte de campos conhecidos da linha 2, pra conferir se as
  // posições batem com o layout oficial da B3:
  // TIPREG(1-2) DATA(3-10) CODBDI(11-12) CODNEG(13-24) NOMRES(28-39)
  // PREABE(57-69) PREMAX(70-82) PREMIN(83-95) PREULT(109-121) VOLTOT(171-188)
  const l = lines[1];
  console.log(`\n--- Campos recortados da linha 2 (conferir se fazem sentido) ---`);
  console.log(`TIPREG (1-2):   "${l.slice(0, 2)}"`);
  console.log(`DATA (3-10):    "${l.slice(2, 10)}"`);
  console.log(`CODBDI (11-12): "${l.slice(10, 12)}"`);
  console.log(`CODNEG (13-24): "${l.slice(12, 24)}"`);
  console.log(`NOMRES (28-39): "${l.slice(27, 39)}"`);
  console.log(`PREABE (57-69): "${l.slice(56, 69)}"`);
  console.log(`PREMAX (70-82): "${l.slice(69, 82)}"`);
  console.log(`PREMIN (83-95): "${l.slice(82, 95)}"`);
  console.log(`PREULT (109-121): "${l.slice(108, 121)}"`);
  console.log(`VOLTOT (171-188): "${l.slice(170, 188)}"`);

  console.log(`\n${"=".repeat(60)}`);
  console.log("PRÓXIMO PASSO: me manda essa saída inteira, vou usar pra");
  console.log("confirmar as posições dos campos e escrever o parser definitivo.");
  console.log("=".repeat(60));
}

main();
