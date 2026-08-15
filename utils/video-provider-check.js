require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const chalk = require('chalk');
const { AIVideoGenerator } = require('./ai-video-generator');
const { CredentialManager } = require('./credential-manager');

// Diagnóstico da geração de cenas por IA. Uma produção com cenas por IA faz uma chamada paga
// por cena, então vale confirmar a chave, o modelo e uma cena antes de rodar a produção toda.

function mask(value) {
  const text = String(value || '');
  if (!text) return null;
  if (text.length <= 8) return '••••';
  return `${text.slice(0, 4)}••••${text.slice(-4)}`;
}

async function runVideoProviderCheck({ live = false, prompt = 'Slow dolly in on a quiet desert at night, stars turning overhead, warm lantern light' } = {}) {
  let credentials = {};
  try {
    const manager = new CredentialManager();
    await manager.loadCredentials();
    credentials = manager.credentials || {};
  } catch (error) {
    console.log(chalk.yellow(`Não foi possível ler config/credentials.json (${error.message}). Seguindo só com as variáveis de ambiente.`));
  }

  const generator = new AIVideoGenerator(credentials);
  const configured = generator.hasAIVideoProvider();
  const imageState = generator.describeImageProvider();

  console.log(chalk.cyan.bold('\n🎬 Diagnóstico das cenas por IA'));
  console.log(chalk.gray('─'.repeat(56)));
  console.log(`REPLICATE_API_KEY     : ${mask(credentials.replicate?.apiKey || process.env.REPLICATE_API_KEY) || chalk.red('ausente')}`);
  console.log(`Modelo de vídeo       : ${generator.replicateVideoModel}`);
  console.log(`Resolução             : ${process.env.REPLICATE_VIDEO_RESOLUTION || '720p'}`);
  console.log(`Imagem inicial (still): ${imageState.configured ? imageState.chain.join(' → ') : chalk.red('nenhum provedor de imagem')}`);
  console.log(`Acervo de reserva     : ${generator.hasStockVideoProvider() ? generator.stockVideoProvider : chalk.yellow('nenhum')}`);

  if (!configured) {
    console.log(chalk.red('\n✗ Cenas por IA indisponíveis: falta REPLICATE_API_KEY.'));
    console.log(chalk.gray('Com a caixa "Gerar cenas com IA" marcada, a produção avisa e usa o acervo.'));
    return { configured: false, live: false, ok: false };
  }

  if (!imageState.configured) {
    console.log(chalk.red('\n✗ O modelo de vídeo parte de uma imagem, e nenhum provedor de imagem está configurado.'));
    return { configured: true, live: false, ok: false };
  }

  console.log(chalk.green('\n✓ Replicate configurado.'));

  if (!live) {
    console.log(chalk.gray('Rode com --live para gerar uma cena de teste (uma chamada paga).'));
    return { configured: true, live: false, ok: true };
  }

  const directory = path.join(__dirname, '..', 'data', 'assets', 'diagnostics');
  const stillPath = path.join(directory, `scene-check-${Date.now()}.png`);
  const clipPath = path.join(directory, `scene-check-${Date.now()}.mp4`);

  try {
    console.log(chalk.cyan('\n1/2 Gerando o primeiro quadro...'));
    await generator.generateImage(prompt, stillPath);
    const stillStats = await fs.stat(stillPath);
    console.log(chalk.green(`    ✓ Quadro por ${generator.lastImageProvider} (${Math.round(stillStats.size / 1024)} KB)`));
  } catch (error) {
    console.log(chalk.red(`    ✗ O quadro inicial falhou: ${error.message}`));
    if (error.providerDetail) console.log(chalk.gray(`      Resposta: ${error.providerDetail}`));
    return { configured: true, live: true, ok: false, stage: 'image', error: error.message };
  }

  try {
    console.log(chalk.cyan('2/2 Animando a cena no Replicate, isso leva alguns minutos...'));
    const clip = await generator.generateSceneVideo(prompt, clipPath, { imagePath: stillPath, durationSeconds: 5 });
    const stats = await fs.stat(clip.path);
    console.log(chalk.green(`    ✓ Cena de ${Math.round(stats.size / 1024)} KB gerada em ${clip.seconds}s por ${clip.provider}`));
    console.log(chalk.gray(`      Arquivo: ${clip.path}`));
    console.log(chalk.green('\n✓ Pronto para marcar "Gerar cenas com IA" numa produção.'));
    return { configured: true, live: true, ok: true, clipPath: clip.path, seconds: clip.seconds };
  } catch (error) {
    console.log(chalk.red(`    ✗ A cena falhou: ${error.message}`));
    console.log(chalk.gray('\nLeitura rápida:'));
    console.log(chalk.gray('  sem créditos     , a conta do Replicate precisa de saldo para modelos de vídeo'));
    console.log(chalk.gray('  sem permissão    , a chave não alcança esse modelo'));
    console.log(chalk.gray('  modelo não achado, confira REPLICATE_VIDEO_MODEL (padrão wan-video/wan-2.7-i2v)'));
    return { configured: true, live: true, ok: false, stage: 'video', error: error.message };
  }
}

module.exports = { runVideoProviderCheck };

if (require.main === module) {
  const live = process.argv.includes('--live');
  runVideoProviderCheck({ live })
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((error) => {
      console.error(chalk.red(`Diagnóstico falhou: ${error.message}`));
      process.exit(1);
    });
}
