const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');
const { CredentialManager } = require('./utils/credential-manager');
const chalk = require('chalk');
const path = require('path');
const crypto = require('crypto');

class SystemTest {
  constructor() {
    this.logger = new Logger('SystemTest');
    this.testResults = {};
  }

  async runAllTests() {
    console.log(chalk.cyan.bold('\n🧪 YouTube Automation Agent - System Test'));
    console.log(chalk.gray('═'.repeat(60)));
    
    const tests = [
      { name: 'Database Connection', test: () => this.testDatabase() },
      { name: 'Production Persistence', test: () => this.testProductionPersistence() },
      { name: 'Automation Events Table', test: () => this.testAutomationEventsTable() },
      { name: 'Production Observability', test: () => this.testProductionObservability() },
      { name: 'Validated Completion Guard', test: () => this.testValidatedCompletionGuard() },
      { name: 'API Validation and Security', test: () => this.testAPIValidationAndSecurity() },
      { name: 'Publishing Safety', test: () => this.testPublishingSafety() },
      { name: 'Multi-Provider Credential Validation', test: () => this.testCredentialValidation() },
      { name: 'Placeholder Scheduling Guard', test: () => this.testPlaceholderSchedulingGuard() },
      { name: 'FFmpeg Resolution', test: () => this.testFFmpegResolution() },
      { name: 'Gemini Media Provider Selection', test: () => this.testGeminiMediaProvider() },
      { name: 'Cloudflare Image Provider', test: () => this.testCloudflareImageProvider() },
      { name: 'Cinematic Hybrid Renderer', test: () => this.testHybridRenderer() },
      { name: 'Storyboard Director Agent', test: () => this.testStoryboardDirector() },
      { name: 'Thumbnail Upload Content Type', test: () => this.testThumbnailUploadContentType() },
      { name: 'Image Provider Diagnostics', test: () => this.testImageProviderDiagnostics() },
      { name: 'Dashboard Responsive Rules', test: () => this.testDashboardResponsiveRules() },
      { name: 'Evergreen Template Topics', test: () => this.testEvergreenTopics() },
      { name: 'Walkthrough Module', test: () => this.testWalkthroughModule() },
      { name: 'Logger System', test: () => this.testLogger() },
      { name: 'Directory Structure', test: () => this.testDirectories() },
      { name: 'Agent Loading', test: () => this.testAgentLoading() },
      { name: 'Configuration Files', test: () => this.testConfiguration() }
    ];

    let passed = 0;
    let failed = 0;

    for (const { name, test } of tests) {
      try {
        console.log(chalk.cyan(`\n🔍 Testing ${name}...`));
        await test();
        console.log(chalk.green(`✅ ${name} - PASSED`));
        this.testResults[name] = { status: 'PASSED' };
        passed++;
      } catch (error) {
        console.log(chalk.red(`❌ ${name} - FAILED`));
        console.log(chalk.red(`   Error: ${error.message}`));
        this.testResults[name] = { status: 'FAILED', error: error.message };
        failed++;
      }
    }

    // Display summary
    console.log(chalk.gray('\n' + '═'.repeat(60)));
    console.log(chalk.cyan.bold('📊 Test Summary:'));
    console.log(chalk.green(`✅ Passed: ${passed}`));
    console.log(chalk.red(`❌ Failed: ${failed}`));
    console.log(chalk.cyan(`📝 Total: ${passed + failed}`));

    if (failed === 0) {
      console.log(chalk.green.bold('\n🎉 All tests passed! System is ready to run.'));
      console.log(chalk.cyan('Run: npm start'));
    } else {
      console.log(chalk.yellow.bold('\n⚠️  Some tests failed. Please check the errors above.'));
      console.log(chalk.cyan('Run: npm run setup (to reconfigure)'));
    }

    return failed === 0;
  }

  async testDatabase() {
    const db = new Database();
    await db.initialize();
    
    // Test basic operations
    const stats = await db.getStats();
    if (!stats) throw new Error('Failed to get database stats');
    
    // Test settings
    await db.setSetting('test_key', 'test_value', 'Test setting');
    const value = await db.getSetting('test_key');
    if (value !== 'test_value') throw new Error('Settings read/write failed');
    
    await db.close();
    this.logger.info('Database test completed successfully');
  }

  async testProductionPersistence() {
    const db = new Database();
    await db.initialize();

    const production = {
      id: `prod_test_${Date.now()}`,
      status: 'processing',
      assets: { finalVideo: { path: 'placeholder.mp4' } },
      timeline: { created: new Date().toISOString() },
      scheduledPublishTime: new Date().toISOString(),
      priority: 25,
      estimatedDuration: '1:00'
    };

    const firstId = await db.saveProductionData(production);
    if (firstId !== production.id) {
      throw new Error('saveProductionData did not return the production id');
    }

    const secondId = await db.saveProductionData({
      ...production,
      status: 'ready',
      priority: 90
    });
    if (secondId !== production.id) {
      throw new Error('saveProductionData upsert did not return the production id');
    }

    const saved = await db.getRow('SELECT status, priority FROM productions WHERE id = ?', [production.id]);
    if (!saved || saved.status !== 'ready' || saved.priority !== 90) {
      throw new Error('saveProductionData did not upsert the existing production row');
    }

    const library = await db.getContentLibrary();
    const libraryItem = library.find(item => item.id === production.id);
    if (!libraryItem || libraryItem.status !== 'ready' || libraryItem.title !== 'Conteúdo sem título') {
      throw new Error('getContentLibrary did not return the saved production');
    }

    await db.executeQuery('DELETE FROM productions WHERE id = ?', [production.id]);
    await db.close();
    this.logger.info('Production persistence test completed successfully');
  }

  async testAutomationEventsTable() {
    const db = new Database();
    await db.initialize();

    await db.executeQuery(
      'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
      ['test_event', 'success', JSON.stringify({ ok: true })]
    );

    const row = await db.getRow(
      'SELECT event_type, status, data FROM automation_events WHERE event_type = ? ORDER BY created_at DESC',
      ['test_event']
    );

    if (!row || row.status !== 'success') {
      throw new Error('automation_events row was not persisted');
    }

    await db.executeQuery('DELETE FROM automation_events WHERE event_type = ?', ['test_event']);
    await db.close();
    this.logger.info('Automation events table test completed successfully');
  }

  async testProductionObservability() {
    const db = new Database();
    await db.initialize();
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const jobId = `job_observability_${suffix}`;
    const contentId = `prod_${jobId}`;
    await db.createQueuedProduction({ id: contentId, title: 'Teste de acompanhamento', topic: 'Teste', script: 'Roteiro de teste', options: { targetMinutes: 2, sceneCount: 3 } });
    await db.saveProductionJob({ id: jobId, stage: 'processing', progress: 5, message: 'Worker iniciou', result: { contentId, worker: { status: 'active', heartbeatAt: new Date().toISOString() } }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await db.recordProductionEvent({ jobId, contentId, level: 'info', stage: 'processing', progress: 5, message: 'Worker iniciou' });
    const olderJobId = `${jobId}_old`;
    await db.recordProductionEvent({ jobId: olderJobId, contentId, level: 'error', stage: 'failed', progress: 100, message: 'Erro antigo' });
    const events = await db.getProductionEvents({ jobId, contentId });
    const library = await db.getContentLibrary();
    if (events.length !== 1 || events[0].message !== 'Worker iniciou') throw new Error('Production event was not persisted');
    if (!library.some((item) => item.id === contentId && item.status === 'queued' && item.title === 'Teste de acompanhamento')) throw new Error('Queued production was not visible in the content library');
    await db.executeQuery('DELETE FROM production_job_events WHERE job_id = ?', [jobId]);
    await db.executeQuery('DELETE FROM production_job_events WHERE job_id = ?', [olderJobId]);
    await db.executeQuery('DELETE FROM production_jobs WHERE id = ?', [jobId]);
    await db.executeQuery('DELETE FROM productions WHERE id = ?', [contentId]);
    await db.close();
    this.logger.info('Production observability test completed successfully');
  }

  async testValidatedCompletionGuard() {
    const { ProductionQueue } = require('./utils/production-queue');
    const previousRedis = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      let resolveFinal;
      const final = new Promise((resolve) => { resolveFinal = resolve; });
      const queue = new ProductionQueue({
        processJob: async () => ({ status: 'ready', storageKey: null, videoUrl: null }),
        onProgress: (_id, stage, _progress, message) => { if (stage === 'failed') resolveFinal(message); },
        logger: this.logger
      });
      await queue.add('job_invalid_completion', { productionId: 'prod_invalid_completion' });
      const message = await Promise.race([final, new Promise((_, reject) => setTimeout(() => reject(new Error('Completion guard did not finish')), 2000))]);
      if (!/MP4 validado/i.test(message)) throw new Error('Production without an R2 video was not rejected');
    } finally {
      if (previousRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedis;
    }
    this.logger.info('Validated completion guard test completed successfully');
  }

  async testAPIValidationAndSecurity() {
    const { YouTubeAutomationAgent } = require('./index');
    const agent = new YouTubeAutomationAgent();

    if (typeof agent.validateGenerateRequestBody !== 'function') {
      throw new Error('validateGenerateRequestBody is not implemented');
    }
    if (typeof agent.requireAPIKey !== 'function') {
      throw new Error('requireAPIKey is not implemented');
    }
    if (typeof agent.requireAuth !== 'function' || typeof agent.verifyPassword !== 'function') {
      throw new Error('Username and password authentication is not implemented');
    }

    const valid = agent.validateGenerateRequestBody({
      topic: 'Node automation',
      style: 'tutorial'
    });
    if (!valid.valid || valid.value.topic !== 'Node automation') {
      throw new Error('Valid generate request was rejected');
    }

    const invalidTopic = agent.validateGenerateRequestBody({ topic: 123 });
    if (invalidTopic.valid || invalidTopic.status !== 400) {
      throw new Error('Non-string topic was not rejected');
    }

    // The dashboard's "Generate Content Now" button sends an explicit null topic
    // to mean "pick a trending topic for me". null must be accepted, not rejected.
    const dashboardPayload = agent.validateGenerateRequestBody({ topic: null, style: 'story' });
    if (!dashboardPayload.valid) {
      throw new Error(`Dashboard generate payload was rejected: ${dashboardPayload.error}`);
    }
    if (dashboardPayload.value.topic !== null || dashboardPayload.value.style !== 'story') {
      throw new Error('Null topic was not normalised to an auto-selected topic');
    }

    const nullStyle = agent.validateGenerateRequestBody({ topic: 'Node automation', style: null });
    if (!nullStyle.valid || nullStyle.value.style !== null) {
      throw new Error('Null style was not accepted as "no style preference"');
    }

    const nullLength = agent.validateGenerateRequestBody({ topic: null, style: null, length: null });
    if (!nullLength.valid || nullLength.value.length !== 'medium') {
      throw new Error('Null length did not fall back to the default length');
    }

    const blankTopic = agent.validateGenerateRequestBody({ topic: '   ' });
    if (!blankTopic.valid || blankTopic.value.topic !== null) {
      throw new Error('Whitespace-only topic was not normalised to null');
    }

    const invalidStyle = agent.validateGenerateRequestBody({ style: 'x'.repeat(51) });
    if (invalidStyle.valid || invalidStyle.status !== 400) {
      throw new Error('Overlong style was not rejected');
    }

    const longVideo = agent.validateGenerateRequestBody({ targetMinutes: 90, sceneCount: 180 });
    if (!longVideo.valid) throw new Error(`90 minute production was rejected: ${longVideo.error}`);
    if (agent.validateGenerateRequestBody({ targetMinutes: 91, sceneCount: 180 }).valid) throw new Error('Duration above 90 minutes was accepted');
    if (agent.validateGenerateRequestBody({ targetMinutes: 90, sceneCount: 181 }).valid) throw new Error('Scene count above 180 was accepted');

    const previousKey = process.env.API_KEY;
    process.env.API_KEY = 'test-secret';
    const middleware = agent.requireAPIKey();

    let rejectedNextCalled = false;
    const rejectedResponse = this.createMockResponse();
    middleware({ get: () => 'wrong-secret' }, rejectedResponse, () => {
      rejectedNextCalled = true;
    });

    if (rejectedNextCalled || rejectedResponse.statusCode !== 401) {
      throw new Error('Invalid API key was not rejected');
    }

    let acceptedNextCalled = false;
    const acceptedResponse = this.createMockResponse();
    middleware({ get: () => 'test-secret' }, acceptedResponse, () => {
      acceptedNextCalled = true;
    });

    if (!acceptedNextCalled || acceptedResponse.statusCode) {
      throw new Error('Valid API key was not accepted');
    }

    if (previousKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = previousKey;
    }

    const previousSessionSecret = process.env.SESSION_SECRET;
    const previousPasswordHash = process.env.AUTH_PASSWORD_HASH;
    process.env.SESSION_SECRET = 'test-session-secret-with-sufficient-entropy';
    const salt = 'test-salt-for-password-auth';
    const password = 'test-password';
    process.env.AUTH_PASSWORD_HASH = `${salt}:${crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex')}`;

    if (!agent.verifyPassword(password) || agent.verifyPassword('wrong-password')) {
      throw new Error('Password verification did not behave as expected');
    }

    const session = agent.verifySessionToken(agent.createSessionToken('test-user'));
    if (!session || session.username !== 'test-user') {
      throw new Error('Signed login session could not be verified');
    }

    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
    if (previousPasswordHash === undefined) delete process.env.AUTH_PASSWORD_HASH;
    else process.env.AUTH_PASSWORD_HASH = previousPasswordHash;

    this.logger.info('API validation and security test completed successfully');
  }

  createMockResponse() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
  }

  async testPublishingSafety() {
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const agent = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {}
    }, {});

    agent.publishQueue = [
      { productionId: 'prod-a', title: 'A', status: 'scheduled', metadata: {} },
      { productionId: 'prod-b', title: 'B', status: 'scheduled', metadata: {} }
    ];
    agent.uploadToYouTube = async () => ({ id: 'youtube-1' });

    await agent.publishContent('prod-a');

    if (agent.publishQueue.length !== 1 || agent.publishQueue[0].productionId !== 'prod-b') {
      throw new Error('publishContent removed the wrong publish queue entries');
    }

    let missingFileRejected = false;
    try {
      await agent.getVideoStream(path.join(__dirname, 'data', 'missing-placeholder.mp4'));
    } catch (error) {
      missingFileRejected = /video file not found/.test(error.message);
    }

    if (!missingFileRejected) {
      throw new Error('getVideoStream did not reject a missing video file');
    }

    this.logger.info('Publishing safety test completed successfully');
  }

  async testCredentialValidation() {
    const { PROVIDERS } = require('./utils/ai-text-service');
    const manager = new CredentialManager();

    // Isolate the test from any API keys set in the environment
    const envKeys = [...Object.values(PROVIDERS).map(p => p.envKey), 'GEMINI_API_KEY'];
    const savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      process.env.YOUTUBE_CLIENT_ID = 'client-id';
      process.env.YOUTUBE_CLIENT_SECRET = 'client-secret';
      process.env.YOUTUBE_TOKENS_JSON = JSON.stringify({ refresh_token: 'refresh-token' });
      await manager.loadCredentials();
      await manager.loadTokens();
      if (!manager.credentials.youtube || manager.tokens.youtube.refresh_token !== 'refresh-token') {
        throw new Error('Environment-based YouTube credentials were not loaded');
      }

      manager.credentials = { youtube: { client_id: 'x' }, gemini: { apiKey: 'gm-test' } };
      if (manager.getMissingCredentials().length !== 0) {
        throw new Error('Gemini-only configuration was incorrectly reported as missing credentials');
      }

      manager.credentials = { youtube: { client_id: 'x' }, aiProvider: { provider: 'openrouter', apiKey: 'sk-or-test' } };
      if (manager.getMissingCredentials().length !== 0) {
        throw new Error('OpenRouter configuration was incorrectly reported as missing credentials');
      }

      manager.credentials = { youtube: { client_id: 'x' } };
      const missingProvider = manager.getMissingCredentials();
      if (missingProvider.length !== 1 || !/AI provider/.test(missingProvider[0])) {
        throw new Error('Missing AI provider was not detected');
      }

      manager.credentials = { openai: { apiKey: 'sk-test' } };
      const missingYouTube = manager.getMissingCredentials();
      if (missingYouTube.length !== 1 || missingYouTube[0] !== 'youtube') {
        throw new Error('Missing YouTube credentials were not detected');
      }
    } finally {
      delete process.env.YOUTUBE_CLIENT_ID;
      delete process.env.YOUTUBE_CLIENT_SECRET;
      delete process.env.YOUTUBE_TOKENS_JSON;
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }

    this.logger.info('Credential validation test completed successfully');
  }

  async testPlaceholderSchedulingGuard() {
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const agent = new PublishingSchedulingAgent({
      saveScheduleEntry: async () => {}
    }, {});

    const simulated = await agent.scheduleContent({
      id: 'prod-simulated',
      script: { title: 'Simulated' },
      assets: { finalVideo: { path: 'video.mp4.assembly.json', simulated: true } }
    });
    if (simulated !== null) {
      throw new Error('Simulated production was scheduled for publishing');
    }

    const missingVideo = await agent.scheduleContent({
      id: 'prod-missing',
      script: { title: 'Missing' },
      assets: {}
    });
    if (missingVideo !== null) {
      throw new Error('Production without a final video was scheduled for publishing');
    }

    const real = await agent.scheduleContent({
      id: 'prod-real',
      script: { title: 'Real' },
      priority: 50,
      scheduledPublishTime: new Date().toISOString(),
      assets: { finalVideo: { path: 'video.mp4' }, thumbnail: {}, captions: {} },
      seo: {}
    });
    if (!real || agent.publishQueue.length !== 1) {
      throw new Error('Real production was not scheduled for publishing');
    }

    this.logger.info('Placeholder scheduling guard test completed successfully');
  }

  async testFFmpegResolution() {
    const { getFFmpegPath, checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');

    const ffmpegPath = getFFmpegPath();
    if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) {
      throw new Error('getFFmpegPath did not return a usable path');
    }

    const available = await checkFFmpeg();
    if (typeof available !== 'boolean') {
      throw new Error('checkFFmpeg did not return a boolean');
    }

    if (!/FFmpeg/i.test(ffmpegInstallHint())) {
      throw new Error('ffmpegInstallHint did not return install guidance');
    }

    this.logger.info(`FFmpeg resolution test completed (binary: ${ffmpegPath}, available: ${available})`);
  }

  async testGeminiMediaProvider() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');

    const envKeys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'REPLICATE_API_KEY', 'ELEVENLABS_API_KEY'];
    const savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const geminiOnly = new AIVideoGenerator({ gemini: { apiKey: 'test-key' } });
      if (!geminiOnly.gemini) {
        throw new Error('Gemini media service was not initialized from gemini credentials');
      }
      if (geminiOnly.openai) {
        throw new Error('OpenAI client initialized without a key');
      }

      const none = new AIVideoGenerator({});
      if (none.gemini || none.openai) {
        throw new Error('Media services initialized without any credentials');
      }
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }

    this.logger.info('Gemini media provider selection test completed successfully');
  }

  async testCloudflareImageProvider() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const { R2Storage } = require('./utils/r2-storage');
    const fs = require('fs').promises;
    const os = require('os');
    const axios = require('axios');
    const sharp = require('sharp');
    const envKeys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_API_TOKEN', 'IMAGE_PROVIDER', 'R2_ACCOUNT_ID'];
    const savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      process.env.IMAGE_PROVIDER = 'cloudflare';
      const generator = new AIVideoGenerator({
        cloudflare: { accountId: 'account-test', apiToken: 'token-test' },
        gemini: { apiKey: 'gemini-test' }
      });

      if (!generator.cloudflareAI || generator.imageProvider !== 'cloudflare') {
        throw new Error('Cloudflare was not selected as the image provider');
      }
      if (!generator.hasConfiguredImageProvider()) {
        throw new Error('Cloudflare image provider was not recognized as configured');
      }

      const quotaError = generator.formatCloudflareImageError({ response: { status: 429 } });
      if (!/cota gratuita diária/i.test(quotaError) || quotaError.includes('{"error"')) {
        throw new Error('Cloudflare quota error was not simplified');
      }

      const authError = generator.formatCloudflareImageError({ response: { status: 403 } });
      if (!/permissão/i.test(authError)) {
        throw new Error('Cloudflare permission error was not simplified');
      }

      const generatedPaths = [];
      generator.generateImage = async (_prompt, imagePath) => {
        await fs.mkdir(path.dirname(imagePath), { recursive: true });
        await fs.writeFile(imagePath, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
        generatedPaths.push(imagePath);
        return imagePath;
      };
      const thumbnail = await generator.generateThumbnail({ title: 'Teste de miniatura' });
      if (thumbnail.simulated || generatedPaths.length !== 1) {
        throw new Error('Cloudflare thumbnail generation fell back to a simulated file');
      }

      const invalidImagePath = path.join(os.tmpdir(), `invalid-thumbnail-${Date.now()}.png`);
      await fs.writeFile(invalidImagePath, JSON.stringify({ message: 'not an image' }));
      const storage = new R2Storage();
      let invalidImageRejected = false;
      try {
        await storage.validateUploadFile(invalidImagePath, 'image/png');
      } catch (error) {
        invalidImageRejected = /PNG válida/i.test(error.message);
      } finally {
        await fs.unlink(invalidImagePath).catch(() => {});
        await Promise.all(generatedPaths.map(file => fs.unlink(file).catch(() => {})));
      }
      if (!invalidImageRejected) {
        throw new Error('R2 accepted JSON disguised as a PNG image');
      }

      const convertedImagePath = path.join(os.tmpdir(), `cloudflare-thumbnail-${Date.now()}.png`);
      const originalAxiosPost = axios.post;
      try {
        const jpeg = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#285078' } }).jpeg().toBuffer();
        axios.post = async () => ({ data: { result: { image: jpeg.toString('base64') } } });
        await generator.generateCloudflareImage('Miniatura bíblica', convertedImagePath);
        const convertedHeader = (await fs.readFile(convertedImagePath)).subarray(0, 8);
        if (!convertedHeader.equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
          throw new Error('Cloudflare JPEG response was not converted to a real PNG');
        }
      } finally {
        axios.post = originalAxiosPost;
        await fs.unlink(convertedImagePath).catch(() => {});
      }
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }

    this.logger.info('Cloudflare image provider test completed successfully');
  }

  async testHybridRenderer() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const { checkFFmpeg, runFFmpeg, probeMediaDuration } = require('./utils/ffmpeg');
    const fs = require('fs').promises;
    const os = require('os');

    if (!(await checkFFmpeg())) {
      this.logger.warn('FFmpeg unavailable , skipping cinematic renderer test');
      return;
    }

    const sharp = require('sharp');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-hybrid-'));

    try {
      const generator = new AIVideoGenerator({});
      const stillPath = path.join(dir, 'fallback.png');
      const clipPath = path.join(dir, 'clip.mp4');
      const audioPath = path.join(dir, 'narration.m4a');
      await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 35, g: 80, b: 145 } } }).png().toFile(stillPath);
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=0x754020:s=640x360:r=30:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipPath]);
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'aac', audioPath]);

      const query = generator.normalizeStockQuery('A Bíblia e a oração no deserto, cena cinematográfica');
      if (!query.includes('biblical') || !query.includes('prayer') || !query.includes('desert')) {
        throw new Error(`Stock query was not normalized for the provider: ${query}`);
      }

      const videoPath = path.join(dir, 'visual.mp4');
      const finalPath = path.join(dir, 'final.mp4');
      await generator.renderMediaTimeline([clipPath, stillPath], 4, videoPath, path.join(dir, 'timeline'));
      await generator.addAudioToVideo(videoPath, audioPath, finalPath, 4);
      const finalStats = await fs.stat(finalPath);
      if (!finalStats.size) {
        throw new Error('Cinematic hybrid renderer did not produce a video');
      }
      const duration = await probeMediaDuration(finalPath);
      if (Math.abs(duration - 4) > 0.5) {
        throw new Error(`Final duration should follow narration. Received ${duration} seconds.`);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    this.logger.info('Cinematic hybrid renderer test completed successfully');
  }

  async testStoryboardDirector() {
    const { StoryboardDirectorAgent, buildStoryboardPrompts } = require('./agents/storyboard-director-agent');

    const db = new Database();
    await db.initialize();

    const agent = new StoryboardDirectorAgent(db, {});
    // Force the offline template path so the test never depends on an AI provider.
    agent.aiTextService = { isAvailable: () => false, providerName: 'none' };
    await agent.initialize();

    const script = {
      title: 'How Solar Batteries Work',
      duration: '4:00',
      tone: 'informative',
      pacing: 'medium',
      keywords: ['solar', 'battery', 'storage'],
      hook: { text: 'Your roof makes power at noon and your house needs it at night.' },
      introduction: { greeting: 'Here is the part nobody explains.', topicIntro: 'Storage is the missing link.' },
      mainContent: {
        sections: [
          { title: 'Charging the cells', content: ['Panels push direct current into the pack.'], duration: 60 },
          { title: 'Discharging at night', content: ['The inverter turns stored charge back into household power.'], duration: 60 }
        ]
      },
      conclusion: { summary: 'Storage decides how much of your own power you actually use.' },
      callToAction: { subscribe: 'Subscribe for more energy breakdowns.' },
      metadata: { strategy: { topic: 'solar batteries', contentType: 'Explainer' } }
    };

    const storyboard = await agent.generateStoryboard(script, { sceneCount: 12 });

    if (!storyboard.id) {
      throw new Error('Storyboard was not persisted , no id assigned');
    }
    if (storyboard.scenes.length < 4) {
      throw new Error(`Expected at least 4 scenes from the script beats, got ${storyboard.scenes.length}`);
    }
    if (storyboard.shots.length < storyboard.scenes.length) {
      throw new Error('Every scene must contribute at least one shot');
    }
    if (storyboard.metadata.generationSource !== 'template') {
      throw new Error('Storyboard should fall back to the template path with no AI provider');
    }

    const opening = storyboard.shots[0];
    if (opening.shotSize !== 'extreme wide shot') {
      throw new Error(`The opening shot must establish the space, got "${opening.shotSize}"`);
    }

    for (const shot of storyboard.shots) {
      if (!Number.isInteger(shot.camIdx)) {
        throw new Error(`Shot ${shot.idx} has no camera assigned`);
      }
      if (!shot.imagePrompt || !shot.videoPrompt) {
        throw new Error(`Shot ${shot.idx} is missing render prompts`);
      }
      if (!shot.firstFrame || !shot.lastFrame || !shot.motion) {
        throw new Error(`Shot ${shot.idx} is missing the first frame / last frame / motion decomposition`);
      }
      if (shot.durationSeconds < 3 || shot.durationSeconds > 15) {
        throw new Error(`Shot ${shot.idx} runs ${shot.durationSeconds}s, outside the 3-15s window`);
      }
      if (!['small', 'medium', 'large'].includes(shot.variationType)) {
        throw new Error(`Shot ${shot.idx} has an invalid variation type: ${shot.variationType}`);
      }
    }

    // A camera that performs a significant move cannot be reused afterwards.
    for (const camera of storyboard.cameras) {
      const movements = camera.activeShotIdxs.map(idx => storyboard.shots[idx].movement);
      const retiringMove = movements.slice(0, -1).find(movement => ['slow dolly in', 'slow dolly out', 'tracking shot', 'crane up', 'drone fly-over'].includes(movement));
      if (retiringMove) {
        throw new Error(`Camera ${camera.idx} was reused after a "${retiringMove}" move`);
      }
    }

    if (!storyboard.continuity || !Array.isArray(storyboard.continuity.warnings)) {
      throw new Error('Storyboard is missing its continuity report');
    }
    if (storyboard.cameras.length >= storyboard.shots.length) {
      throw new Error('No camera was reused , the board invents a new setup for every shot');
    }

    const plan = buildStoryboardPrompts(storyboard, 12);
    if (plan.length !== 12) {
      throw new Error(`buildStoryboardPrompts should honour the requested scene count, got ${plan.length}`);
    }
    if (plan.some(entry => !entry.prompt || !entry.videoPrompt)) {
      throw new Error('buildStoryboardPrompts produced an entry without prompts');
    }
    if (buildStoryboardPrompts(null, 8).length !== 0) {
      throw new Error('buildStoryboardPrompts must return an empty plan when there is no storyboard');
    }

    const stored = await db.getStoryboard(storyboard.id);
    if (!stored || stored.shots.length !== storyboard.shots.length || stored.title !== script.title) {
      throw new Error('Storyboard did not survive the database round trip');
    }

    // AI path: fenced JSON must parse, unusable shots must be dropped, and scenes the model
    // skipped must be back-filled from the template so no beat is left without coverage.
    const aiAgent = new StoryboardDirectorAgent(db, {});
    aiAgent.aiTextService = {
      isAvailable: () => true,
      providerName: 'stub',
      generateText: async (prompt) => prompt.includes('visual bible')
        ? '```json\n{"subjects":[{"identifier":"Rooftop array","staticFeatures":"matte blue panels in a grid","dynamicFeatures":"morning dew on the glass"}],"environments":[{"slugline":"EXT. ROOFTOP , DAY","description":"A flat roof with a panel array and city haze behind it"}],"motifs":["hard sunlight"]}\n```'
        : '{"shots":[' +
          '{"sceneIdx":0,"purpose":"open on the array","shotSize":"extreme wide shot","angle":"aerial view","movement":"drone fly-over","subjects":["Rooftop array"],"firstFrame":"Extreme wide shot at aerial view of the rooftop array, panels filling the lower frame.","lastFrame":"Extreme wide shot at aerial view, the array now angled across the frame.","motion":"Camera: drone fly-over moving right. In frame: light sweeps across the panels.","variationType":"large"},' +
          '{"sceneIdx":1,"purpose":"introduce the storage","shotSize":"medium shot","angle":"eye level","movement":"static","subjects":["Ghost subject"],"firstFrame":"Medium shot at eye level of a wall mounted battery, centred in frame.","lastFrame":"Medium shot at eye level, an indicator light now glows on the casing.","motion":"Camera: static. In frame: an indicator light fades up.","variationType":"small"},' +
          '{"sceneIdx":0,"purpose":"unusable","shotSize":"close-up","angle":"eye level","movement":"static","subjects":[],"firstFrame":"","motion":""}' +
          ']}'
    };

    const aiStoryboard = await aiAgent.generateStoryboard(script, { sceneCount: 12 });

    if (aiStoryboard.metadata.generationSource !== 'ai' || aiStoryboard.visualBible.source !== 'ai') {
      throw new Error('Storyboard did not use the AI path when a provider was available');
    }
    if (aiStoryboard.shots.filter(shot => shot.source === 'ai').length !== 2) {
      throw new Error('The AI shot list should keep exactly the two usable shots');
    }
    const coveredScenes = new Set(aiStoryboard.shots.map(shot => shot.sceneIdx));
    if (coveredScenes.size !== aiStoryboard.scenes.length) {
      throw new Error('Scenes skipped by the model were not back-filled from templates');
    }
    if (!aiStoryboard.continuity.warnings.some(warning => warning.includes('Ghost subject'))) {
      throw new Error('Continuity review did not flag the subject missing from the visual bible');
    }

    await db.executeQuery('DELETE FROM storyboards WHERE id IN (?, ?)', [storyboard.id, aiStoryboard.id]);
    await db.close();
    this.logger.info('Storyboard director test completed successfully');
  }

  async testThumbnailUploadContentType() {
    const { R2Storage } = require('./utils/r2-storage');
    const { ProductionManagementAgent } = require('./agents/production-management-agent');
    const fs = require('fs').promises;
    const os = require('os');

    const storage = new R2Storage();
    const jpegPath = path.join(os.tmpdir(), `thumbnail-${Date.now()}.jpg`);
    const pngPath = path.join(os.tmpdir(), `thumbnail-${Date.now()}.png`);
    const textPath = path.join(os.tmpdir(), `thumbnail-${Date.now()}-fake.png`);

    try {
      // The thumbnail fallback writes a JPEG, and both upload sites ask for image/png.
      // The bytes decide: the object is stored as JPEG under a .jpg key instead of being blocked.
      await fs.writeFile(jpegPath, Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'));
      const jpegTarget = await storage.resolveImageTarget(jpegPath, 'productions/test/thumbnail.png', 'image/png');
      if (jpegTarget.contentType !== 'image/jpeg' || !jpegTarget.key.endsWith('/thumbnail.jpg')) {
        throw new Error(`A JPEG thumbnail was not remapped to a JPEG object: ${JSON.stringify(jpegTarget)}`);
      }
      await storage.validateUploadFile(jpegPath, jpegTarget.contentType);

      await fs.writeFile(pngPath, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
      const pngTarget = await storage.resolveImageTarget(pngPath, 'productions/test/thumbnail.png', 'image/png');
      if (pngTarget.contentType !== 'image/png' || pngTarget.key !== 'productions/test/thumbnail.png') {
        throw new Error('A real PNG thumbnail should keep its key and content type');
      }

      // Anything that is not an image at all still has to be refused.
      await fs.writeFile(textPath, 'not an image at all');
      let rejected = false;
      try {
        await storage.validateUploadFile(textPath, 'image/png');
      } catch (error) {
        rejected = /não contém uma imagem PNG válida/i.test(error.message);
      }
      if (!rejected) {
        throw new Error('R2 accepted a text file disguised as a PNG');
      }

      // The production fallback must keep the source extension so the copy is not a lie.
      const agent = new ProductionManagementAgent({}, {});
      await agent.setupDirectories();
      agent.aiVideoGenerator.generateThumbnail = async () => {
        throw new Error('AI thumbnail unavailable');
      };
      const processed = await agent.processThumbnail({ path: jpegPath, fileSize: 20 }, { title: 'Teste' });
      if (path.extname(processed.path) !== '.jpg') {
        throw new Error(`The thumbnail fallback renamed a JPEG to "${path.extname(processed.path)}"`);
      }
      if (processed.simulated) {
        throw new Error('A copied thumbnail should not be reported as simulated');
      }
      const copiedTarget = await storage.resolveImageTarget(processed.path, 'productions/test/thumbnail.png', 'image/png');
      if (copiedTarget.contentType !== 'image/jpeg') {
        throw new Error('The copied thumbnail would still be uploaded as a PNG');
      }
      await fs.unlink(processed.path).catch(() => {});

      const placeholder = await agent.processThumbnail({}, { title: 'Teste' });
      if (!placeholder.simulated) {
        throw new Error('A placeholder thumbnail must be reported as simulated');
      }
      await fs.access(placeholder.path);
      await fs.unlink(placeholder.path).catch(() => {});
    } finally {
      await Promise.all([jpegPath, pngPath, textPath].map(file => fs.unlink(file).catch(() => {})));
    }

    this.logger.info('Thumbnail upload content type test completed successfully');
  }

  async testImageProviderDiagnostics() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const { ProductionManagementAgent } = require('./agents/production-management-agent');
    const axios = require('axios');
    const envKeys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_AI_API_TOKEN', 'IMAGE_PROVIDER', 'R2_ACCOUNT_ID'];
    const savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const cloudflareCreds = { cloudflare: { accountId: 'account-test', apiToken: 'token-test' } };

      const auto = new AIVideoGenerator(cloudflareCreds).describeImageProvider();
      if (auto.provider !== 'cloudflare' || !auto.configured || auto.reason) {
        throw new Error(`Cloudflare credentials alone should resolve to a configured provider: ${JSON.stringify(auto)}`);
      }
      if (!auto.model) {
        throw new Error('The provider description must report which image model is in use');
      }

      // The failure mode that reads as "the thumbnail just fails": IMAGE_PROVIDER points at a
      // provider with no keys, so nothing can generate images even though other keys exist.
      process.env.IMAGE_PROVIDER = 'openai';
      const mismatch = new AIVideoGenerator(cloudflareCreds).describeImageProvider();
      if (mismatch.configured || !/IMAGE_PROVIDER=openai/.test(mismatch.reason || '')) {
        throw new Error(`A provider mismatch must be reported: ${JSON.stringify(mismatch)}`);
      }
      delete process.env.IMAGE_PROVIDER;

      // The provider status and body must survive the friendly message.
      const generator = new AIVideoGenerator(cloudflareCreds);
      const originalPost = axios.post;
      let thrown;
      try {
        axios.post = async () => {
          const error = new Error('Request failed with status code 403');
          error.response = { status: 403, data: { errors: [{ code: 10000, message: 'Authentication error' }] } };
          throw error;
        };
        await generator.generateCloudflareImage('Miniatura de teste', path.join(require('os').tmpdir(), `unused-${Date.now()}.png`));
      } catch (error) {
        thrown = error;
      } finally {
        axios.post = originalPost;
      }

      if (!thrown || thrown.status !== 403) {
        throw new Error(`The HTTP status was lost while wrapping the provider error: ${JSON.stringify(thrown && thrown.status)}`);
      }
      if (!/Authentication error/.test(thrown.providerDetail || '')) {
        throw new Error('The provider response body was not kept for diagnosis');
      }
      if (!/permissão/i.test(thrown.message)) {
        throw new Error('The 403 was not translated into a readable reason');
      }

      // A failed AI thumbnail has to reach the production log, not just the process log.
      const agent = new ProductionManagementAgent({}, cloudflareCreds);
      await agent.setupDirectories();
      agent.aiVideoGenerator.generateThumbnail = async () => {
        const error = new Error('A cota gratuita diária do Cloudflare Workers AI terminou.');
        error.provider = 'cloudflare';
        error.status = 429;
        error.providerDetail = '{"errors":[{"code":10000}]}';
        throw error;
      };

      const events = [];
      const processed = await agent.processThumbnail({}, { title: 'Teste' }, (stage, progress, message, details) => {
        events.push({ stage, progress, message, details });
      });
      const warning = events.find(event => event.details?.level === 'warning');
      if (!warning) {
        throw new Error('The thumbnail failure produced no warning event for the dashboard log');
      }
      if (!/cota gratuita/i.test(warning.message) || warning.details.provider !== 'cloudflare' || warning.details.status !== 429) {
        throw new Error(`The warning event does not carry the provider reason: ${JSON.stringify(warning)}`);
      }
      await require('fs').promises.unlink(processed.path).catch(() => {});
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
      }
    }

    this.logger.info('Image provider diagnostics test completed successfully');
  }

  async testDashboardResponsiveRules() {
    const fs = require('fs').promises;
    const css = await fs.readFile('dashboard/styles.css', 'utf8');

    // These rules are what keep the content detail view inside a phone viewport. The page
    // overflowed by ~56px at 412px wide until they were added.
    const required = [
      { pattern: /\.video-empty \{[^}]*align-content: center/, reason: 'place-content on .video-empty sizes the column to max-content and overflows the video frame' },
      { pattern: /\.detail-heading \{[^}]*flex-wrap: wrap/, reason: '.detail-heading must wrap so the action buttons do not push past the viewport' },
      { pattern: /\.detail-heading > div \{[^}]*min-width: 0/, reason: '.detail-heading title block must be allowed to shrink' },
      { pattern: /\.section-heading \{[^}]*flex-wrap: wrap/, reason: '.section-heading must wrap so its action button stays on screen' }
    ];

    for (const { pattern, reason } of required) {
      if (!pattern.test(css)) {
        throw new Error(`Dashboard CSS regression: ${reason}`);
      }
    }

    if (/\.video-empty \{[^}]*place-content/.test(css) || /\.production-player \{[^}]*place-content/.test(css)) {
      throw new Error('place-content: center is back on a video frame overlay and will overflow again');
    }

    this.logger.info('Dashboard responsive rules test completed successfully');
  }

  async testEvergreenTopics() {
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const agent = new ContentStrategyAgent(null, {});
    agent.historicalPerformance = [];

    // Single scraped keywords must never become video topics
    agent.trendingTopics = [{ topic: 'crown', score: 5 }, { topic: 'official', score: 3 }];
    const fallback = agent.selectOptimalTopic();
    if (!fallback.topic.includes(' ') || fallback.topic.length < 8) {
      throw new Error(`Template mode produced a junk topic: "${fallback.topic}"`);
    }

    // A readable multi-word trend should be used when available
    agent.trendingTopics = [{ topic: 'artificial intelligence explained', score: 5 }];
    const readable = agent.selectOptimalTopic();
    if (readable.topic !== 'artificial intelligence explained') {
      throw new Error(`Readable trending topic was not selected: "${readable.topic}"`);
    }

    this.logger.info('Evergreen template topics test completed successfully');
  }

  async testWalkthroughModule() {
    const { SetupWalkthrough, AI_PROVIDER_GUIDE } = require('./walkthrough');
    const { PROVIDERS } = require('./utils/ai-text-service');

    const walkthrough = new SetupWalkthrough();
    if (typeof walkthrough.run !== 'function') {
      throw new Error('SetupWalkthrough.run is not implemented');
    }

    // Every guided provider must be complete and coherent
    for (const [id, guide] of Object.entries(AI_PROVIDER_GUIDE)) {
      for (const field of ['label', 'keyUrl', 'instructions', 'models', 'defaultModel', 'save', 'validationCreds']) {
        if (!guide[field]) {
          throw new Error(`Provider guide "${id}" is missing "${field}"`);
        }
      }
      if (!guide.models.includes(guide.defaultModel)) {
        throw new Error(`Provider guide "${id}" default model is not in its model list`);
      }

      // save() must produce credentials that pass validation
      const credentials = {};
      guide.save(credentials, 'test-key', guide.defaultModel);
      const manager = new CredentialManager();
      manager.credentials = { youtube: { client_id: 'x' }, ...credentials };

      const envKeys = [...Object.values(PROVIDERS).map(p => p.envKey), 'GEMINI_API_KEY'];
      const savedEnv = {};
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
      try {
        if (manager.getMissingCredentials().length !== 0) {
          throw new Error(`Provider guide "${id}" save() output fails credential validation`);
        }
      } finally {
        for (const key of envKeys) {
          if (savedEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = savedEnv[key];
          }
        }
      }
    }

    this.logger.info('Walkthrough module test completed successfully');
  }

  async testLogger() {
    const testLogger = new Logger('TestLogger');
    
    testLogger.info('Test info message');
    testLogger.warn('Test warning message');
    testLogger.success('Test success message');
    
    // Test timer
    const timer = testLogger.startTimer('Test Operation');
    await new Promise(resolve => setTimeout(resolve, 100));
    timer.end();
    
    this.logger.info('Logger test completed successfully');
  }

  async testDirectories() {
    const fs = require('fs').promises;
    
    const requiredDirs = [
      'config',
      'logs', 
      'data',
      'agents',
      'database',
      'utils',
      'schedules'
    ];

    for (const dir of requiredDirs) {
      const dirPath = path.join(__dirname, dir);
      await fs.access(dirPath);
    }

    this.logger.info('Directory structure test completed successfully');
  }

  async testAgentLoading() {
    // Test that agent files can be loaded
    const agentFiles = [
      './agents/content-strategy-agent',
      './agents/script-writer-agent',
      './agents/storyboard-director-agent',
      './agents/thumbnail-designer-agent',
      './agents/seo-optimizer-agent',
      './agents/production-management-agent',
      './agents/publishing-scheduling-agent',
      './agents/analytics-optimization-agent'
    ];

    for (const agentFile of agentFiles) {
      try {
        require(agentFile);
      } catch (error) {
        throw new Error(`Failed to load ${agentFile}: ${error.message}`);
      }
    }

    this.logger.info('Agent loading test completed successfully');
  }

  async testConfiguration() {
    const fs = require('fs').promises;
    
    // Check package.json
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    if (!packageJson.name || !packageJson.dependencies) {
      throw new Error('Invalid package.json');
    }

    // Check if main index file exists
    await fs.access('./index.js');

    // The startup banner must report the real version. It was hardcoded to "v2.0"
    // through v2.4.0, so bug reports pasted a version that was four releases stale.
    const indexSource = await fs.readFile('index.js', 'utf8');
    const hardcodedBanner = indexSource.match(/YouTube Automation Agent v[\d.]/);
    if (hardcodedBanner) {
      throw new Error(
        `Startup banner hardcodes a version ("${hardcodedBanner[0]}") , interpolate package.json's version instead`
      );
    }
    if (!indexSource.includes('YouTube Automation Agent v${version}')) {
      throw new Error('Startup banner does not report the package.json version');
    }

    // package.json and package-lock.json drifted apart before v2.4.1; keep them aligned
    const lockJson = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
    if (lockJson.version !== packageJson.version) {
      throw new Error(
        `package-lock.json version (${lockJson.version}) does not match package.json (${packageJson.version})`
      );
    }

    this.logger.info('Configuration test completed successfully');
  }
}

// Run tests if called directly
if (require.main === module) {
  const tester = new SystemTest();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error(chalk.red('Test runner failed:'), error);
      process.exit(1);
    });
}

module.exports = { SystemTest };
