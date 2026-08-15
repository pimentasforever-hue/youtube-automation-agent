require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const chalk = require('chalk');

// Diagnóstico de persistência. Quando o container é recriado, tudo que estiver dentro da
// pasta da aplicação some: banco, tokens do YouTube e histórico de produção. É por isso que
// "o canal caiu" e "os estados de criação sumiram" costumam ser o mesmo problema.

const APP_ROOT = path.join(__dirname, '..');

function isInsideApp(target) {
  const relative = path.relative(APP_ROOT, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function describeFile(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return { exists: true, size: stats.size, modifiedAt: stats.mtime.toISOString() };
  } catch (error) {
    return { exists: false };
  }
}

async function countSQLiteRows(dbPath) {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  const count = (table) => new Promise((resolve) => {
    db.get(`SELECT COUNT(*) AS total FROM ${table}`, (error, row) => resolve(error ? null : Number(row?.total ?? 0)));
  });
  try {
    return {
      productions: await count('productions'),
      production_jobs: await count('production_jobs'),
      scripts: await count('scripts')
    };
  } finally {
    await new Promise((resolve) => db.close(() => resolve()));
  }
}

async function countPostgresRows(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString });
  try {
    const result = {};
    for (const table of ['productions', 'production_jobs', 'scripts']) {
      try {
        const rows = await pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
        result[table] = Number(rows.rows[0].total);
      } catch (error) {
        result[table] = null;
      }
    }
    return result;
  } finally {
    await pool.end();
  }
}

async function runStateCheck() {
  const warnings = [];
  console.log(chalk.cyan.bold('\n💾 Diagnóstico de persistência'));
  console.log(chalk.gray('─'.repeat(56)));

  // Banco
  const databaseUrl = process.env.DATABASE_URL;
  const sqlitePath = path.join(APP_ROOT, 'data', 'youtube_automation.db');
  let rows = null;

  if (databaseUrl) {
    const host = databaseUrl.replace(/\/\/[^@]*@/, '//***@');
    console.log(`Banco                 : PostgreSQL gerenciado`);
    console.log(`  DATABASE_URL        : ${host.slice(0, 60)}${host.length > 60 ? '…' : ''}`);
    try {
      rows = await countPostgresRows(databaseUrl);
    } catch (error) {
      console.log(chalk.red(`  ✗ Não foi possível consultar o Postgres: ${error.message}`));
      warnings.push('O banco configurado não respondeu.');
    }
  } else {
    const file = await describeFile(sqlitePath);
    console.log(`Banco                 : SQLite em arquivo`);
    console.log(`  Caminho             : ${sqlitePath}`);
    console.log(`  Arquivo             : ${file.exists ? `${Math.round(file.size / 1024)} KB, alterado em ${file.modifiedAt}` : chalk.red('não existe')}`);
    if (isInsideApp(sqlitePath)) {
      warnings.push('O banco está dentro da pasta da aplicação: um novo deploy apaga todo o histórico de produções. Configure DATABASE_URL ou monte um volume.');
    }
    if (file.exists) {
      try {
        rows = await countSQLiteRows(sqlitePath);
      } catch (error) {
        console.log(chalk.yellow(`  Não foi possível ler o arquivo: ${error.message}`));
      }
    }
  }

  if (rows) {
    console.log(`  Produções           : ${rows.productions ?? 'tabela ausente'}`);
    console.log(`  Estados de produção : ${rows.production_jobs ?? 'tabela ausente'}`);
    console.log(`  Roteiros            : ${rows.scripts ?? 'tabela ausente'}`);
    if (rows.production_jobs === 0) {
      warnings.push('Não há nenhum estado de produção gravado: o painel não tem o que mostrar até a próxima produção.');
    }
  }

  // Tokens do YouTube
  const tokensPath = process.env.DATA_DIR
    ? path.join(process.env.DATA_DIR, 'youtube-tokens.json')
    : path.join(APP_ROOT, 'config', 'tokens.json');
  const tokensFile = await describeFile(tokensPath);

  console.log(`\nTokens do YouTube     : ${tokensFile.exists ? chalk.green('presentes') : chalk.red('ausentes')}`);
  console.log(`  DATA_DIR            : ${process.env.DATA_DIR || chalk.yellow('não definido')}`);
  console.log(`  Caminho             : ${tokensPath}`);
  if (tokensFile.exists) {
    console.log(`  Arquivo             : ${tokensFile.size} bytes, alterado em ${tokensFile.modifiedAt}`);
    try {
      const tokens = JSON.parse(await fs.readFile(tokensPath, 'utf8'));
      const youtube = tokens.youtube || tokens;
      console.log(`  refresh_token       : ${youtube?.refresh_token ? chalk.green('presente') : chalk.red('ausente')}`);
      if (youtube?.expiry_date) {
        const expired = Number(youtube.expiry_date) < Date.now();
        console.log(`  access_token        : ${expired ? chalk.yellow('expirado, será renovado pelo refresh_token') : chalk.green('válido')}`);
      }
      if (!youtube?.refresh_token) {
        warnings.push('Sem refresh_token não há como renovar o acesso: reconecte a conta em /auth/google.');
      }
    } catch (error) {
      warnings.push(`O arquivo de tokens existe mas não pôde ser lido: ${error.message}`);
    }
  } else {
    warnings.push('O canal aparece desconectado porque não há tokens salvos. Reconecte em /auth/google.');
  }

  if (isInsideApp(tokensPath)) {
    warnings.push('Os tokens estão dentro da pasta da aplicação: o próximo deploy desconecta o canal de novo. Defina DATA_DIR apontando para um volume persistente.');
  }

  // Credenciais
  const credentialsFile = await describeFile(path.join(APP_ROOT, 'config', 'credentials.json'));
  console.log(`\nconfig/credentials.json: ${credentialsFile.exists ? chalk.green('presente') : chalk.yellow('ausente, usando só variáveis de ambiente')}`);

  if (warnings.length) {
    console.log(chalk.yellow('\nAtenção:'));
    for (const warning of warnings) console.log(chalk.yellow(`  • ${warning}`));
  } else {
    console.log(chalk.green('\n✓ Banco e tokens estão em locais que sobrevivem a um novo deploy.'));
  }

  return { warnings, rows, tokens: tokensFile.exists, database: databaseUrl ? 'postgres' : 'sqlite' };
}

module.exports = { runStateCheck, isInsideApp };

if (require.main === module) {
  runStateCheck()
    .then((result) => process.exit(result.warnings.length ? 1 : 0))
    .catch((error) => {
      console.error(chalk.red(`Diagnóstico falhou: ${error.message}`));
      process.exit(1);
    });
}
