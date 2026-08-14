const IORedis = require('ioredis');
const { Queue, Worker } = require('bullmq');

class ProductionQueue {
  constructor({ processJob, onProgress, logger }) {
    this.processJob = processJob;
    this.onProgress = onProgress;
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
      this.onProgress(jobId, 'processing', 5, 'Produção iniciada pelo worker');
      const result = await this.processJob(options, jobId);
      this.onProgress(jobId, 'completed', 100, 'Conteúdo pronto', result);
      return result;
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
      this.onProgress(
        job.data.jobId,
        finalAttempt ? 'failed' : 'retrying',
        finalAttempt ? 100 : 5,
        finalAttempt ? 'A produção falhou após novas tentativas.' : 'A produção será retomada automaticamente.'
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
        try {
          const result = await this.processJob(options, jobId);
          this.onProgress(jobId, 'completed', 100, 'Conteúdo pronto', result);
        } catch (error) {
          this.onProgress(jobId, 'failed', 100, 'Não foi possível concluir a produção.');
          this.logger.error(`Local production job ${jobId} failed:`, error);
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
    return { connected: this.enabled, provider: this.enabled ? 'Redis com BullMQ' : 'Fila local' };
  }
}

module.exports = { ProductionQueue };
