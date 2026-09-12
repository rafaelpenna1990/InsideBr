require("dotenv").config();
const { Pool } = require("pg");

// O Postgres do Render exige conexão SSL; localhost não usa.
// Detecta automaticamente pela URL de conexão.
const isLocal =
  (process.env.DATABASE_URL || "").includes("localhost") ||
  (process.env.DATABASE_URL || "").includes("127.0.0.1");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Erro inesperado no pool do Postgres:", err);
});

module.exports = pool;
