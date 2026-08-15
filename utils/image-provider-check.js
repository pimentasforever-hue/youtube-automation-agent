require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const chalk = require('chalk');
const { AIVideoGenerator } = require('./ai-video-generator');
const { CredentialManager } = require('./credential-manager');

// Diagnóstico do provedor de imagens: mostra qual provedor foi escolhido, quais credenciais
// existem e, se pedir, faz uma geração real para expor a resposta exata do provedor.
// A miniatura falha em silêncio na produção (cai no fallback), então este é o caminho
// mais curto para descobrir o motivo no servidor onde as chaves estão.

function mask(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

function credentialSnapshot(credentials = {}) {
  return {
    'CLOUDFLARE_ACCOUNT_ID': mask(credentials.cloudflare?.accountId || process.env.CLOUDFLARE_ACCOUNT_ID),
    'R2_ACCOUNT_ID (fallback da conta Cloudflare)': mask(process.env.R2_ACCOUNT_ID),
    'CLOUDFLARE_AI_API_TOKEN': mask(credentials.cloudflare?.apiToken || process.env.CLOUDFLARE_AI_API_TOKEN),
    'OPENAI_API_KEY': mask(credentials.openai?.apiKey || process.env.OPENAI_API_KEY),
    'GEMINI_API_KEY': mask(credentials.gemini?.apiKey || process.env.GEMINI_API_KEY)
  };
}

async function runImageProviderCheck({ live = false, prompt = 'A calm library at sunrise, wide shot' } = {}) {
  let credentials = {};
  try {
    const manager = new CredentialManager();
    await manager.loadCredentials();
    credentials = manager.credentials || {};
  } catch (error) {
    console.log(chalk.yellow(`Não foi possível ler config/credentials.json (${error.message}). Seguindo só com as variáveis de ambiente.`));
  }

  const generator = new AIVideoGenerator(credentials);
  const state = generator.describeImageProvider();

  console.log(chalk.cyan.bold('\n🖼  Diagnóstico do provedor de imagens'));
  console.log(chalk.gray('─'.repeat(56)));
  console.log(`IMAGE_PROVIDER pedido : ${state.requested || chalk.gray('(não definido, escolha automática)')}`);
  console.log(`Provedor em uso       : ${state.provider || chalk.red('nenhum')}`);
  console.log(`Modelo                : ${state.model || chalk.gray('n/d')}`);
  console.log(`Credenciais presentes : cloudflare=${state.available.cloudflare} openai=${state.available.openai} gemini=${state.available.gemini}`);

  console.log(chalk.cyan('\nCredenciais lidas:'));
  for (const [name, value] of Object.entries(credentialSnapshot(credentials))) {
    console.log(`  ${value ? chalk.green('✓') : chalk.yellow('✗')} ${name}: ${value || chalk.gray('ausente')}`);
  }

  if (!state.configured) {
    console.log(chalk.red(`\n✗ Geração de imagens indisponível: ${state.reason}`));
    console.log(chalk.gray('Com o provedor fora do ar a miniatura vira simulação e as cenas falham.'));
    return { ...state, live: false, ok: false };
  }

  console.log(chalk.green(`\n✓ ${state.provider} está configurado.`));

  if (!live) {
    console.log(chalk.gray('Rode com --live para gerar uma imagem de teste e ver a resposta do provedor.'));
    return { ...state, live: false, ok: true };
  }

  const outputPath = path.join(__dirname, '..', 'data', 'assets', `diagnostic_${Date.now()}.png`);
  console.log(chalk.cyan(`\nGerando uma imagem de teste com ${state.provider}...`));

  try {
    const started = Date.now();
    await generator.generateImage(prompt, outputPath);
    const stats = await fs.stat(outputPath);
    console.log(chalk.green(`✓ Imagem gerada em ${Math.round((Date.now() - started) / 1000)}s (${Math.round(stats.size / 1024)} KB): ${outputPath}`));
    return { ...state, live: true, ok: true, outputPath };
  } catch (error) {
    console.log(chalk.red(`✗ O provedor recusou: ${error.message}`));
    if (error.status) console.log(chalk.red(`  HTTP ${error.status}`));
    if (error.providerDetail) console.log(chalk.gray(`  Resposta: ${error.providerDetail}`));
    console.log(chalk.gray('\nLeitura rápida:'));
    console.log(chalk.gray('  401/403 , o token não tem permissão para esse modelo (um token só de R2 não serve para Workers AI)'));
    console.log(chalk.gray('  429     , a cota do provedor acabou; no Workers AI ela volta às 00:00 UTC'));
    console.log(chalk.gray('  404     , o modelo configurado não existe ou a conta não tem acesso a ele'));
    console.log(chalk.gray('  400     , o prompt foi recusado pelo filtro de conteúdo do provedor'));
    return { ...state, live: true, ok: false, error: error.message, status: error.status || null, providerDetail: error.providerDetail || null };
  }
}

module.exports = { runImageProviderCheck, credentialSnapshot };

if (require.main === module) {
  const live = process.argv.includes('--live');
  runImageProviderCheck({ live })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      console.error(chalk.red(`Diagnóstico falhou: ${error.message}`));
      process.exit(1);
    });
}
