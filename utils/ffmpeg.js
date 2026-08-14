const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

let cachedPath = null;

/**
 * Resolve the FFmpeg binary to use, in order of preference:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled binary from the optional ffmpeg-static package
 * 3. `ffmpeg` on the system PATH
 */
function getFFmpegPath() {
  if (cachedPath) {
    return cachedPath;
  }

  if (process.env.FFMPEG_PATH) {
    cachedPath = process.env.FFMPEG_PATH;
    return cachedPath;
  }

  try {
    cachedPath = require('ffmpeg-static');
  } catch (error) {
    cachedPath = null;
  }

  cachedPath = cachedPath || 'ffmpeg';
  return cachedPath;
}

async function checkFFmpeg() {
  try {
    await execFileAsync(getFFmpegPath(), ['-version']);
    return true;
  } catch (error) {
    return false;
  }
}

async function runFFmpeg(args) {
  return execFileAsync(getFFmpegPath(), args, { maxBuffer: 32 * 1024 * 1024 });
}

async function probeMediaDuration(filePath) {
  const { stdout } = await execFileAsync(getFFmpegPath(), [
    '-v', 'error',
    '-progress', 'pipe:1',
    '-nostats',
    '-i', filePath,
    '-map', '0:a:0?',
    '-map', '0:v:0?',
    '-f', 'null',
    '-'
  ], { maxBuffer: 32 * 1024 * 1024 });

  const progressLines = String(stdout || '').split(/\r?\n/);
  const microseconds = progressLines
    .filter(line => line.startsWith('out_time_us='))
    .map(line => Number(line.slice('out_time_us='.length)))
    .filter(Number.isFinite)
    .pop();

  if (Number.isFinite(microseconds) && microseconds > 0) {
    return microseconds / 1000000;
  }

  const timestamp = progressLines
    .filter(line => line.startsWith('out_time='))
    .map(line => line.slice('out_time='.length))
    .pop();
  const match = String(timestamp || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`Não foi possível medir a duração de ${filePath}.`);
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function ffmpegInstallHint() {
  const hints = {
    win32: 'winget install Gyan.FFmpeg (then restart your terminal)',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg (or your distro equivalent)'
  };

  const platformHint = hints[process.platform] || 'https://ffmpeg.org/download.html';
  return `FFmpeg not found. Install it with: ${platformHint} , or run "npm install" again to fetch the bundled ffmpeg-static binary, or set FFMPEG_PATH to your ffmpeg executable.`;
}

module.exports = { getFFmpegPath, checkFFmpeg, runFFmpeg, probeMediaDuration, ffmpegInstallHint };
