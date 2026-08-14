const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');

class R2Storage {
  constructor() {
    this.bucket = process.env.R2_BUCKET;
    this.publicUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
    this.enabled = Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && this.bucket && this.publicUrl);
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
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: fs.createReadStream(filePath), ContentType: contentType }));
    return { key, url: `${this.publicUrl}/${key}` };
  }

  async uploadProductionAssets(production) {
    if (!this.enabled) return production;
    const prefix = `productions/${production.id}`;
    const tasks = [
      ['finalVideo', production.assets.finalVideo?.path, 'video.mp4', 'video/mp4'],
      ['audio', production.assets.audio?.path, 'narration.mp3', 'audio/mpeg'],
      ['captions', production.assets.captions?.path, 'captions.srt', 'application/x-subrip'],
      ['thumbnail', production.assets.thumbnail?.path || production.assets.thumbnail?.localPath, 'thumbnail.png', 'image/png']
    ];
    for (const [name, filePath, filename, contentType] of tasks) {
      if (!filePath || !fs.existsSync(filePath)) continue;
      const uploaded = await this.upload(filePath, path.posix.join(prefix, filename), contentType);
      production.assets[name] = { ...production.assets[name], ...uploaded };
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
