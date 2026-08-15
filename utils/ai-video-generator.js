const OpenAI = require('openai');
const Replicate = require('replicate');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const { Logger } = require('./logger');
const { runFFmpeg, checkFFmpeg, probeMediaDuration, ffmpegInstallHint } = require('./ffmpeg');
const { GeminiClientPool, geminiKeys } = require('./gemini-client-pool');

class AIVideoGenerator {
  constructor(credentials) {
    this.logger = new Logger('AIVideoGenerator');
    credentials = credentials || {};
    
    // Initialize AI services with graceful fallback
    const openaiKey = credentials.openai?.apiKey || process.env.OPENAI_API_KEY;
    const replicateKey = credentials.replicate?.apiKey || process.env.REPLICATE_API_KEY;
    
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.info('OpenAI service initialized');
    } else {
      this.logger.warn('OpenAI API key not found - AI features will be simulated');
    }
    
    if (replicateKey) {
      this.replicate = new Replicate({ auth: replicateKey });
      this.logger.info('Replicate service initialized');
    } else {
      this.logger.warn('Replicate API key not found - advanced video generation unavailable');
    }

    this.cloudflareAccountId = credentials.cloudflare?.accountId
      || process.env.CLOUDFLARE_ACCOUNT_ID
      || process.env.R2_ACCOUNT_ID;
    this.cloudflareAIApiToken = credentials.cloudflare?.apiToken
      || process.env.CLOUDFLARE_AI_API_TOKEN;
    this.cloudflareImageModel = process.env.CLOUDFLARE_IMAGE_MODEL
      || '@cf/black-forest-labs/flux-1-schnell';
    this.openaiImageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
    this.cloudflareImageSteps = Math.min(8, Math.max(1, Number(process.env.CLOUDFLARE_IMAGE_STEPS) || 4));
    this.cloudflareAI = Boolean(this.cloudflareAccountId && this.cloudflareAIApiToken);
    if (this.cloudflareAI) this.logger.info('Cloudflare Workers AI image service initialized');

    // Gemini media generation (images + native TTS) , free-tier alternative to OpenAI
    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      try {
        this.geminiPool = new GeminiClientPool(geminiKeys(geminiKey), this.logger);
        this.gemini = this.geminiPool.clients[0];
        this.logger.info('Gemini media service initialized (images + TTS)');
      } catch (error) {
        this.logger.warn('Failed to initialize Gemini media service:', error.message);
      }
    }

    const requestedImageProvider = String(process.env.IMAGE_PROVIDER || '').trim().toLowerCase();
    this.imageProvider = requestedImageProvider || (this.cloudflareAI ? 'cloudflare' : this.openai ? 'openai' : this.gemini ? 'gemini' : null);

    this.pexelsApiKey = credentials.pexels?.apiKey || process.env.PEXELS_API_KEY;
    this.pixabayApiKey = credentials.pixabay?.apiKey || process.env.PIXABAY_API_KEY;
    this.stockVideoProvider = this.pexelsApiKey ? 'pexels' : this.pixabayApiKey ? 'pixabay' : null;
    if (this.stockVideoProvider) this.logger.info(`Stock video service initialized: ${this.stockVideoProvider}`);
    
    // ElevenLabs configuration
    this.elevenLabsApiKey = credentials.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY;
    this.elevenLabsVoiceId = credentials.elevenLabs?.voiceId || process.env.ELEVENLABS_VOICE_ID;
    
    // Azure Speech configuration
    this.azureSpeechKey = credentials.azure?.speechKey || process.env.AZURE_SPEECH_KEY;
    this.azureSpeechRegion = credentials.azure?.speechRegion || process.env.AZURE_SPEECH_REGION;
  }

  async generateTTSAudio(text, outputPath, onProgress = () => {}) {
    this.logger.info('Generating TTS audio...');
    
    try {
      // Try ElevenLabs first (higher quality)
      if (this.elevenLabsApiKey && this.elevenLabsVoiceId) {
        const result = await this.generateElevenLabsTTS(text, outputPath);
        onProgress({ completed: 1, total: 1 });
        return result;
      }
      
      // Fallback to OpenAI TTS
      if (this.openai) {
        const result = await this.generateOpenAITTS(text, outputPath);
        onProgress({ completed: 1, total: 1 });
        return result;
      }

      // Fallback to Gemini native TTS (free tier)
      if (this.gemini) {
        return await this.generateGeminiTTS(text, outputPath, onProgress);
      }

      throw new Error('Nenhum provedor de narração está configurado.');
    } catch (error) {
      this.logger.error('TTS generation failed:', error);
      throw error;
    }
  }

  async generateElevenLabsTTS(text, outputPath) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${this.elevenLabsVoiceId}`;
    
    const data = {
      text: text,
      model_id: "eleven_v3",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.0,
        use_speaker_boost: true
      }
    };

    const response = await axios({
      method: 'POST',
      url: url,
      data: data,
      headers: {
        'Accept': 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey
      },
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        this.logger.info('ElevenLabs TTS generation complete');
        resolve(outputPath);
      });
      writer.on('error', reject);
    });
  }

  async generateOpenAITTS(text, outputPath) {
    const response = await this.openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "coral",
      input: text,
      speed: 1.0
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(outputPath, buffer);

    this.logger.info('OpenAI TTS generation complete');
    return outputPath;
  }

  async generateGeminiTTS(text, outputPath, onProgress = () => {}) {
    const chunks = this.splitTextForTTS(text);
    if (chunks.length > 1) return await this.generateGeminiTTSChunks(chunks, outputPath, onProgress);
    const result = await this.generateGeminiTTSChunk(text, outputPath);
    onProgress({ completed: 1, total: 1 });
    return result;
  }

  splitTextForTTS(text, maxCharacters = 3000) {
    const sentences = String(text || '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [''];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence.trim()}` : sentence.trim();
      if (candidate.length > maxCharacters && current) {
        chunks.push(current);
        current = sentence.trim();
      } else {
        current = candidate;
      }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [''];
  }

  async generateGeminiTTSChunks(chunks, outputPath, onProgress = () => {}) {
    const partPaths = [];
    const listPath = `${outputPath}.concat.txt`;
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        const partPath = `${outputPath}.part-${String(index).padStart(3, '0')}.mp3`;
        await this.generateGeminiTTSChunk(chunks[index], partPath);
        partPaths.push(partPath);
        onProgress({ completed: index + 1, total: chunks.length });
      }
      await fs.writeFile(listPath, partPaths.map(part => `file '${part}'`).join('\n'));
      await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
      return outputPath;
    } finally {
      await Promise.all([...partPaths, listPath].map(file => fs.unlink(file).catch(() => {})));
    }
  }

  async generateGeminiTTSChunk(text, outputPath) {
    const model = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
    const voiceName = process.env.GEMINI_TTS_VOICE || 'Kore';

    const response = await this.geminiPool.run((client) => client.models.generateContent({
      model,
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName }
          }
        }
      }
    }));

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error('Gemini TTS returned no audio data');
    }

    // Gemini returns raw PCM (24kHz, mono, 16-bit); encode to the requested container via FFmpeg
    const pcmPath = outputPath + '.pcm';
    await fs.writeFile(pcmPath, Buffer.from(audioData, 'base64'));
    await runFFmpeg(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, outputPath]);
    await fs.unlink(pcmPath).catch(() => {});

    this.logger.info('Gemini TTS generation complete');
    return outputPath;
  }

  async generateVisualAssets(prompt, style = "ethereal", count = 1) {
    this.logger.info(`Generating ${count} visual assets with style: ${style}`);

    try {
      if (!this.hasConfiguredImageProvider()) {
        throw new Error('Nenhum provedor de imagens está configurado.');
      }

      const enhancedPrompt = this.enhanceVisualPrompt(prompt, style);
      const localPaths = [];

      for (let i = 0; i < count; i++) {
        const imagePath = path.join(__dirname, '..', 'data', 'assets', `visual_${Date.now()}_${i}.png`);
        await this.generateImage(enhancedPrompt, imagePath);
        localPaths.push(imagePath);
      }

      this.logger.info(`Generated ${localPaths.length} visual assets`);
      return localPaths;
    } catch (error) {
      this.logger.error('Visual asset generation failed:', error);
      throw this.wrapImageError(error, this.formatImageGenerationError(error));
    }
  }

  hasConfiguredImageProvider() {
    if (this.imageProvider === 'cloudflare') return this.cloudflareAI;
    if (this.imageProvider === 'openai') return Boolean(this.openai);
    if (this.imageProvider === 'gemini') return Boolean(this.gemini);
    return false;
  }

  async generateImage(prompt, imagePath) {
    await fs.mkdir(path.dirname(imagePath), { recursive: true });

    if (this.imageProvider === 'cloudflare' && this.cloudflareAI) {
      return await this.generateCloudflareImage(prompt, imagePath);
    }

    if (this.imageProvider === 'openai' && this.openai) {
      return await this.generateOpenAIImage(prompt, imagePath);
    }

    if (this.imageProvider === 'gemini' && this.gemini) {
      return await this.generateGeminiImage(prompt, imagePath);
    }

    throw new Error(`O provedor de imagens ${this.imageProvider || 'solicitado'} não está configurado.`);
  }

  async generateCloudflareImage(prompt, imagePath) {
    const modelPath = this.cloudflareImageModel.split('/').map(encodeURIComponent).join('/');
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.cloudflareAccountId)}/ai/run/${modelPath}`;

    try {
      const response = await axios.post(url, {
        prompt: String(prompt || '').slice(0, 2048),
        steps: this.cloudflareImageSteps
      }, {
        headers: {
          Authorization: `Bearer ${this.cloudflareAIApiToken}`,
          'Content-Type': 'application/json'
        },
        timeout: Math.max(15000, Number(process.env.CLOUDFLARE_AI_TIMEOUT_MS) || 120000)
      });

      const encodedImage = response.data?.result?.image || response.data?.image;
      if (!encodedImage) throw new Error('O Cloudflare Workers AI não retornou uma imagem.');

      const base64 = String(encodedImage).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
      const buffer = Buffer.from(base64, 'base64');
      if (!buffer.length) throw new Error('O Cloudflare Workers AI retornou uma imagem vazia.');

      await sharp(buffer).png().toFile(imagePath);
      return imagePath;
    } catch (error) {
      throw this.wrapImageError(error, this.formatCloudflareImageError(error));
    }
  }

  // A mensagem amigável some com o status e o corpo da resposta, que são justamente
  // o que diz por que o provedor recusou. Guarda os dois no erro.
  wrapImageError(error, message) {
    if (error?.isImageProviderError) return error;
    const wrapped = new Error(message);
    wrapped.isImageProviderError = true;
    wrapped.provider = this.imageProvider || null;
    wrapped.status = Number(error?.response?.status || error?.status) || null;
    wrapped.providerDetail = this.extractProviderDetail(error);
    wrapped.cause = error;
    return wrapped;
  }

  extractProviderDetail(error) {
    const data = error?.response?.data;
    if (data) {
      try {
        return (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 400);
      } catch (stringifyError) {
        return String(error?.message || '').slice(0, 400);
      }
    }
    return String(error?.message || '').slice(0, 400);
  }

  // Estado real do provedor de imagens, usado pelo diagnóstico e pelo resumo de inicialização.
  describeImageProvider() {
    const requested = String(process.env.IMAGE_PROVIDER || '').trim().toLowerCase() || null;
    const available = { cloudflare: Boolean(this.cloudflareAI), openai: Boolean(this.openai), gemini: Boolean(this.gemini) };
    const models = { cloudflare: this.cloudflareImageModel, openai: this.openaiImageModel, gemini: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image' };
    const configured = this.hasConfiguredImageProvider();

    let reason = null;
    if (!this.imageProvider) {
      reason = 'nenhuma credencial de imagem foi encontrada (Cloudflare Workers AI, OpenAI ou Gemini)';
    } else if (!configured && requested) {
      reason = `IMAGE_PROVIDER=${requested} está selecionado, mas as credenciais desse provedor não foram encontradas`;
    } else if (!configured) {
      reason = `o provedor ${this.imageProvider} não está configurado`;
    }

    return {
      provider: this.imageProvider || null,
      requested,
      configured,
      available,
      model: this.imageProvider ? models[this.imageProvider] || null : null,
      reason
    };
  }

  formatCloudflareImageError(error) {
    const status = Number(error?.response?.status || error?.status || error?.code);
    if (status === 429) {
      return 'A cota gratuita diária do Cloudflare Workers AI terminou. Ela será renovada automaticamente às 00:00 UTC.';
    }
    if (status === 401 || status === 403) {
      return 'O token do Cloudflare Workers AI não tem permissão para gerar imagens.';
    }
    if (/timeout|timed out|aborted/i.test(String(error?.message || ''))) {
      return 'O Cloudflare Workers AI demorou demais para responder.';
    }
    return String(error?.message || 'O Cloudflare Workers AI não conseguiu gerar a imagem.');
  }

  formatImageGenerationError(error) {
    const message = this.imageProvider === 'cloudflare'
      ? this.formatCloudflareImageError(error)
      : String(error?.message || 'O provedor de imagens não respondeu.');
    const provider = this.imageProvider ? ` (provedor: ${this.imageProvider})` : '';
    return `Não foi possível gerar as imagens${provider}: ${message}`;
  }

  async generateOpenAIImage(prompt, imagePath) {
    const response = await this.openai.images.generate({
      model: this.openaiImageModel,
      prompt: prompt,
      n: 1,
      size: "1536x1024",
      quality: "high",
    });

    if (response.data[0].b64_json) {
      const buffer = Buffer.from(response.data[0].b64_json, 'base64');
      await fs.writeFile(imagePath, buffer);
    } else {
      await this.downloadImage(response.data[0].url, imagePath);
    }

    return imagePath;
  }

  async generateGeminiImage(prompt, imagePath) {
    const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

    const response = await this.geminiPool.run((client) => client.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio: '16:9' }
      }
    }));

    const parts = response.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(part => part.inlineData?.data);
    if (!imagePart) {
      throw new Error('Gemini image generation returned no image data');
    }

    await fs.writeFile(imagePath, Buffer.from(imagePart.inlineData.data, 'base64'));
    return imagePath;
  }

  enhanceVisualPrompt(prompt, style) {
    const styleEnhancements = {
      ethereal: "ethereal, dreamy, mystical, soft lighting, floating particles, cosmic background",
      modern: "modern, clean, minimalist, professional, sleek design, contemporary",
      animated: "animated style, cartoon, vibrant colors, expressive, dynamic",
      cinematic: "cinematic lighting, dramatic, movie poster style, high contrast",
      abstract: "abstract art, geometric shapes, gradient colors, artistic composition"
    };

    const enhancement = styleEnhancements[style] || styleEnhancements.ethereal;
    return `${prompt}, ${enhancement}, high quality, 16:9 aspect ratio, digital art`;
  }

  async downloadImage(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  hasStockVideoProvider() {
    return Boolean(this.stockVideoProvider);
  }

  normalizeStockQuery(value) {
    const replacements = new Map([
      ['bíblia', 'bible'], ['biblico', 'biblical'], ['bíblico', 'biblical'],
      ['jesus', 'jesus'], ['cristo', 'christ'], ['deus', 'god'],
      ['jerusalém', 'jerusalem'], ['jerusalem', 'jerusalem'],
      ['deserto', 'desert'], ['tempestade', 'storm'], ['mar', 'sea'],
      ['oração', 'prayer'], ['oracao', 'prayer'], ['cruz', 'cross'],
      ['igreja', 'church'], ['céu', 'heaven'], ['ceu', 'heaven'],
      ['milagre', 'miracle'], ['profeta', 'prophet'], ['antigo', 'ancient']
    ]);
    const ignored = new Set(['cena', 'composicao', 'visual', 'distinta', 'eterno', 'ethereal', 'dreamy', 'mystical', 'lighting', 'background', 'high', 'quality', 'aspect', 'ratio', 'digital', 'art']);
    const words = String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !ignored.has(word));
    const translated = words.map(word => replacements.get(word) || word);
    return Array.from(new Set(['biblical', ...translated])).slice(0, 8).join(' ');
  }

  async fetchStockVideo(query, outputPath, usedIds = new Set()) {
    if (!this.hasStockVideoProvider()) return null;
    const normalizedQuery = this.normalizeStockQuery(query);
    const result = this.stockVideoProvider === 'pexels'
      ? await this.searchPexelsVideo(normalizedQuery, usedIds)
      : await this.searchPixabayVideo(normalizedQuery, usedIds);
    if (!result) return null;

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await this.downloadVideo(result.url, outputPath);
    const stats = await fs.stat(outputPath);
    if (!stats.isFile() || stats.size < 10000) {
      await fs.unlink(outputPath).catch(() => {});
      throw new Error('O vídeo de acervo recebido está vazio ou incompleto.');
    }
    return { ...result, path: outputPath, query: normalizedQuery };
  }

  async searchPexelsVideo(query, usedIds = new Set()) {
    const response = await axios.get('https://api.pexels.com/v1/videos/search', {
      headers: { Authorization: this.pexelsApiKey },
      params: { query, orientation: 'landscape', size: 'medium', per_page: 15, locale: 'pt-BR' },
      timeout: 30000
    });
    for (const video of response.data?.videos || []) {
      const id = `pexels:${video.id}`;
      if (usedIds.has(id)) continue;
      const candidates = (video.video_files || [])
        .filter(file => file.link && file.file_type === 'video/mp4')
        .sort((a, b) => Math.abs((a.width || 1280) - 1920) - Math.abs((b.width || 1280) - 1920));
      const file = candidates.find(candidate => (candidate.width || 0) >= 1280) || candidates[0];
      if (!file) continue;
      usedIds.add(id);
      return {
        id,
        provider: 'Pexels',
        url: file.link,
        sourceUrl: video.url,
        creator: video.user?.name || null,
        width: file.width,
        height: file.height,
        duration: video.duration
      };
    }
    return null;
  }

  async searchPixabayVideo(query, usedIds = new Set()) {
    const response = await axios.get('https://pixabay.com/api/videos/', {
      params: { key: this.pixabayApiKey, q: query, video_type: 'film', category: 'religion', safesearch: true, per_page: 20 },
      timeout: 30000
    });
    for (const video of response.data?.hits || []) {
      const id = `pixabay:${video.id}`;
      if (usedIds.has(id)) continue;
      const file = video.videos?.medium || video.videos?.small || video.videos?.large;
      if (!file?.url) continue;
      usedIds.add(id);
      return {
        id,
        provider: 'Pixabay',
        url: file.url,
        sourceUrl: video.pageURL,
        creator: video.user || null,
        width: file.width,
        height: file.height,
        duration: video.duration
      };
    }
    return null;
  }

  async generateVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Generating video from assets...');
    
    try {
      return await this.generateHybridVideo(script, visualAssets, audioPath, outputPath);
    } catch (error) {
      this.logger.error('Video generation failed:', error);
      throw error;
    }
  }

  async generateHybridVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating cinematic hybrid video...');
    if (!(await checkFFmpeg())) throw new Error(ffmpegInstallHint());

    const mediaAssets = await this.filterMediaAssets(visualAssets);
    if (!mediaAssets.length) throw new Error('Nenhuma cena válida foi encontrada para montar o vídeo.');

    const workDir = path.join(path.dirname(outputPath), `${path.basename(outputPath, '.mp4')}_timeline`);
    const visualPath = outputPath.replace('.mp4', '_visual.mp4');
    try {
      const narrationDuration = await this.isUsableAudioFile(audioPath)
        ? await probeMediaDuration(audioPath)
        : this.calculateScriptDuration(script);
      if (!Number.isFinite(narrationDuration) || narrationDuration <= 0) {
        throw new Error('A duração real da narração não pôde ser medida.');
      }

      await this.renderMediaTimeline(mediaAssets, narrationDuration, visualPath, workDir);
      await this.addAudioToVideo(visualPath, audioPath, outputPath, narrationDuration);

      const finalDuration = await probeMediaDuration(outputPath);
      if (Math.abs(finalDuration - narrationDuration) > 1.25) {
        throw new Error(`O vídeo final ficou com ${finalDuration.toFixed(1)} segundos, mas a narração possui ${narrationDuration.toFixed(1)} segundos.`);
      }
      return outputPath;
    } finally {
      await this.cleanupDirectory(workDir);
      await fs.unlink(visualPath).catch(() => {});
    }
  }

  async generateReplicateVideo(script, visualAssets, audioPath, outputPath) {
    const output = await this.replicate.run(
      "wan-video/wan-2.7-i2v",
      {
        input: {
          image: visualAssets[0],
          prompt: script.title || "smooth cinematic motion",
          duration: 5,
          resolution: "720p"
        }
      }
    );

    // Download the generated video
    if (output && output.length > 0) {
      await this.downloadVideo(output[0], outputPath);
      
      // Add audio track
      await this.addAudioToVideo(outputPath, audioPath, outputPath);
    }

    return outputPath;
  }

  async filterMediaAssets(visualAssets = []) {
    const supported = new Set(['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.m4v', '.webm']);
    const media = [];
    for (const asset of visualAssets) {
      const assetPath = typeof asset === 'string' ? asset : asset?.path;
      if (!assetPath || !supported.has(path.extname(assetPath).toLowerCase())) continue;
      try {
        const stats = await fs.stat(assetPath);
        if (stats.isFile() && stats.size > 0) media.push(assetPath);
      } catch (error) {
        // Ignore media removed by an interrupted attempt
      }
    }
    return media;
  }

  async renderMediaTimeline(mediaAssets, totalDuration, videoPath, workDir) {
    await fs.mkdir(workDir, { recursive: true });
    const segmentDuration = totalDuration / mediaAssets.length;
    const segments = [];

    for (let index = 0; index < mediaAssets.length; index += 1) {
      const asset = mediaAssets[index];
      const segmentPath = path.join(workDir, `segment_${String(index).padStart(4, '0')}.mp4`);
      const extension = path.extname(asset).toLowerCase();
      const isVideo = ['.mp4', '.mov', '.m4v', '.webm'].includes(extension);
      const commonOutput = [
        '-t', segmentDuration.toFixed(3),
        '-an',
        '-c:v', 'libx264',
        '-preset', process.env.VIDEO_FFMPEG_PRESET || 'veryfast',
        '-crf', String(Number(process.env.VIDEO_CRF) || 22),
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-movflags', '+faststart',
        segmentPath
      ];

      if (isVideo) {
        await runFFmpeg([
          '-y', '-stream_loop', '-1', '-i', asset,
          '-vf', 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30,format=yuv420p',
          ...commonOutput
        ]);
      } else {
        const frames = Math.max(1, Math.ceil(segmentDuration * 30));
        await runFFmpeg([
          '-y', '-loop', '1', '-i', asset,
          '-vf', `scale=2200:1238:force_original_aspect_ratio=increase,crop=2200:1238,zoompan=z='min(zoom+0.00025,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,trim=duration=${segmentDuration.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p`,
          '-frames:v', String(frames),
          ...commonOutput
        ]);
      }
      segments.push(segmentPath);
    }

    const listPath = path.join(workDir, 'segments.txt');
    const list = segments.map(segment => `file '${segment.replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(listPath, list);
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', '-movflags', '+faststart', videoPath]);
    return videoPath;
  }

  async generateSlideshowVideo(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Creating slideshow video...');

    if (!(await checkFFmpeg())) {
      throw new Error(ffmpegInstallHint());
    }

    const slidesDir = path.join(path.dirname(outputPath), 'slides');

    try {
      const imageAssets = await this.filterImageAssets(visualAssets);
      const stills = await this.createSlideStills(script, imageAssets, slidesDir);

      const videoPath = outputPath.replace('.mp4', '_visual.mp4');
      const duration = this.calculateScriptDuration(script);
      await this.renderSlidesToVideo(stills, duration, videoPath);

      // Add audio
      await this.addAudioToVideo(videoPath, audioPath, outputPath);

      return outputPath;
    } finally {
      await this.cleanupDirectory(slidesDir);
    }
  }

  async createSlideStills(script, imageAssets, slidesDir) {
    if (!imageAssets.length) throw new Error('Nenhuma imagem válida foi encontrada para montar o vídeo.');
    await fs.mkdir(slidesDir, { recursive: true });
    const texts = this.getSlideTexts(script);
    const stills = [];

    for (let index = 0; index < imageAssets.length; index += 1) {
      const lines = this.wrapSlideText(texts[index % texts.length]);
      const firstY = 540 - ((lines.length - 1) * 42);
      const textRows = lines.map((line, lineIndex) => `<text x="960" y="${firstY + (lineIndex * 84)}" text-anchor="middle" font-family="Arial, sans-serif" font-size="58" font-weight="700" fill="#ffffff" stroke="#000000" stroke-width="2" paint-order="stroke">${this.escapeXml(line)}</text>`).join('');
      const overlay = Buffer.from(`<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><rect width="1920" height="1080" fill="rgba(0,0,0,0.28)"/><rect x="170" y="${firstY - 75}" width="1580" height="${lines.length * 84 + 70}" rx="34" fill="rgba(0,0,0,0.48)"/>${textRows}</svg>`);
      const stillPath = path.join(slidesDir, `slide_${String(index).padStart(3, '0')}.png`);
      await sharp(imageAssets[index])
        .resize(1920, 1080, { fit: 'cover', position: 'centre' })
        .modulate({ brightness: 0.82, saturation: 1.05 })
        .composite([{ input: overlay }])
        .png({ compressionLevel: 6 })
        .toFile(stillPath);
      stills.push(stillPath);
    }
    return stills;
  }

  getSlideTexts(script = {}) {
    const texts = [script.title, script.hook?.text];
    for (const section of script.mainContent?.sections || []) {
      texts.push(section.title || section.heading || section.content);
    }
    texts.push(script.conclusion?.finalThought);
    return texts.map(value => String(value || '').trim()).filter(Boolean).length
      ? texts.map(value => String(value || '').trim()).filter(Boolean)
      : ['Conteúdo em produção'];
  }

  wrapSlideText(value, maxCharacters = 38, maxLines = 3) {
    const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxCharacters && current && lines.length < maxLines - 1) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines.slice(0, maxLines);
  }

  escapeXml(value) {
    return String(value || '').replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
  }

  async renderSlidesToVideo(stills, totalDuration, videoPath) {
    if (stills.length === 0) {
      throw new Error('No slides to render');
    }

    const fade = 0.5;
    const perSlide = Math.max(2, totalDuration / stills.length);

    const args = ['-y'];
    for (const still of stills) {
      args.push('-loop', '1', '-t', perSlide.toFixed(2), '-framerate', '30', '-i', still);
    }

    if (stills.length === 1) {
      args.push('-vf', 'format=yuv420p', '-c:v', 'libx264', videoPath);
      await runFFmpeg(args);
      return videoPath;
    }

    // Chain crossfades: transition k starts fade seconds before slide k ends
    const filters = [];
    let prev = '[0:v]';
    for (let i = 1; i < stills.length; i++) {
      const out = `[v${i}]`;
      const offset = (i * (perSlide - fade)).toFixed(2);
      filters.push(`${prev}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${offset}${out}`);
      prev = out;
    }
    filters.push(`${prev}format=yuv420p[vfinal]`);

    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[vfinal]',
      '-c:v', 'libx264',
      '-r', '30',
      videoPath
    );

    await runFFmpeg(args);
    return videoPath;
  }

  async filterImageAssets(visualAssets = []) {
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const images = [];

    for (const asset of visualAssets) {
      if (typeof asset !== 'string' || !imageExtensions.has(path.extname(asset).toLowerCase())) {
        continue;
      }

      try {
        await fs.access(asset);
        images.push(asset);
      } catch (error) {
        // Skip missing files
      }
    }

    return images;
  }

  createSlideshowHTML(script, visualAssets) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body {
            margin: 0;
            padding: 0;
            width: 1920px;
            height: 1080px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            font-family: 'Arial', sans-serif;
            overflow: hidden;
        }
        
        .slide {
            position: absolute;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 2s ease-in-out;
        }
        
        .slide.active {
            opacity: 1;
        }
        
        .content {
            text-align: center;
            color: white;
            max-width: 80%;
        }
        
        h1 {
            font-size: 72px;
            margin-bottom: 30px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        h2 {
            font-size: 48px;
            margin-bottom: 20px;
            text-shadow: 2px 2px 4px rgba(0,0,0,0.5);
        }
        
        p {
            font-size: 36px;
            line-height: 1.4;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.5);
        }
        
        .background-image {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            object-fit: cover;
            opacity: 0.3;
            z-index: -1;
        }
        
        .particles {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            z-index: -1;
        }
        
        .particle {
            position: absolute;
            background: rgba(255,255,255,0.8);
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-20px); }
        }
    </style>
</head>
<body>
    <div class="particles"></div>
    
    <!-- Title Slide -->
    <div class="slide active">
        ${visualAssets[0] ? `<img class="background-image" src="${visualAssets[0]}" />` : ''}
        <div class="content">
            <h1>${script.title}</h1>
            <p>Ethereal Dreamscript</p>
        </div>
    </div>
    
    ${this.generateContentSlides(script, visualAssets).join('')}
    
    <!-- Subscribe Slide -->
    <div class="slide">
        <div class="content">
            <h2>✨ Subscribe for More Stories ✨</h2>
            <p>New content daily at 2:00 PM</p>
        </div>
    </div>
    
    <script>
        // Create floating particles
        function createParticles() {
            const container = document.querySelector('.particles');
            for (let i = 0; i < 20; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.width = (Math.random() * 4 + 2) + 'px';
                particle.style.height = particle.style.width;
                particle.style.animationDelay = Math.random() * 6 + 's';
                container.appendChild(particle);
            }
        }
        
        let currentSlide = 0;
        const slides = document.querySelectorAll('.slide');
        
        function advanceAnimation() {
            slides[currentSlide].classList.remove('active');
            currentSlide = (currentSlide + 1) % slides.length;
            slides[currentSlide].classList.add('active');
        }
        
        window.advanceAnimation = advanceAnimation;
        createParticles();
    </script>
</body>
</html>`;
  }

  generateContentSlides(script, visualAssets) {
    const slides = [];
    
    if (Array.isArray(script.mainContent?.sections)) {
      script.mainContent.sections.forEach((section, index) => {
        const assetIndex = Math.min(index + 1, visualAssets.length - 1);
        
        slides.push(`
        <div class="slide">
            ${visualAssets[assetIndex] ? `<img class="background-image" src="${visualAssets[assetIndex]}" />` : ''}
            <div class="content">
                <h2>${section.title}</h2>
                ${this.formatSectionContent(section)}
            </div>
        </div>`);
      });
    }
    
    return slides;
  }

  formatSectionContent(section) {
    if (section.items && Array.isArray(section.items)) {
      return section.items.slice(0, 3).map(item => 
        `<p>${item.number}. ${item.title}</p>`
      ).join('');
    }
    
    if (section.steps && Array.isArray(section.steps)) {
      return section.steps.slice(0, 3).map(step => 
        `<p>${step.title}</p>`
      ).join('');
    }
    
    if (typeof section.content === 'string') {
      return `<p>${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}</p>`;
    }
    
    return '<p>Content coming soon...</p>';
  }

  calculateScriptDuration(script) {
    // Estimate duration based on word count (average 150 words per minute)
    let totalWords = 0;
    
    if (script.hook) totalWords += script.hook.text.split(' ').length;
    if (script.introduction) {
      totalWords += (script.introduction.greeting || '').split(' ').length;
      totalWords += (script.introduction.topicIntro || '').split(' ').length;
    }
    
    if (Array.isArray(script.mainContent?.sections)) {
      script.mainContent.sections.forEach(section => {
        if (typeof section.content === 'string') {
          totalWords += section.content.split(' ').length;
        }
        if (Array.isArray(section.content)) {
          totalWords += section.content
            .filter(line => typeof line === 'string' && !line.startsWith('['))
            .join(' ')
            .split(/\s+/)
            .filter(Boolean).length;
        }
        if (Array.isArray(section.items)) {
          section.items.forEach(item => {
            totalWords += (item.title + ' ' + item.description).split(' ').length;
          });
        }
        if (Array.isArray(section.steps)) {
          section.steps.forEach(step => {
            totalWords += (step.title + ' ' + step.description).split(' ').length;
          });
        }
      });
    }
    
    if (typeof script.conclusion?.finalThought === 'string') {
      totalWords += script.conclusion.finalThought.split(' ').length;
    }
    
    // Convert to duration (150 words per minute)
    return Math.max(30, Math.ceil((totalWords / 150) * 60));
  }

  async addAudioToVideo(videoPath, audioPath, outputPath, targetDuration = null) {
    const hasRealAudio = await this.isUsableAudioFile(audioPath);

    if (!hasRealAudio) {
      this.logger.warn('No narration audio available , producing silent video. Configure OpenAI, ElevenLabs, or Azure Speech for narration.');
      if (videoPath !== outputPath) {
        await fs.copyFile(videoPath, outputPath);
      }
      return outputPath;
    }

    // FFmpeg cannot write to its own input, so mux to a temp file when paths collide
    const muxPath = outputPath === videoPath
      ? outputPath.replace(/\.mp4$/i, '_muxed.mp4')
      : outputPath;

    const durationArgs = Number.isFinite(targetDuration) && targetDuration > 0
      ? ['-t', targetDuration.toFixed(3)]
      : ['-shortest'];
    await runFFmpeg(['-y', '-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', ...durationArgs, '-movflags', '+faststart', muxPath]);

    if (muxPath !== outputPath) {
      await fs.rename(muxPath, outputPath);
    }

    this.logger.info('Audio added to video successfully');
    return outputPath;
  }

  async isUsableAudioFile(audioPath) {
    if (typeof audioPath !== 'string' || audioPath.endsWith('.info')) {
      return false;
    }

    try {
      const stats = await fs.stat(audioPath);
      return stats.isFile() && stats.size > 0;
    } catch (error) {
      return false;
    }
  }

  async downloadVideo(url, outputPath) {
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = require('fs').createWriteStream(outputPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  }

  async cleanupDirectory(dirPath) {
    try {
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        await fs.unlink(path.join(dirPath, file));
      }
      await fs.rmdir(dirPath);
    } catch (error) {
      this.logger.warn('Cleanup failed:', error.message);
    }
  }

  async generateThumbnail(script, style = "ethereal") {
    this.logger.info('Generating custom thumbnail...');

    try {
      if (!this.hasConfiguredImageProvider()) {
        return await this.simulateThumbnailGeneration(script, style);
      }

      const prompt = `YouTube thumbnail for "${script.title}", ${style} style, eye-catching, high contrast text, professional design, clickable, engaging`;
      const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_${Date.now()}.png`);

      await this.generateImage(prompt, thumbnailPath);

      return {
        path: thumbnailPath,
        dimensions: { width: 1536, height: 1024 },
        fileSize: await this.getFileSize(thumbnailPath)
      };
    } catch (error) {
      this.logger.error('Thumbnail generation failed:', error);
      throw this.wrapImageError(error, this.formatImageGenerationError(error));
    }
  }

  async getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  // Simulation methods for when APIs are not available
  async simulateTTSGeneration(text, outputPath) {
    this.logger.info('Simulating TTS generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI TTS audio would be generated here',
      text: text.substring(0, 100) + '...',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateVisualAssets(prompt, style, count) {
    this.logger.info(`Simulating ${count} visual assets...`);
    
    const paths = [];
    for (let i = 0; i < count; i++) {
      const assetPath = path.join(__dirname, '..', 'data', 'assets', `visual_sim_${Date.now()}_${i}.info`);
      
      await fs.writeFile(assetPath, JSON.stringify({
        message: 'AI visual asset would be generated here',
        prompt: prompt,
        style: style,
        timestamp: new Date().toISOString()
      }, null, 2));
      
      paths.push(assetPath);
    }
    
    return paths;
  }

  async simulateVideoGeneration(script, visualAssets, audioPath, outputPath) {
    this.logger.info('Simulating video generation...');
    
    const infoPath = outputPath + '.info';
    await fs.writeFile(infoPath, JSON.stringify({
      message: 'AI video would be generated here',
      script: script.title,
      visualAssets: visualAssets.length,
      audioPath: audioPath,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return infoPath;
  }

  async simulateThumbnailGeneration(script, style) {
    this.logger.info('Simulating thumbnail generation...');
    
    const thumbnailPath = path.join(__dirname, '..', 'uploads', 'thumbnails', `thumbnail_sim_${Date.now()}.info`);
    await fs.mkdir(path.dirname(thumbnailPath), { recursive: true });
    
    await fs.writeFile(thumbnailPath, JSON.stringify({
      message: 'AI thumbnail would be generated here',
      title: script.title,
      style: style,
      timestamp: new Date().toISOString()
    }, null, 2));
    
    return {
      path: thumbnailPath,
      dimensions: { width: 1792, height: 1024 },
      fileSize: 1024,
      simulated: true
    };
  }
}

module.exports = { AIVideoGenerator };
