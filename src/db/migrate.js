const fs = require("fs");
const path = require("path");
const pool = require("./pool");

async function migrate() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  console.log("Rodando schema.sql...");
  await pool.query(sql);
  console.log("Schema criado/atualizado com sucesso.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Erro ao rodar migração:", err);
  process.exit(1);
});

