import { createError, normalizeError } from '../shared/errors.js';
import { noopLogger } from '../shared/logger.js';
import { MEDIA_KINDS, TRANSCODE_STATUS, normalizeTranscodeJob } from './types.js';

/**
 * Contract for transcoder backends (ffmpeg sidecar, GPU node pool, managed
 * service). Implementations receive an already validated job specification.
 */
export class Transcoder {
  async transcode(job, context) {
    throw createError('MEDIA_TRANSCODER_NOT_IMPLEMENTED', 'Transcoder.transcode() must be implemented', { status: 500 });
  }
}

/**
 * Builds the ffmpeg argument vector for a normalized job.
 *
 * Arguments are returned as an array and are only ever passed to `spawn()`
 * without a shell, and every value has already been constrained to an
 * allow-listed enum or a bounded integer, so no caller-supplied string can be
 * interpreted as an option or a shell command.
 */
export function buildFfmpegArgs(job, { inputPath, outputPath }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', inputPath];

  if (job.kind === MEDIA_KINDS.IMAGE) {
    args.push('-frames:v', '1');
    if (job.width && job.height) {
      args.push('-vf', `scale=${job.width}:${job.height}:force_original_aspect_ratio=decrease`);
    }
    if (job.quality) {
      args.push('-q:v', String(Math.max(1, Math.round((100 - job.quality) / 3))));
    }
  }

  if (job.kind === MEDIA_KINDS.VIDEO) {
    if (job.width && job.height) {
      args.push('-vf', `scale=${job.width}:${job.height}:force_original_aspect_ratio=decrease`);
    }
    if (job.videoBitrateKbps) {
      args.push('-b:v', `${job.videoBitrateKbps}k`);
    }
    if (job.audioBitrateKbps) {
      args.push('-b:a', `${job.audioBitrateKbps}k`);
    }
    if (job.format === 'hls') {
      args.push('-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod');
    }
  }

  if (job.kind === MEDIA_KINDS.AUDIO) {
    args.push('-vn');
    if (job.audioBitrateKbps) {
      args.push('-b:a', `${job.audioBitrateKbps}k`);
    }
    if (job.channels) {
      args.push('-ac', String(job.channels));
    }
    if (job.sampleRate) {
      args.push('-ar', String(job.sampleRate));
    }
  }

  return [...args, outputPath];
}

/**
 * Transcoder that shells out to ffmpeg for video, audio, and image jobs.
 *
 * `spawnImpl` is injected so the class is unit testable and so deployments can
 * swap in a sidecar/gRPC backend. The child process is always killed on
 * timeout, on cancellation, and on pod shutdown, and stderr is captured with a
 * hard cap so a chatty encoder cannot grow the worker's heap.
 */
export class FfmpegTranscoder extends Transcoder {
  #spawn;
  #binary;
  #timeoutMs;
  #maxLogBytes;
  #logger;
  #workdir;

  constructor({ spawnImpl, binary = 'ffmpeg', timeoutMs = 900_000, maxLogBytes = 64 * 1024, logger = noopLogger, workdir = '/tmp/transcode' } = {}) {
    super();
    if (typeof spawnImpl !== 'function') {
      throw createError('MEDIA_TRANSCODER_MISCONFIGURED', 'FfmpegTranscoder requires a spawn implementation', { status: 500 });
    }
    this.#spawn = spawnImpl;
    this.#binary = binary;
    this.#timeoutMs = timeoutMs;
    this.#maxLogBytes = maxLogBytes;
    this.#logger = logger;
    this.#workdir = workdir;
  }

  async transcode(job, { signal } = {}) {
    const inputPath = `${this.#workdir}/${job.id}.in`;
    const outputPath = `${this.#workdir}/${job.id}.${job.format === 'hls' ? 'm3u8' : job.format}`;
    const args = buildFfmpegArgs(job, { inputPath, outputPath });

    return new Promise((resolve, reject) => {
      // No shell: argv is passed straight to execve.
      const child = this.#spawn(this.#binary, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'], signal });
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        child.kill?.('SIGKILL');
        finish(createError('MEDIA_TRANSCODE_TIMEOUT', `Transcoding timed out after ${this.#timeoutMs}ms`, { status: 504, details: { jobId: job.id } }));
      }, this.#timeoutMs);
      timer?.unref?.();

      function finish(error, result) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.stderr?.removeAllListeners?.();
        child.removeAllListeners?.();
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      }

      child.stderr?.on?.('data', (chunk) => {
        if (stderr.length < this.#maxLogBytes) {
          stderr += String(chunk).slice(0, this.#maxLogBytes - stderr.length);
        }
      });
      child.on?.('error', (error) => finish(normalizeError(error, 'MEDIA_TRANSCODE_FAILED')));
      child.on?.('close', (code) => {
        if (code === 0) {
          finish(undefined, { outputPath, format: job.format, kind: job.kind });
          return;
        }
        this.#logger.warn?.('Transcoding process failed', { jobId: job.id, code, stderr: stderr.slice(0, 500) });
        finish(createError('MEDIA_TRANSCODE_FAILED', `Transcoder exited with code ${code}`, { status: 502, details: { jobId: job.id, code } }));
      });
    });
  }
}

/** In-memory transcoder for tests and local development. */
export class MockTranscoder extends Transcoder {
  constructor({ fail = false } = {}) {
    super();
    this.fail = fail;
    this.jobs = [];
  }

  async transcode(job) {
    if (this.fail) {
      throw createError('MEDIA_TRANSCODE_FAILED', 'Mock transcoder failed', { status: 502 });
    }
    const spec = normalizeTranscodeJob(job);
    this.jobs.push(spec);
    return { outputPath: `${spec.destination}`, format: spec.format, kind: spec.kind, status: TRANSCODE_STATUS.COMPLETED };
  }
}
