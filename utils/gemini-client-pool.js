class GeminiClientPool {
  constructor(keys = [], logger = null) {
    this.logger = logger;
    this.cursor = 0;
    const uniqueKeys = [...new Set(keys.filter(Boolean).map((key) => String(key).trim()).filter(Boolean))];
    if (!uniqueKeys.length) {
      this.clients = [];
      return;
    }
    const { GoogleGenAI } = require('@google/genai');
    this.clients = uniqueKeys.map((apiKey) => new GoogleGenAI({ apiKey }));
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
        this.logger?.warn(`Gemini key ${index + 1} unavailable. Trying the next configured key.`);
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
