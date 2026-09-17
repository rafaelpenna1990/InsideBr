/**
 * Remove o "F" sobrando no final de tickers que vieram do mapeamento
 * automático antigo (resquício que não bate com o código real da B3,
 * por isso não aparecia histórico de preço pra essas empresas).
 *
 * Roda com: npm run fix-trailing-f
 */
require("dotenv").config();
const pool = require("./pool");

async function main() {
  const result = await pool.query(
    `
    UPDATE companies
    SET ticker = LEFT(ticker, LENGTH(ticker) - 1)
    WHERE ticker ~ '^[A-Z]{4}[0-9]{1,2}F$'
    RETURNING name, ticker
    `
  );
  console.log(`Corrigidos ${result.rowCount} tickers:`);
  result.rows.forEach((r) => console.log(`  ${r.name} → ${r.ticker}`));
  await pool.end();
}

main().catch((err) => {
  console.error("Erro:", err.message);
  process.exit(1);
});
