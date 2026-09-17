/**
 * PASSO 1 — Inspeção do COTAHIST (cotações históricas da B3)
 *
 * O arquivo descompactado tem ~650MB (todos os ativos da B3 num ano
 * só) — grande demais pra carregar inteiro na memória do plano
 * gratuito do Render. Esse script processa em STREAMING: lê linha por
 * linha direto do zip comprimido, sem nunca materializar o arquivo
 * inteiro como string/array na memória.
 *
 * Rode com: npm run inspect-cotahist [ano]
 */
require("dotenv").config();
const unzipper = require("unzipper");
const readline = require("readline");

function buildCandidateUrls(year) {
  return [
    `https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_A${year}.ZIP`,
    `https://arquivos.b3.com.br/rendafixa/renda-variavel/COTAHIST_A${year}.ZIP`,
  ];
}

async function tryDownload(url) {
  console.log(`Tentando: ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InsideBR/1.0)" },
  });
  console.log(`  Status: ${response.status} ${response.statusText}`);
  if (!response.ok) return null;

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`  Tamanho comprimido: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    console.log("  ⚠️  Não parece ser um ZIP de verdade.");
    return null;
  }
  return buffer;
}

async function main() {
  const year = process.argv[2] || new Date().getFullYear() - 1;
  const candidates = buildCandidateUrls(year);

  let zipBuffer = null;
  let usedUrl = null;
  for (const url of candidates) {
    try {
      zipBuffer = await tryDownload(url);
      if (zipBuffer) {
        usedUrl = url;
        break;
      }
    } catch (err) {
      console.log(`  Erro: ${err.message}`);
    }
  }

  if (!zipBuffer) {
    console.log("\n❌ Nenhuma URL funcionou.");
    return;
  }
  console.log(`\n✅ Baixado de: ${usedUrl}`);

  // unzipper.Open.buffer só lê o INDICE do zip (não descompacta nada
  // ainda) — a descompactação de verdade só acontece quando chamamos
  // .stream(), e isso sai como um fluxo, não um buffer gigante.
  const directory = await unzipper.Open.buffer(zipBuffer);
  console.log(`\nArquivos dentro do zip:`);
  directory.files.forEach((f) =>
    console.log(`  - ${f.path} (${(f.uncompressedSize / 1024 / 1024).toFixed(1)} MB descompactado)`)
  );

  const txtFile = directory.files.find((f) => f.path.toUpperCase().includes("COTAHIST"));
  if (!txtFile) {
    console.log("Não achei um arquivo COTAHIST dentro do zip.");
    return;
  }

  const stream = txtFile.stream();
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineCount = 0;
  let firstLine = null;
  let secondLine = null;
  let lastLine = null;
  let petr4Line = null;
  let sampledCount = 0;
  let bdi02Count = 0;
  const SAMPLE_STEP = 47; // número "estranho" de propósito, pra amostrar sem viés

  for await (const line of rl) {
    lineCount++;
    if (lineCount === 1) firstLine = line;
    if (lineCount === 2) secondLine = line;
    lastLine = line;

    if (lineCount % SAMPLE_STEP === 0 && line.length >= 12) {
      sampledCount++;
      if (line.slice(10, 12) === "02") bdi02Count++;
    }

    if (!petr4Line && line.length >= 24 && line.slice(12, 24).trim() === "PETR4") {
      petr4Line = line;
    }
  }

  console.log(`\nTotal de linhas processadas: ${lineCount.toLocaleString("pt-BR")}`);

  console.log(`\n--- Linha 1 (HEADER, tipo 00) ---`);
  console.log(firstLine);
  console.log(`Tamanho: ${firstLine?.length} caracteres`);

  console.log(`\n--- Linha 2 (primeira cotação, tipo 01) ---`);
  console.log(secondLine);

  console.log(`\n--- Última linha (TRAILER, tipo 99) ---`);
  console.log(lastLine);

  console.log(
    `\nAmostra: ${sampledCount.toLocaleString("pt-BR")} linhas checadas, ${bdi02Count.toLocaleString("pt-BR")} são BDI=02 (lote padrão) — ${((bdi02Count / sampledCount) * 100).toFixed(1)}%`
  );

  if (secondLine) {
    console.log(`\n--- Campos recortados da linha 2 ---`);
    console.log(`TIPREG (1-2):   "${secondLine.slice(0, 2)}"`);
    console.log(`DATA (3-10):    "${secondLine.slice(2, 10)}"`);
    console.log(`CODBDI (11-12): "${secondLine.slice(10, 12)}"`);
    console.log(`CODNEG (13-24): "${secondLine.slice(12, 24)}"`);
    console.log(`NOMRES (28-39): "${secondLine.slice(27, 39)}"`);
    console.log(`PREABE (57-69): "${secondLine.slice(56, 69)}"`);
    console.log(`PREMAX (70-82): "${secondLine.slice(69, 82)}"`);
    console.log(`PREMIN (83-95): "${secondLine.slice(82, 95)}"`);
    console.log(`PREULT (109-121): "${secondLine.slice(108, 121)}"`);
    console.log(`VOLTOT (171-188): "${secondLine.slice(170, 188)}"`);
  }

  if (petr4Line) {
    console.log(`\n--- Linha de exemplo (PETR4) ---`);
    console.log(petr4Line);
    console.log(
      `DATA: "${petr4Line.slice(2, 10)}" | PREABE: "${petr4Line.slice(56, 69)}" | PREULT: "${petr4Line.slice(108, 121)}" | VOLTOT: "${petr4Line.slice(170, 188)}"`
    );
  } else {
    console.log(`\nNão encontrei nenhuma linha de PETR4 nesse arquivo.`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("PRÓXIMO PASSO: me manda essa saída inteira.");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
