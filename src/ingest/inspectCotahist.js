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

  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  console.log(`\nArquivos dentro do zip:`);
  entries.forEach((e) => console.log(`  - ${e.entryName} (${(e.header.size / 1024 / 1024).toFixed(1)} MB)`));

  const txtEntry = entries.find((e) => e.entryName.toUpperCase().includes("COTAHIST"));
  if (!txtEntry) {
    console.log("Não achei um arquivo COTAHIST dentro do zip.");
    return;
  }

  // O arquivo descompactado tem centenas de MB (tem TODOS os ativos da
  // B3: ações, opções, termo, ETFs, FIIs...) — nunca carrega ele inteiro
  // como string de uma vez (`.toString()` + `.split("\n")` trava/estoura
  // memória). Em vez disso, lê direto do Buffer, linha por linha, sem
  // nunca materializar o arquivo inteiro como array de strings.
  const rawBuffer = zip.readFile(txtEntry);
  console.log(`\nTamanho do arquivo descomprimido: ${(rawBuffer.length / 1024 / 1024).toFixed(1)} MB`);

  // Cada linha tem 245 caracteres + quebra de linha. Acha o primeiro \n
  // pra saber se é CRLF (247 bytes) ou só LF (246 bytes) por linha.
  const firstNewline = rawBuffer.indexOf(0x0a); // \n
  const lineLength = firstNewline + 1; // inclui a quebra de linha
  console.log(`Tamanho de cada linha (com quebra): ${lineLength} bytes`);

  function readLine(index) {
    const start = index * lineLength;
    return rawBuffer.toString("latin1", start, start + 245);
  }

  const totalLines = Math.floor(rawBuffer.length / lineLength);
  console.log(`Total de linhas (estimado): ${totalLines.toLocaleString("pt-BR")}`);

  console.log(`\n--- Linha 1 (HEADER, tipo 00) ---`);
  console.log(readLine(0));

  console.log(`\n--- Linha 2 (primeira cotação, tipo 01) ---`);
  const l = readLine(1);
  console.log(l);

  console.log(`\n--- Última linha (TRAILER, tipo 99) ---`);
  console.log(readLine(totalLines - 1));

  // Conta quantas linhas são do "lote padrão" (BDI=02) — o que
  // realmente nos interessa, o resto é opção/termo/outros mercados que
  // vamos descartar na ingestão de verdade.
  let countBdi02 = 0;
  const sampleStep = Math.max(1, Math.floor(totalLines / 200000)); // amostra, não conta tudo
  let sampled = 0;
  for (let i = 1; i < totalLines - 1; i += sampleStep) {
    const bdi = rawBuffer.toString("latin1", i * lineLength + 10, i * lineLength + 12);
    if (bdi === "02") countBdi02++;
    sampled++;
  }
  console.log(`\nAmostra: ${sampled.toLocaleString("pt-BR")} linhas verificadas, ${countBdi02.toLocaleString("pt-BR")} são BDI=02 (lote padrão) — ${((countBdi02 / sampled) * 100).toFixed(1)}%`);

  // Recorte de campos conhecidos da linha 2, pra conferir se as
  // posições batem com o layout oficial da B3:
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

  // Acha uma linha de exemplo de uma ação conhecida (PETR4) pra
  // conferir o recorte numa linha real de ação, não a primeira do
  // arquivo (que pode ser qualquer papel em ordem alfabética).
  console.log(`\n--- Procurando uma linha de PETR4 pra conferir... ---`);
  for (let i = 1; i < totalLines - 1; i++) {
    const codneg = rawBuffer.toString("latin1", i * lineLength + 12, i * lineLength + 24).trim();
    if (codneg === "PETR4") {
      const pl = readLine(i);
      console.log(pl);
      console.log(`DATA: "${pl.slice(2, 10)}" | PREABE: "${pl.slice(56, 69)}" | PREULT: "${pl.slice(108, 121)}" | VOLTOT: "${pl.slice(170, 188)}"`);
      break;
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("PRÓXIMO PASSO: me manda essa saída inteira, vou usar pra");
  console.log("confirmar as posições dos campos e escrever o parser definitivo.");
  console.log("=".repeat(60));
}

main();
