const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { R2Storage } = require('../utils/r2-storage');
const { runFFmpeg } = require('../utils/ffmpeg');

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials);
    this.storage = new R2Storage(this.logger);
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    let productionData;
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy, script, thumbnail, seo, options = {}, onProgress = () => {} } = contentData;
      
      // Create production entry
      const productionId = contentData.productionId || this.generateProductionId();
      
      productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail, script),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        settings: options,
        createdAt: new Date().toISOString()
      };
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);

      if (this.storage.enabled && productionData.assets.thumbnail?.path && await fs.access(productionData.assets.thumbnail.path).then(() => true).catch(() => false)) {
        const uploadedThumbnail = await this.storage.upload(productionData.assets.thumbnail.path, `productions/${productionId}/thumbnail.png`, 'image/png');
        productionData.assets.thumbnail = { ...productionData.assets.thumbnail, ...uploadedThumbnail };
        onProgress('thumbnail-storage', 64, 'Miniatura enviada para o Cloudflare R2', { objectKey: uploadedThumbnail.key, asset: 'thumbnail' });
      }
      
      // Generate video content
      onProgress('visuals', 66, 'Criando as cenas do vídeo');
      await this.generateVideoContent(productionData, onProgress);
      
      // Generate audio narration
      if (options.narration !== false) {
        onProgress('narration', 75, 'Gerando a narração');
        await this.generateAudioNarration(productionData, onProgress);
      }
      
      // Generate captions
      if (options.captions !== false) {
        onProgress('captions', 82, 'Sincronizando as legendas');
        await this.generateCaptions(productionData, onProgress);
      }
      
      // Final assembly
      onProgress('assembly', 88, 'Montando o vídeo final');
      await this.assembleVideo(productionData);

      const simulated = Boolean(productionData.assets.finalVideo?.simulated);
      if (simulated) {
        productionData.status = 'simulated';
        throw new Error('A produção não gerou um vídeo válido. Os arquivos incompletos não foram enviados.');
      } else {
        onProgress('storage', 92, 'Enviando o vídeo para o Cloudflare');
        await this.storage.uploadProductionAssets(productionData, (upload) => {
          if (upload.phase !== 'completed') return;
          const progress = 92 + Math.round((upload.completed / Math.max(1, upload.total)) * 7);
          onProgress('storage', progress, `${upload.filename} enviado para o Cloudflare R2`, { objectKey: upload.key, asset: upload.name, completed: upload.completed, total: upload.total });
        });
        productionData.status = 'ready';
        productionData.timeline.readyForUpload = new Date().toISOString();
      }

      await this.db.updateProductionData(productionData);

      this.logger.info(`Content processing complete: ${productionId} (status: ${productionData.status})`);
      return productionData;
    } catch (error) {
      if (productionData?.id) {
        productionData.status = 'failed';
        productionData.timeline.failedAt = new Date().toISOString();
        productionData.timeline.failureMessage = error.message;
        await this.db.updateProductionData(productionData).catch(() => {});
      }
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: Array.isArray(script.mainContent?.sections) ? script.mainContent.sections.length : 0
    };
  }

  formatScriptForTTS(script) {
    let ttsText = '';
    
    // Add hook
    if (script.hook) {
      ttsText += `${script.hook.text}\n\n`;
    }
    
    // Add introduction
    if (script.introduction) {
      ttsText += `${script.introduction.greeting}\n`;
      ttsText += `${script.introduction.topicIntro}\n`;
      ttsText += `${script.introduction.valueProposition}\n`;
      ttsText += `${script.introduction.credibility}\n\n`;
    }
    
    // Add main content
    if (Array.isArray(script.mainContent?.sections)) {
      script.mainContent.sections.forEach((section, index) => {
        ttsText += `Section ${index + 1}: ${section.title}\n`;
        
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            if (typeof line === 'string' && !line.startsWith('[')) {
              ttsText += `${line}\n`;
            }
          });
        } else if (Array.isArray(section.steps)) {
          section.steps.forEach(step => {
            ttsText += `${step.title}. ${step.description}\n`;
            ttsText += `${step.tip}\n`;
          });
        } else if (Array.isArray(section.items)) {
          section.items.forEach(item => {
            ttsText += `Number ${item.number}: ${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        
        ttsText += '\n';
      });
    }
    
    // Add conclusion
    if (script.conclusion) {
      (Array.isArray(script.conclusion.recap) ? script.conclusion.recap : []).forEach(line => {
        if (typeof line === 'string') {
          ttsText += `${line}\n`;
        }
      });
      ttsText += `\n${script.conclusion.finalThought}\n\n`;
    }
    
    // Add CTA
    if (script.callToAction) {
      ttsText += `${script.callToAction.subscribe}\n`;
      ttsText += `${script.callToAction.like}\n`;
      ttsText += `${script.callToAction.comment}\n`;
    }
    
    return ttsText;
  }

  async processThumbnail(thumbnail, script) {
    try {
      // Try to generate AI thumbnail first
      const thumbnailScript = thumbnail.script || script || { title: thumbnail.title || 'Untitled Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(thumbnailScript, 'ethereal');
      
      return {
        path: aiThumbnail.path,
        originalPath: thumbnail.path,
        dimensions: aiThumbnail.dimensions,
        fileSize: aiThumbnail.fileSize,
        generatedWith: 'AI'
      };
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
      
      // Fallback to original processing
      const productionThumbnailPath = path.join(
        __dirname, '..', 'data', 'assets', 
        `thumbnail_${Date.now()}.jpg`
      );
      
      if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
        const originalBuffer = await fs.readFile(thumbnail.path);
        await fs.writeFile(productionThumbnailPath, originalBuffer);
      } else {
        // Create placeholder
        await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
      }
      
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0
      };
    }
  }

  calculatePublishTime(strategy) {
    // Use strategy's recommended time or calculate optimal time
    if (strategy.bestPublishTime) {
      return strategy.bestPublishTime;
    }
    
    // Default: next optimal publishing window
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50; // Base priority
    
    // Adjust based on estimated views
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    
    // Adjust based on trend score
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) {
      priority += 10;
    }
    
    // Time sensitivity
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    
    return Math.min(100, priority);
  }

  async generateVideoContent(productionData, onProgress = () => {}) {
    this.logger.info('Generating AI video content...');
    
    try {
      const { strategy, script } = productionData;
      
      // Generate visual assets using DALL-E
      const requestedScenes = Math.min(180, Math.max(3, Number(productionData.settings?.sceneCount) || 8));
      const basePrompts = this.createVisualPromptsFromScript(script);
      const visualPrompts = Array.from({ length: requestedScenes }, (_, index) => `${basePrompts[index % basePrompts.length]}, cena ${index + 1} de ${requestedScenes}, composição visual distinta`);
      const visualAssets = [];
      const uploadedVisuals = [];
      
      for (let index = 0; index < visualPrompts.length; index += 1) {
        const prompt = visualPrompts[index];
        const assets = await this.aiVideoGenerator.generateVisualAssets(prompt, 'ethereal', 1);
        visualAssets.push(...assets);
        let uploaded = null;
        if (this.storage.enabled && assets[0]) {
          uploaded = await this.storage.upload(assets[0], `productions/${productionData.id}/scenes/scene-${String(index + 1).padStart(4, '0')}.png`, 'image/png');
          uploadedVisuals.push(uploaded);
        }
        const completed = index + 1;
        const progress = 66 + Math.floor((completed / requestedScenes) * 8);
        onProgress('visuals', progress, `Cena ${completed} de ${requestedScenes} criada${uploaded ? ' e enviada para o R2' : ''}`, { asset: 'scene', completed, total: requestedScenes, objectKey: uploaded?.key || null });
      }
      
      productionData.assets.video = {
        visualAssets: visualAssets,
        uploadedVisuals,
        duration: productionData.estimatedDuration,
        format: 'mp4',
        resolution: '1920x1080',
        fps: 30,
        generatedWith: 'AI'
      };
      
      productionData.timeline.videoGenerated = new Date().toISOString();
      
      return visualAssets;
    } catch (error) {
      this.logger.error('AI video content generation failed:', error);
      throw error;
    }
  }

  async createVideoElements(productionData) {
    const { script } = productionData;
    const elements = [];
    
    // Title slide
    elements.push({
      type: 'title_slide',
      content: script.title,
      duration: 3,
      style: 'modern',
      animation: 'fade_in'
    });
    
    // Content sections
    if (Array.isArray(script.mainContent?.sections)) {
      script.mainContent.sections.forEach((section, index) => {
        // Section title
        elements.push({
          type: 'section_title',
          content: section.title,
          duration: 2,
          style: 'minimal',
          animation: 'slide_in'
        });
        
        // Content visuals
        if (section.type === 'list_items' && Array.isArray(section.items)) {
          section.items.forEach(item => {
            elements.push({
              type: 'list_item',
              content: {
                number: item.number,
                title: item.title,
                description: item.description
              },
              duration: 15,
              style: 'countdown',
              animation: 'zoom_in'
            });
          });
        } else if (section.type === 'solution_steps' && Array.isArray(section.steps)) {
          section.steps.forEach(step => {
            elements.push({
              type: 'step',
              content: {
                number: step.number,
                title: step.title,
                description: step.description
              },
              duration: 20,
              style: 'tutorial',
              animation: 'step_by_step'
            });
          });
        } else {
          // Generic content slide
          elements.push({
            type: 'content_slide',
            content: section.title,
            duration: section.duration || 30,
            style: 'informative',
            animation: 'fade_transition'
          });
        }
      });
    }
    
    // Conclusion slide
    elements.push({
      type: 'conclusion',
      content: 'Key Takeaways',
      duration: 5,
      style: 'summary',
      animation: 'reveal'
    });
    
    // Subscribe reminder
    elements.push({
      type: 'subscribe_reminder',
      content: 'Subscribe for More!',
      duration: 3,
      style: 'call_to_action',
      animation: 'bounce'
    });
    
    return elements;
  }

  async generateAudioNarration(productionData, onProgress = () => {}) {
    this.logger.info('Generating AI audio narration...');
    
    try {
      const { script } = productionData;
      const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
      
      // Read the TTS script
      const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
      
      // Generate audio using AI TTS
      await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath, ({ completed, total }) => {
        const progress = 75 + Math.floor((completed / Math.max(1, total)) * 6);
        onProgress('narration', progress, `Narração ${completed} de ${total} processada`, { asset: 'audio', completed, total });
      });
      
      productionData.assets.audio = {
        path: audioPath,
        duration: productionData.estimatedDuration,
        format: 'mp3',
        generatedWith: 'AI',
        quality: 'high'
      };
      
      productionData.timeline.audioGenerated = new Date().toISOString();

      if (this.storage.enabled) {
        const uploaded = await this.storage.upload(audioPath, `productions/${productionData.id}/narration.mp3`, 'audio/mpeg');
        productionData.assets.audio = { ...productionData.assets.audio, ...uploaded };
        onProgress('narration-storage', 81, 'Narração enviada para o Cloudflare R2', { asset: 'audio', objectKey: uploaded.key });
      }
      
      return audioPath;
    } catch (error) {
      this.logger.error('AI audio generation failed:', error);
      throw error;
    }
  }

  async generateCaptions(productionData, onProgress = () => {}) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    
    // Generate SRT captions based on script timing
    const captions = await this.createSRTCaptions(productionData);
    
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });
    await fs.writeFile(captionsPath, captions);
    
    productionData.assets.captions = {
      path: captionsPath,
      format: 'srt',
      language: 'en',
      autoGenerated: true
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();

    if (this.storage.enabled) {
      const uploaded = await this.storage.upload(captionsPath, `productions/${productionData.id}/captions.srt`, 'application/x-subrip');
      productionData.assets.captions = { ...productionData.assets.captions, ...uploaded };
      onProgress('captions-storage', 84, 'Legendas enviadas para o Cloudflare R2', { asset: 'captions', objectKey: uploaded.key });
    }
    
    return captionsPath;
  }

  async createSRTCaptions(productionData) {
    const { script } = productionData;
    let srt = '';
    let captionIndex = 1;
    let currentTime = 0;
    
    // Helper function to format time for SRT
    const formatSRTTime = (seconds) => {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
    };
    
    // Process script sections for captions
    const processText = (text, startTime, duration) => {
      const words = text.split(' ');
      const wordsPerCaption = 8; // Optimal words per caption
      
      for (let i = 0; i < words.length; i += wordsPerCaption) {
        const captionWords = words.slice(i, i + wordsPerCaption);
        const captionDuration = (duration / Math.ceil(words.length / wordsPerCaption));
        const captionStartTime = startTime + (i / words.length) * duration;
        const captionEndTime = captionStartTime + captionDuration;
        
        srt += `${captionIndex}\n`;
        srt += `${formatSRTTime(captionStartTime)} --> ${formatSRTTime(captionEndTime)}\n`;
        srt += `${captionWords.join(' ')}\n\n`;
        
        captionIndex++;
      }
    };
    
    // Hook
    if (script.hook && script.hook.text) {
      processText(script.hook.text, currentTime, 5);
      currentTime += 5;
    }
    
    // Introduction
    if (script.introduction) {
      const introText = `${script.introduction.greeting} ${script.introduction.topicIntro} ${script.introduction.valueProposition}`;
      processText(introText, currentTime, 15);
      currentTime += 15;
    }
    
    // Main content
    if (Array.isArray(script.mainContent?.sections)) {
      script.mainContent.sections.forEach(section => {
        let sectionText = '';
        
        if (Array.isArray(section.content)) {
          sectionText = section.content.filter(line => 
            typeof line === 'string' && !line.startsWith('[')
          ).join(' ');
        } else if (Array.isArray(section.steps)) {
          sectionText = section.steps.map(step => 
            `${step.title}. ${step.description}`
          ).join(' ');
        } else if (Array.isArray(section.items)) {
          sectionText = section.items.map(item => 
            `Number ${item.number}: ${item.title}. ${item.description}`
          ).join(' ');
        } else if (typeof section.content === 'string') {
          sectionText = section.content;
        }
        
        if (sectionText) {
          processText(sectionText, currentTime, section.duration || 60);
          currentTime += section.duration || 60;
        }
      });
    }
    
    // Conclusion
    if (script.conclusion) {
      const conclusionText = `${Array.isArray(script.conclusion.recap) ? script.conclusion.recap.join(' ') : ''} ${script.conclusion.finalThought || ''}`.trim();
      processText(conclusionText, currentTime, 30);
      currentTime += 30;
    }
    
    return srt;
  }

  async assembleVideo(productionData) {
    this.logger.info('Assembling final AI-generated video...');
    
    try {
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);

      // Use AI Video Generator to create the final video
      const producedPath = await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video?.visualAssets || [],
        productionData.assets.audio.path,
        finalVideoPath
      );

      // The generator falls back to a placeholder .info file when it cannot render
      if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
        return await this.simulateVideoAssembly(productionData);
      }

      // Get file stats
      const stats = await fs.stat(finalVideoPath);
      if (stats.size < 10000) throw new Error('O arquivo final é pequeno demais para ser um vídeo válido.');
      await runFFmpeg(['-v', 'error', '-i', finalVideoPath, '-f', 'null', '-']);
      
      productionData.assets.finalVideo = {
        path: finalVideoPath,
        fileSize: stats.size,
        duration: productionData.estimatedDuration,
        generatedWith: 'AI',
        resolution: '1920x1080',
        format: 'mp4'
      };
      
      this.logger.info('AI video assembly complete');
      return finalVideoPath;
    } catch (error) {
      this.logger.error('AI video assembly failed:', error);
      throw error;
    }
  }

  async getPipelineStatus() {
    return this.pipeline.map(item => ({
      id: item.id,
      title: item.script?.title || 'Untitled',
      status: item.status,
      priority: item.priority,
      scheduledPublishTime: item.scheduledPublishTime,
      progress: this.calculateProgress(item)
    }));
  }

  calculateProgress(productionData) {
    const milestones = [
      'scriptReady',
      'thumbnailReady',
      'audioGenerated',
      'videoGenerated',
      'captionsGenerated',
      'readyForUpload'
    ];
    
    const completed = milestones.filter(milestone => 
      productionData.timeline[milestone] !== null
    ).length;
    
    return Math.round((completed / milestones.length) * 100);
  }

  async getNextReadyContent() {
    const ready = this.pipeline
      .filter(item => item.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
    
    return ready[0] || null;
  }

  // Helper method to create visual prompts from script content
  createVisualPromptsFromScript(script) {
    const prompts = [];
    
    // Title prompt
    prompts.push(`${script.title}, ethereal storytelling, mystical background`);
    
    // Content-based prompts
    if (Array.isArray(script.mainContent?.sections)) {
      script.mainContent.sections.forEach(section => {
        if (section.title) {
          prompts.push(`${section.title}, ethereal dreamscape, creative visualization`);
        }
      });
    }
    
    // Ensure we have at least 3 prompts
    while (prompts.length < 3) {
      prompts.push('ethereal dreamscape, mystical storytelling, creative visualization');
    }
    
    return prompts;
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
      duration: productionData.estimatedDuration,
      format: 'mp3',
      simulated: true
    };
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };
