const fs = require("fs");
const path = require("path");
const pool = require("./pool");

async function applyFixes() {
  const sqlPath = path.join(__dirname, "manual-ticker-fixes.sql");
  const sql = fs.readFileSync(sqlPath, "utf-8");

  console.log("Aplicando correções manuais de ticker...");
  const result = await pool.query(sql);

  // O último comando do arquivo é o SELECT de conferência
  const lastResult = Array.isArray(result) ? result[result.length - 1] : result;
  if (lastResult && lastResult.rows) {
    console.log("Resultado:", lastResult.rows[0]);
  }

  console.log("Correções aplicadas com sucesso.");
  await pool.end();
}

applyFixes().catch((err) => {
  console.error("Erro ao aplicar correções:", err.message);
  process.exit(1);
});
