class GeminiClientPool {
  constructor(keys = [], logger = null) {
    this.logger = logger;
    this.cursor = 0;
    this.timeoutMs = Math.max(15000, Number(process.env.GEMINI_REQUEST_TIMEOUT_MS) || 120000);
    const uniqueKeys = [...new Set(keys.filter(Boolean).map((key) => String(key).trim()).filter(Boolean))];
    if (!uniqueKeys.length) {
      this.clients = [];
      return;
    }
    const { GoogleGenAI } = require('@google/genai');
    this.clients = uniqueKeys.map((apiKey) => new GoogleGenAI({ apiKey, httpOptions: { timeout: this.timeoutMs } }));
  }

  get available() {
    return this.clients.length > 0;
  }

  async run(operation) {
    if (!this.clients.length) throw new Error('No Gemini API key configured');
    let lastError;
    for (let offset = 0; offset < this.clients.length; offset += 1) {
      const index = (this.cursor + offset) % this.clients.length;
      try {
        const result = await operation(this.clients[index]);
        this.cursor = (index + 1) % this.clients.length;
        return result;
      } catch (error) {
        lastError = error;
        const timedOut = /timed out|timeout|aborted/i.test(String(error?.message || ''));
        this.logger?.warn(`Gemini key ${index + 1} ${timedOut ? `did not respond within ${Math.round(this.timeoutMs / 1000)} seconds` : 'is unavailable'}. Trying the next configured key.`);
      }
    }
    throw lastError;
  }
}

function geminiKeys(primaryKey) {
  return [
    primaryKey,
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_BACKUP,
    ...(process.env.GEMINI_API_KEYS || '').split(',')
  ];
}

module.exports = { GeminiClientPool, geminiKeys };
