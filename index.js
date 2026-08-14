require('dotenv').config();

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { version } = require('./package.json');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.loginAttempts = new Map();
    this.productionJobs = new Map();
    this.googleAuthStates = new Map();
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      await this.db.ensureUser(process.env.AUTH_USERNAME, process.env.AUTH_PASSWORD_HASH);
      const interruptedCount = await this.db.recoverInterruptedProductions();
      if (interruptedCount) this.logger.warn(`${interruptedCount} interrupted production(s) recovered from the previous process`);
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        return false;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();

      // Show which pipeline stages will run for real vs. be simulated
      await this.logCapabilitySummary();
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db);
      await this.scheduler.initialize();
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  async logCapabilitySummary() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials.credentials || {};

    const hasText = this.credentials.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const hasImages = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini);
    const hasTTS = Boolean(
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY ||
      hasGemini
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.credentials.tokens?.youtube);

    const capabilities = [
      { name: 'Script & strategy generation', ok: hasText, hint: 'configure an AI provider (npm run credentials:setup)' },
      { name: 'Image generation (visuals/thumbnails)', ok: hasImages, hint: 'requires an OpenAI or Gemini API key , otherwise gradient slides are used' },
      { name: 'Voice narration (TTS)', ok: hasTTS, hint: 'configure OpenAI, Gemini, ElevenLabs, or Azure Speech , otherwise videos are silent' },
      { name: 'Video assembly (FFmpeg)', ok: hasFFmpeg, hint: ffmpegInstallHint() },
      { name: 'YouTube upload', ok: hasUpload, hint: 'run: npm run credentials:setup' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of capabilities) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} , ${cap.hint}`));
      }
    }

    if (!hasFFmpeg) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
  }

  requireAPIKey() {
    return (req, res, next) => {
      if (!process.env.API_KEY) {
        return next();
      }

      if (req.get('x-api-key') !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      return next();
    };
  }

  parseCookies(header = '') {
    return header.split(';').reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return cookies;
      const key = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      if (key) cookies[key] = decodeURIComponent(value);
      return cookies;
    }, {});
  }

  createSessionToken(username) {
    const expiresAt = Date.now() + (12 * 60 * 60 * 1000);
    const payload = Buffer.from(JSON.stringify({ username, expiresAt })).toString('base64url');
    const signature = crypto
      .createHmac('sha256', process.env.SESSION_SECRET)
      .update(payload)
      .digest('base64url');
    return `${payload}.${signature}`;
  }

  verifySessionToken(token = '') {
    if (!process.env.SESSION_SECRET || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    const expected = crypto
      .createHmac('sha256', process.env.SESSION_SECRET)
      .update(payload)
      .digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
      return null;
    }

    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return session.expiresAt > Date.now() ? session : null;
    } catch (_error) {
      return null;
    }
  }

  verifyPassword(password = '') {
    const encoded = process.env.AUTH_PASSWORD_HASH || '';
    const [salt, expected] = encoded.split(':');
    if (!salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  verifyPasswordHash(password = '', encoded = '') {
    const [salt, expected = ''] = encoded.split(':');
    if (!salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
    return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  }

  hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
    return `${salt}:${hash}`;
  }

  requireAuth() {
    return (req, res, next) => {
      const token = this.parseCookies(req.headers.cookie || '').yaa_session;
      const session = this.verifySessionToken(token);
      if (!session) {
        if (req.path.startsWith('/api/') || req.path === '/analytics' || req.path === '/schedule') {
          return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        return res.redirect('/login');
      }
      req.user = session;
      return next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { valid: false, status: 400, error: 'Request body must be a JSON object' };
    }

    const value = {
      topic: null,
      script: null,
      style: null,
      length: typeof body.length === 'string' ? body.length : 'medium',
      targetMinutes: Number(body.targetMinutes || 8),
      sceneCount: Number(body.sceneCount || 8),
      privacy: typeof body.privacy === 'string' ? body.privacy : 'private',
      narration: body.narration !== false,
      captions: body.captions !== false,
      autoPublish: body.autoPublish === true
    };

    if (!Number.isInteger(value.targetMinutes) || value.targetMinutes < 1 || value.targetMinutes > 30) {
      return { valid: false, status: 400, error: 'targetMinutes must be an integer between 1 and 30' };
    }
    if (!Number.isInteger(value.sceneCount) || value.sceneCount < 3 || value.sceneCount > 24) {
      return { valid: false, status: 400, error: 'sceneCount must be an integer between 3 and 24' };
    }
    if (!['private', 'unlisted', 'public'].includes(value.privacy)) {
      return { valid: false, status: 400, error: 'privacy must be private, unlisted, or public' };
    }

    // JSON has no `undefined`, so clients send `null` to mean "no value provided".
    // Both are treated as "not set" here: topic/style are optional and default to
    // auto-selection, which is exactly what `null` already represents internally.
    if (body.topic !== undefined && body.topic !== null) {
      if (typeof body.topic !== 'string') {
        return { valid: false, status: 400, error: 'topic must be a string' };
      }

      const topic = body.topic.trim();
      if (topic.length > 200) {
        return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
      }
      value.topic = topic || null;
    }

    if (body.script !== undefined && body.script !== null) {
      if (typeof body.script !== 'string') return { valid: false, status: 400, error: 'script must be a string' };
      const script = body.script.trim();
      if (script.length > 5500000) return { valid: false, status: 413, error: 'O roteiro ultrapassa o limite de 5.500.000 caracteres.' };
      value.script = script || null;
      if (!value.topic && script) value.topic = script.split(/\r?\n/).find(Boolean)?.slice(0, 180) || 'Roteiro enviado';
    }

    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string') {
        return { valid: false, status: 400, error: 'style must be a string' };
      }

      const allowedStyles = new Set([
        'tutorial',
        'explainer',
        'list',
        'review',
        'story',
        'educational',
        'informative',
        'engaging',
        'professional',
        'ethereal'
      ]);
      const style = body.style.trim();

      if (style.length > 50) {
        return { valid: false, status: 400, error: 'style must be 50 characters or less' };
      }

      value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
    }

    return { valid: true, value };
  }
  setupAPI() {
    this.app.set('trust proxy', 1);
    this.app.use(express.json({ limit: '6mb' }));
    this.app.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https:; media-src 'self' https://media.gate-arcana.digital https://*.r2.dev; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      next();
    });
    this.app.use('/index.html', this.requireAuth());
    this.app.get('/login.html', (_req, res) => res.redirect('/login'));
    this.app.use(express.static(path.join(__dirname, 'dashboard'), {
      index: false,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-store, max-age=0')
    }));

    if (!process.env.AUTH_USERNAME || !process.env.AUTH_PASSWORD_HASH || !process.env.SESSION_SECRET) {
      throw new Error('AUTH_USERNAME, AUTH_PASSWORD_HASH, and SESSION_SECRET are required');
    }

    this.app.get('/login', (req, res) => {
      const token = this.parseCookies(req.headers.cookie || '').yaa_session;
      if (this.verifySessionToken(token)) return res.redirect('/');
      return res.sendFile(path.join(__dirname, 'dashboard', 'login.html'));
    });

    this.app.post('/api/auth/login', async (req, res) => {
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      const now = Date.now();
      const attempt = this.loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
      if (attempt.resetAt <= now) {
        attempt.count = 0;
        attempt.resetAt = now + 15 * 60 * 1000;
      }
      if (attempt.count >= 5) {
        return res.status(429).json({ success: false, error: 'Muitas tentativas. Aguarde alguns minutos.' });
      }

      const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
      const user = await this.db.getUserByUsername(username);
      const [salt, expected = ''] = (user?.password_hash || '').split(':');
      const actual = salt && typeof req.body?.password === 'string'
        ? crypto.pbkdf2Sync(req.body.password, salt, 210000, 32, 'sha256').toString('hex')
        : '';
      const passwordMatches = actual.length === expected.length && actual.length > 0 && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
      if (!user || !Number(user.active) || !passwordMatches) {
        attempt.count += 1;
        this.loginAttempts.set(ip, attempt);
        return res.status(401).json({ success: false, error: 'Usuário ou senha incorretos.' });
      }

      this.loginAttempts.delete(ip);
      const token = this.createSessionToken(user.username);
      res.setHeader('Set-Cookie', `yaa_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);
      return res.json({ success: true });
    });

    this.app.post('/api/auth/logout', this.requireAuth(), (_req, res) => {
      res.setHeader('Set-Cookie', 'yaa_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
      return res.json({ success: true });
    });

    this.app.get('/api/auth/status', this.requireAuth(), (req, res) => {
      res.json({ authenticated: true, username: req.user.username });
    });

    this.app.put('/api/account', this.requireAuth(), async (req, res) => {
      try {
        const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
        const requestedUsername = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
        const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
        const user = await this.db.getUserByUsername(req.user.username);
        const username = requestedUsername || user?.username || '';
        const validUsername = /^[a-zA-Z0-9._-]{3,40}$/.test(username);
        const validEmail = username.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username);
        if (!validUsername && !validEmail) return res.status(400).json({ success: false, field: 'username', error: 'Informe um email válido ou um usuário de 3 a 40 caracteres.' });
        if (newPassword.length < 12) return res.status(400).json({ success: false, field: 'newPassword', error: 'A nova senha deve ter pelo menos 12 caracteres.' });
        if (!user || !this.verifyPasswordHash(currentPassword, user.password_hash)) return res.status(403).json({ success: false, error: 'A senha atual está incorreta.' });
        const existing = await this.db.getUserByUsername(username);
        if (existing && existing.id !== user.id) return res.status(409).json({ success: false, error: 'Este usuário já está em uso.' });
        await this.db.updateUserCredentials(user.id, username, this.hashPassword(newPassword));
        res.setHeader('Set-Cookie', 'yaa_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');
        return res.json({ success: true });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/auth/google', this.requireAuth(), (req, res) => {
      try {
        const state = crypto.randomBytes(24).toString('hex');
        this.googleAuthStates.set(state, Date.now() + (10 * 60 * 1000));
        const oauth2Client = this.credentials.getYouTubeAuth();
        const authUrl = oauth2Client.generateAuthUrl({
          access_type: 'offline',
          prompt: 'consent',
          state,
          scope: [
            'https://www.googleapis.com/auth/youtube.upload',
            'https://www.googleapis.com/auth/youtube.readonly',
            'https://www.googleapis.com/auth/yt-analytics.readonly'
          ]
        });
        return res.redirect(authUrl);
      } catch (error) {
        return res.redirect(`/#connections?google_error=${encodeURIComponent(error.message)}`);
      }
    });

    this.app.get('/auth/google/callback', async (req, res) => {
      const expiresAt = this.googleAuthStates.get(req.query.state);
      this.googleAuthStates.delete(req.query.state);
      if (!req.query.code || !expiresAt || expiresAt < Date.now()) return res.status(400).send('Solicitação de conexão inválida ou expirada.');
      try {
        const oauth2Client = this.credentials.getYouTubeAuth();
        const { tokens } = await oauth2Client.getToken(req.query.code);
        this.credentials.tokens.youtube = tokens;
        await this.credentials.saveTokens();
        this.agents.publishing.youtube = this.credentials.getYouTubeClient();
        return res.redirect('/#connections');
      } catch (error) {
        this.logger.error('Google OAuth callback failed:', error);
        return res.status(500).send('Não foi possível concluir a conexão com o Google.');
      }
    });

    // Main dashboard route
    this.app.get('/', this.requireAuth(), (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        initialized: this.isInitialized,
        agents: Object.keys(this.agents),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Manual content generation
    this.app.post('/generate', this.requireAuth(), async (req, res) => {
      try {
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const jobId = `job_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const options = validation.value;
        this.updateProductionJob(jobId, 'queued', 3, 'Produção adicionada à fila');
        res.status(202).json({ success: true, jobId });
        Promise.resolve().then(async () => {
          try {
            const result = await this.generateContent(options.topic, options.style, options.length, options, jobId);
            this.updateProductionJob(jobId, 'completed', 100, 'Conteúdo pronto', result);
          } catch (error) {
            this.updateProductionJob(jobId, 'failed', 100, error.message);
            this.logger.error(`Production job ${jobId} failed:`, error);
          }
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/review-script', this.requireAuth(), async (req, res) => {
      try {
        const script = typeof req.body?.script === 'string' ? req.body.script.trim() : '';
        if (!script) return res.status(400).json({ success: false, error: 'Cole ou escreva um roteiro para revisar.' });
        if (script.length > 5500000) return res.status(413).json({ success: false, error: 'O roteiro ultrapassa o limite de 5.500.000 caracteres.' });
        const reviewer = this.agents.scriptWriter.aiTextService;
        if (!reviewer?.isAvailable()) return res.status(503).json({ success: false, error: 'A IA de revisão ainda não está configurada.' });
        const sample = script.length <= 120000
          ? script
          : `${script.slice(0, 40000)}\n\n[MEIO DO ROTEIRO]\n${script.slice(Math.floor(script.length / 2) - 20000, Math.floor(script.length / 2) + 20000)}\n\n[FINAL DO ROTEIRO]\n${script.slice(-40000)}`;
        const report = await reviewer.generateText(`Você é um editor profissional de roteiros bíblicos para YouTube. Revise o texto abaixo em português do Brasil. Analise fidelidade e coerência bíblica, clareza, estrutura narrativa, ritmo para narração, repetições, linguagem, retenção e possíveis afirmações que precisam de verificação. Não reescreva o roteiro inteiro. Entregue um relatório prático com: Resumo, Pontos fortes, Correções prioritárias e Sugestões de melhoria. Informe claramente quando a análise tiver sido feita por amostragem.\n\nTamanho total: ${script.length} caracteres.\n\nROTEIRO:\n${sample}`, { maxTokens: 2400, temperature: 0.3 });
        return res.json({ success: true, report, sampled: script.length > 120000, reviewedCharacters: sample.length, totalCharacters: script.length });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/suggest-scenes', this.requireAuth(), async (req, res) => {
      try {
        const script = typeof req.body?.script === 'string' ? req.body.script.trim() : '';
        const targetMinutes = Math.min(30, Math.max(1, Number(req.body?.targetMinutes) || 8));
        const style = ['story', 'educational', 'explainer', 'list'].includes(req.body?.style) ? req.body.style : 'story';
        if (script.length > 5500000) return res.status(413).json({ success: false, error: 'O roteiro ultrapassa o limite de 5.500.000 caracteres.' });
        const paceByStyle = { story: 1.7, educational: 1.35, explainer: 1.5, list: 1.8 };
        const fallbackCount = Math.min(24, Math.max(3, Math.round(targetMinutes * paceByStyle[style])));
        const reviewer = this.agents.scriptWriter.aiTextService;
        if (!reviewer?.isAvailable()) {
          const seconds = Math.round((targetMinutes * 60) / fallbackCount);
          return res.json({ success: true, sceneCount: fallbackCount, reason: `Recomendação calculada: ${fallbackCount} cenas, com uma mudança visual a cada ${seconds} segundos.` });
        }
        const sample = script.length > 12000 ? `${script.slice(0, 6000)}\n\n[FINAL]\n${script.slice(-6000)}` : script;
        const answer = await reviewer.generateText(`Você é um diretor de vídeos para YouTube. Recomende uma quantidade de cenas entre 3 e 24 para um vídeo de ${targetMinutes} minutos no formato ${style}. O objetivo é manter ritmo visual, clareza e retenção sem criar cortes excessivos. Quantidade calculada como referência: ${fallbackCount}. Considere o roteiro quando ele estiver disponível. Responda somente em JSON válido com as chaves sceneCount, que deve ser um número inteiro, e reason, com uma explicação curta em português do Brasil. Não use travessão.\n\nROTEIRO:\n${sample || 'Roteiro ainda não informado.'}`, { maxTokens: 300, temperature: 0.2 });
        const jsonText = String(answer).match(/\{[\s\S]*\}/)?.[0];
        const parsed = jsonText ? JSON.parse(jsonText) : {};
        const sceneCount = Math.min(24, Math.max(3, Math.round(Number(parsed.sceneCount) || fallbackCount)));
        const seconds = Math.round((targetMinutes * 60) / sceneCount);
        const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim().replace(/[\u2013\u2014]/g, ',')
          : `Recomendo ${sceneCount} cenas, com uma mudança visual a cada ${seconds} segundos.`;
        return res.json({ success: true, sceneCount, reason });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/production-status', this.requireAuth(), async (_req, res) => {
      try {
        const persisted = await this.db.getProductionJobs(20);
        const merged = new Map(persisted.map((job) => [job.id, job]));
        for (const job of this.productionJobs.values()) merged.set(job.id, job);
        const jobs = Array.from(merged.values())
          .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
          .slice(0, 20);
        res.json(jobs);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', this.requireAuth(), async (req, res) => {
      try {
        const analytics = await this.agents.analytics.getRecentAnalytics();
        res.json(analytics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', this.requireAuth(), async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/contents', this.requireAuth(), async (_req, res) => {
      try {
        const contents = await this.db.getContentLibrary();
        res.json(contents);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/contents/:contentId', this.requireAuth(), async (req, res) => {
      try {
        const contents = await this.db.getContentLibrary();
        const content = contents.find((item) => item.id === req.params.contentId);
        if (!content) return res.status(404).json({ error: 'Conteúdo não encontrado.' });
        return res.json(content);
      } catch (error) {
        return res.status(500).json({ error: error.message });
      }
    });

    this.app.patch('/contents/:contentId', this.requireAuth(), async (req, res) => {
      try {
        const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
        const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
        if (!title || title.length > 100) return res.status(400).json({ success: false, error: 'O título deve ter de 1 a 100 caracteres.' });
        if (!topic || topic.length > 300) return res.status(400).json({ success: false, error: 'O tema deve ter de 1 a 300 caracteres.' });
        const updated = await this.db.updateContentMetadata(req.params.contentId, title, topic);
        if (!updated) return res.status(404).json({ success: false, error: 'Conteúdo não encontrado.' });
        return res.json({ success: true });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.delete('/contents/:contentId', this.requireAuth(), async (req, res) => {
      try {
        const deleted = await this.db.deleteContent(req.params.contentId);
        if (!deleted) return res.status(404).json({ success: false, error: 'Conteúdo não encontrado.' });
        let deletedFiles = 0;
        try {
          deletedFiles = await this.agents.production.storage.deleteProductionAssets(req.params.contentId);
        } catch (error) {
          this.logger.warn(`Content deleted, but R2 cleanup failed for ${req.params.contentId}: ${error.message}`);
        }
        return res.json({ success: true, deletedFiles, youtubePreserved: Boolean(deleted.youtubeUrl) });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/connections', this.requireAuth(), async (_req, res) => {
      const result = {
        youtube: { connected: false, authorized: Boolean(this.credentials.tokens?.youtube) },
        ai: { connected: this.credentials.hasAITextProvider(), provider: process.env.GEMINI_API_KEY ? 'Gemini' : process.env.OPENAI_API_KEY ? 'OpenAI' : null },
        storage: { connected: Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET), provider: process.env.R2_BUCKET ? 'Cloudflare R2' : 'Railway Volume', bucket: process.env.R2_BUCKET || null },
        database: { connected: true, provider: this.db.isPostgres ? 'PostgreSQL' : 'SQLite', managedBy: this.db.isPostgres ? 'Railway' : 'Aplicação' }
      };
      try {
        const youtube = this.credentials.getYouTubeClient();
        const response = await youtube.channels.list({ part: 'snippet,statistics', mine: true });
        const channel = response.data.items?.[0];
        if (channel) {
          result.youtube = {
            connected: true,
            id: channel.id,
            title: channel.snippet?.title,
            description: channel.snippet?.description,
            customUrl: channel.snippet?.customUrl,
            country: channel.snippet?.country,
            createdAt: channel.snippet?.publishedAt,
            thumbnail: channel.snippet?.thumbnails?.medium?.url || channel.snippet?.thumbnails?.default?.url,
            subscribers: Number(channel.statistics?.subscriberCount || 0),
            views: Number(channel.statistics?.viewCount || 0),
            videos: Number(channel.statistics?.videoCount || 0),
            privacyStatus: channel.status?.privacyStatus
          };
        }
      } catch (error) {
        this.logger.warn(`Could not read YouTube channel details: ${error.message}`);
      }
      res.json(result);
    });

    const allowedSettings = new Set(['default_target_minutes', 'default_scene_count', 'default_privacy', 'default_narration', 'default_captions', 'auto_publish_enabled']);
    this.app.get('/settings', this.requireAuth(), async (_req, res) => {
      try {
        const settings = await this.db.getAllSettings();
        res.json(Object.fromEntries(Object.entries(settings).filter(([key]) => allowedSettings.has(key))));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
    this.app.put('/settings', this.requireAuth(), async (req, res) => {
      try {
        const entries = Object.entries(req.body || {}).filter(([key]) => allowedSettings.has(key));
        for (const [key, value] of entries) await this.db.setSetting(key, String(value));
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAuth(), async (req, res) => {
      try {
        const { contentId } = req.params;
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  updateProductionJob(id, stage, progress, message, result = null) {
    const existing = this.productionJobs.get(id) || { id, startedAt: new Date().toISOString() };
    const job = { ...existing, stage, progress, message, result, updatedAt: new Date().toISOString() };
    this.productionJobs.set(id, job);
    this.db.saveProductionJob(job).catch((error) => this.logger.warn(`Could not persist production job ${id}: ${error.message}`));
  }

  async generateContent(topic = null, style = null, length = 'medium', options = {}, jobId = null) {
    this.logger.info('Starting content generation pipeline...');
    
    // Step 1: Strategy
    if (jobId) this.updateProductionJob(jobId, 'strategy', 10, 'Definindo tema e abordagem');
    const strategy = await this.agents.strategy.generateContentStrategy(topic);
    strategy.targetMinutes = options.targetMinutes || 8;
    this.logger.info(`Strategy generated: ${strategy.topic}`);
    
    // Step 2: Script Writing
    if (jobId) this.updateProductionJob(jobId, 'script', 25, 'Escrevendo o roteiro');
    const script = options.script
      ? await this.agents.scriptWriter.createScriptFromText(options.script, strategy, { targetMinutes: strategy.targetMinutes })
      : await this.agents.scriptWriter.generateScript(strategy, { targetMinutes: strategy.targetMinutes });
    this.logger.info(`Script generated: ${script.title}`);
    
    // Step 3: Thumbnail Design
    if (jobId) this.updateProductionJob(jobId, 'thumbnail', 40, 'Criando a miniatura');
    const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
    this.logger.info('Thumbnail generated');
    
    // Step 4: SEO Optimization
    if (jobId) this.updateProductionJob(jobId, 'seo', 52, 'Preparando título, descrição e SEO');
    const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
    this.logger.info('SEO optimization complete');
    
    // Step 5: Production Management
    if (jobId) this.updateProductionJob(jobId, 'production', 65, 'Gerando áudio, cenas e legendas');
    const productionData = await this.agents.production.processContent({
      strategy,
      script,
      thumbnail,
      seo: seoData,
      options,
      onProgress: (stage, progress, message) => {
        if (jobId) this.updateProductionJob(jobId, stage, progress, message);
      }
    });
    productionData.settings = options;
    this.logger.info('Production processing complete');

    // Step 6: Save to database
    const contentId = await this.db.saveProductionData(productionData);
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 7: Add to the publish queue (skipped automatically for simulated output)
    if (jobId) this.updateProductionJob(jobId, 'scheduling', 96, 'Salvando e preparando a publicação');
    const scheduleEntry = options.autoPublish === false ? null : await this.agents.publishing.scheduleContent(productionData);
    if (scheduleEntry) {
      this.logger.info(`Content queued for publishing at ${scheduleEntry.publishTime}`);
    }

    return {
      contentId,
      title: script.title,
      status: productionData.status,
      scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null
    };
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.yellow('\n🤖 Automation is active. Content will be generated and posted daily.'));
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };
