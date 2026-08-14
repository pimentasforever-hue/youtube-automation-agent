const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

class R2Storage {
  constructor(logger = null) {
    this.logger = logger;
    this.bucket = process.env.R2_BUCKET;
    this.publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    this.enabled = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && this.bucket);
    if (this.enabled) {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
      });
    }
  }

  async upload(filePath, key, contentType) {
    if (!this.enabled || !filePath) return null;
    await this.validateUploadFile(filePath, contentType);
    const response = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: fs.createReadStream(filePath),
      ContentType: contentType,
      CacheControl: String(contentType || '').startsWith('image/') ? 'no-cache, must-revalidate' : undefined
    }));
    this.logger?.info(`R2 object stored: ${key}`);
    return { key, url: this.publicUrl ? `${this.publicUrl}/${key}` : null, etag: response.ETag || null };
  }

  async validateUploadFile(filePath, contentType) {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`Upload bloqueado: ${path.basename(filePath)} está vazio.`);
    }
    if (!String(contentType || '').startsWith('image/')) return true;

    const handle = await fs.promises.open(filePath, 'r');
    try {
      const header = Buffer.alloc(8);
      await handle.read(header, 0, header.length, 0);
      const isPng = header.equals(Buffer.from('89504e470d0a1a0a', 'hex'));
      const isJpeg = header.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
      if ((contentType === 'image/png' && !isPng) || (contentType === 'image/jpeg' && !isJpeg)) {
        throw new Error(`Upload bloqueado: ${path.basename(filePath)} não contém uma imagem ${contentType === 'image/png' ? 'PNG' : 'JPEG'} válida.`);
      }
    } finally {
      await handle.close();
    }
    return true;
  }

  async writeJSON(key, data) {
    if (!this.enabled) return null;
    const response = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(data, null, 2),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: 'no-store'
    }));
    this.logger?.info(`R2 status stored: ${key}`);
    return { key, url: this.publicUrl ? `${this.publicUrl}/${key}` : null, etag: response.ETag || null };
  }

  async writeManifest(productionId, data) {
    if (!this.enabled || !productionId) return null;
    return this.writeJSON(`productions/${productionId}/manifest.json`, {
      productionId,
      ...data,
      updatedAt: new Date().toISOString()
    });
  }

  async describeProduction(productionId) {
    if (!this.enabled) {
      return { configured: false, connected: false, provider: 'Railway Volume', bucket: null, publicPlayback: false, objects: [] };
    }
    try {
      const response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: productionId ? `productions/${productionId}/` : undefined,
        MaxKeys: 200
      }));
      return {
        configured: true,
        connected: true,
        provider: 'Cloudflare R2',
        bucket: this.bucket,
        publicPlayback: Boolean(this.publicUrl),
        objects: (response.Contents || []).map((object) => ({ key: object.Key, size: Number(object.Size || 0), updatedAt: object.LastModified?.toISOString?.() || null }))
      };
    } catch (error) {
      return { configured: true, connected: false, provider: 'Cloudflare R2', bucket: this.bucket, publicPlayback: Boolean(this.publicUrl), objects: [], error: error.message };
    }
  }

  async uploadProductionAssets(production, onProgress = () => {}) {
    if (!this.enabled) throw new Error('Cloudflare R2 não está configurado. A produção não pode ser marcada como pronta.');
    if (production.assets.finalVideo?.simulated || path.extname(production.assets.finalVideo?.path || '').toLowerCase() !== '.mp4') {
      throw new Error('Upload bloqueado: a produção não possui um arquivo MP4 válido.');
    }
    const prefix = `productions/${production.id}`;
    const tasks = [
      ['finalVideo', production.assets.finalVideo?.path, 'video.mp4', 'video/mp4'],
      ['audio', production.assets.audio?.path, 'narration.mp3', 'audio/mpeg'],
      ['captions', production.assets.captions?.path, 'captions.srt', 'application/x-subrip'],
      ['thumbnail', production.assets.thumbnail?.path || production.assets.thumbnail?.localPath, 'thumbnail.png', 'image/png']
    ];
    let completed = 0;
    const uploadable = tasks.filter(([name, filePath]) => !production.assets[name]?.simulated && filePath && fs.existsSync(filePath));
    for (const [name, filePath, filename, contentType] of uploadable) {
      if (production.assets[name]?.simulated) continue;
      if (!filePath || !fs.existsSync(filePath)) continue;
      onProgress({ phase: 'started', name, filename, completed, total: uploadable.length });
      const uploaded = await this.upload(filePath, path.posix.join(prefix, filename), contentType);
      production.assets[name] = { ...production.assets[name], ...uploaded };
      completed += 1;
      onProgress({ phase: 'completed', name, filename, completed, total: uploadable.length, key: uploaded?.key || null });
    }
    if (!production.assets.finalVideo?.key || !production.assets.finalVideo?.url) {
      throw new Error('O vídeo final não recebeu uma chave e uma URL válidas no Cloudflare R2.');
    }
    return production;
  }

  async deleteProductionAssets(productionId) {
    if (!this.enabled || !productionId) return 0;
    const prefix = `productions/${productionId}/`;
    const listed = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }));
    const objects = (listed.Contents || []).map((object) => ({ Key: object.Key }));
    if (!objects.length) return 0;
    await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: objects, Quiet: true } }));
    return objects.length;
  }
}

module.exports = { R2Storage };
