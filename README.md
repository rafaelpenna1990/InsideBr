InsideBR — Backend
Agregador de negociações de insiders declaradas à CVM (dado público, Portal Dados Abertos CVM).
Passo a passo — primeira execução
1. Instalar dependências
```bash
cd insideBr-backend
npm install
```
2. Configurar o banco de dados
Você tem duas opções:
Opção A — Postgres local (mais rápido pra testar)
Instale o Postgres: https://www.postgresql.org/download/
Crie um banco:
```bash
  createdb insidebr
  ```
Opção B — Postgres no Render (direto pra produção, já que você já usa Render)
No painel do Render, crie um "PostgreSQL" novo
Copie a "Internal Connection String" ou "External Connection String"
3. Configurar variáveis de ambiente
```bash
cp .env.example .env
```
Abra o `.env` e cole sua `DATABASE_URL` real (local ou do Render).
4. Criar as tabelas no banco
```bash
npm run migrate
```
Isso roda o `schema.sql` e cria todas as tabelas (companies, insiders, transactions, users, alert_rules).
5. ⭐ Rodar a inspeção do CSV da CVM (passo mais importante agora)
```bash
npm run inspect-cvm
```
Esse script baixa o arquivo real de `dados.cvm.gov.br`, extrai o CSV e imprime:
Os nomes exatos das colunas
As 3 primeiras linhas de exemplo
Por que esse passo existe: eu não tenho acesso à internet livre no meu ambiente aqui do chat pra baixar o arquivo da CVM e conferir a estrutura real do CSV antes de escrever o parser definitivo. Então, em vez de arriscar nomes de coluna errados, esse script deixa você rodar a inspeção na sua máquina e me mandar o resultado.
Depois de rodar: copie a lista de colunas que apareceu no terminal e me envie aqui no chat. Com isso eu escrevo o `fetchVlmo.js` de verdade — o script que vai popular o banco de dados de fato, mapeando cada coluna da CVM pro campo certo da tabela `transactions`.
6. Rodar o servidor
```bash
npm start
```
Acesse `http://localhost:3000` — deve responder `{"status":"InsideBR API rodando"}`.
Teste a conexão com banco: `http://localhost:3000/api/health/db`
---
Estrutura do projeto
```
insideBr-backend/
├── src/
│   ├── server.js              # servidor Express
│   ├── db/
│   │   ├── pool.js            # conexão com Postgres
│   │   ├── schema.sql         # definição das tabelas
│   │   └── migrate.js         # roda o schema.sql
│   └── ingest/
│       ├── inspectVlmo.js     # PASSO 1: inspeciona a estrutura do CSV
│       └── fetchVlmo.js       # (a criar) parser definitivo
├── .env.example
└── package.json
```
O que vem depois
Rodar `npm run inspect-cvm` e me mandar as colunas
Eu escrevo o `fetchVlmo.js` completo (parser + inserção no banco)
Testamos populando o banco com dados reais
Conectamos o app Expo (InsideBR) nesses endpoints reais em vez do mock
