const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');
const os = require('os');

class ProductionQueue {
  constructor({ processJob, onProgress, onHeartbeat, logger }) {
    this.processJob = processJob;
    this.onProgress = onProgress;
    this.onHeartbeat = onHeartbeat || (() => {});
    this.logger = logger;
    this.enabled = false;
  }

  async initialize() {
    if (!process.env.REDIS_URL) {
      this.logger.warn('Redis is not configured. Production will use the local queue.');
      return false;
    }

    try {
      this.queueConnection = new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: true,
        lazyConnect: true,
        connectTimeout: 5000
      });
      await this.queueConnection.connect();
      await this.queueConnection.ping();

      this.workerConnection = this.queueConnection.duplicate();
      this.queue = new Queue('video-production', { connection: this.queueConnection });
      this.worker = new Worker('video-production', async (job) => {
        const { jobId, options } = job.data;
        const worker = { id: `${process.env.RAILWAY_REPLICA_ID || os.hostname()}:${process.pid}`, status: 'active', attempt: job.attemptsMade + 1, heartbeatAt: new Date().toISOString() };
        const tracking = { contentId: options.productionId || `prod_${jobId}`, retryOf: options.retryOf || null, worker };
        this.onProgress(jobId, 'processing', 5, 'Worker confirmou o início da produção', tracking);
        this.onHeartbeat(jobId, worker);
        const heartbeat = setInterval(() => {
          worker.heartbeatAt = new Date().toISOString();
          this.onHeartbeat(jobId, { ...worker });
        }, 15000);
        heartbeat.unref?.();
        try {
          const result = await this.processJob(options, jobId);
          const completed = (result?.status === 'ready' || result?.status === 'published') && Boolean(result?.storageKey && result?.videoUrl);
          if (!completed) throw new Error('A produção terminou sem um MP4 validado e acessível no Cloudflare R2.');
          worker.status = 'completed';
          worker.heartbeatAt = new Date().toISOString();
          const finalResult = { ...tracking, ...result, worker: { ...worker } };
          this.onProgress(jobId, 'completed', 100, 'Conteúdo pronto e validado', finalResult);
          return finalResult;
        } finally {
          clearInterval(heartbeat);
        }
      }, {
        connection: this.workerConnection,
        concurrency: Math.max(1, Number(process.env.PRODUCTION_CONCURRENCY) || 1),
        lockDuration: 10 * 60 * 1000,
        stalledInterval: 30 * 1000,
        maxStalledCount: 2
      });

      this.worker.on('failed', (job, error) => {
        if (!job) return;
        const finalAttempt = job.attemptsMade >= (job.opts.attempts || 1);
        const options = job.data.options || {};
        this.onProgress(
          job.data.jobId,
          finalAttempt ? 'failed' : 'retrying',
          finalAttempt ? 100 : 5,
          finalAttempt ? `A produção falhou: ${error.message}` : `O worker encontrou um erro e fará outra tentativa: ${error.message}`,
          { contentId: options.productionId || `prod_${job.data.jobId}`, retryOf: options.retryOf || null, worker: { status: finalAttempt ? 'failed' : 'retrying', attempt: job.attemptsMade, heartbeatAt: new Date().toISOString() } }
        );
        this.logger.error(`Production queue job ${job.id} failed:`, error);
      });

      this.enabled = true;
      this.logger.success('Redis production queue connected');
      return true;
    } catch (error) {
      this.logger.warn(`Redis unavailable. Production will use the local queue: ${error.message}`);
      this.queueConnection?.disconnect();
      return false;
    }
  }

  async add(jobId, options) {
    if (!this.enabled) {
      Promise.resolve().then(async () => {
        const worker = { id: `local:${process.pid}`, status: 'active', attempt: 1, heartbeatAt: new Date().toISOString() };
        const tracking = { contentId: options.productionId || `prod_${jobId}`, retryOf: options.retryOf || null, worker };
        this.onProgress(jobId, 'processing', 5, 'Processo local confirmou o início da produção', tracking);
        const heartbeat = setInterval(() => {
          worker.heartbeatAt = new Date().toISOString();
          this.onHeartbeat(jobId, { ...worker });
        }, 15000);
        heartbeat.unref?.();
        try {
          const result = await this.processJob(options, jobId);
          const completed = (result?.status === 'ready' || result?.status === 'published') && Boolean(result?.storageKey && result?.videoUrl);
          if (!completed) throw new Error('A produção terminou sem um MP4 validado e acessível no Cloudflare R2.');
          worker.status = 'completed';
          worker.heartbeatAt = new Date().toISOString();
          this.onProgress(jobId, 'completed', 100, 'Conteúdo pronto e validado', { ...tracking, ...result, worker: { ...worker } });
        } catch (error) {
          worker.status = 'failed';
          worker.heartbeatAt = new Date().toISOString();
          this.onProgress(jobId, 'failed', 100, `Não foi possível concluir a produção: ${error.message}`, { ...tracking, worker: { ...worker } });
          this.logger.error(`Local production job ${jobId} failed:`, error);
        } finally {
          clearInterval(heartbeat);
        }
      });
      return { id: jobId, mode: 'local' };
    }

    const job = await this.queue.add('produce-video', { jobId, options }, {
      jobId,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 24 * 60 * 60, count: 100 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 200 }
    });
    return { id: job.id, mode: 'redis' };
  }

  status() {
    return { connected: this.enabled, provider: this.enabled ? 'Redis com BullMQ' : 'Fila local', worker: this.worker?.isRunning() ? 'active' : this.enabled ? 'starting' : 'local' };
  }

  async inspect(jobId) {
    if (!this.enabled || !this.queue) return null;
    const job = await this.queue.getJob(jobId);
    if (!job) return { state: 'missing', attemptsMade: 0, failedReason: null, result: null };
    return {
      state: await job.getState(),
      attemptsMade: job.attemptsMade,
      failedReason: job.failedReason || null,
      result: job.returnvalue || null
    };
  }
}

module.exports = { ProductionQueue };
