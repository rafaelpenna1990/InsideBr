/**
 * Reverte as sobrescritas erradas do cnpjTickerFix.js — a lista de
 * referência (março/2025) estava desatualizada pra empresas que
 * mudaram de ticker desde então (fusões, rebranding). Isso restaura
 * o valor de ANTES pras empresas que já tinham ticker certo.
 *
 * Roda com: npm run revert-ticker-overwrites
 */
require("dotenv").config();
const pool = require("./pool");

// [nome da empresa, ticker CORRETO a restaurar]
const REVERTS = [
  ["BRAVA ENERGIA S.A.", "BRAV3"],
  ["AZZAS 2154 S.A.", "AZZA3"],
  ["MOTIVA INFRAESTRUTURA DE MOBILIDADE S.A.", "MOTV3"],
  ["GRUPO SBF S.A.", "SBFG3"],
  ["ISA ENERGIA BRASIL S.A.", "ISAE4"],
  ["BRASKEM S.A.", "BRKM5"],
  ["TELEFÔNICA BRASIL S.A.", "VIVT3"],
  ["USINAS SID DE MINAS GERAIS S.A.-USIMINAS", "USIM5"],
  ["BANCO DO ESTADO DO RIO GRANDE DO SUL SA", "BRSR6"],
  ["COMPANHIA BRASILEIRA DE DISTRIBUIÇÃO", "PCAR3"],
  ["CIA ENERG CEARA - COELCE", "COCE5"],
  ["COMPANHIA DE GÁS DE SÃO PAULO - COMGÁS", "CGAS5"],
  ["GUARARAPES CONFECÇÕES SA", "GUAR3"],
  ["OI S.A. - EM RECUPERAÇÃO JUDICIAL", "OIBR3"],
  ["RIO PARANAPANEMA ENERGIA S.A.", "GEPA3"],
  ["UNIPAR CARBOCLORO S.A.", "UNIP6"],
  ["BRISANET PARTICIPAÇÕES S.A.", "BRST3"],
];

async function main() {
  console.log(`Revertendo ${REVERTS.length} empresas pro ticker de antes...`);
  for (const [name, ticker] of REVERTS) {
    const result = await pool.query(
      "UPDATE companies SET ticker = $1 WHERE name = $2 RETURNING id",
      [ticker, name]
    );
    console.log(`  ${name} → ${ticker} (${result.rowCount} linha(s) atualizada(s))`);
  }
  console.log("\nRevertido com sucesso.");
  await pool.end();
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
