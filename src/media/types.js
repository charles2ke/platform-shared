import { createError } from '../shared/errors.js';

export const MEDIA_KINDS = Object.freeze({
  VIDEO: 'video',
  AUDIO: 'audio',
  IMAGE: 'image'
});

export const TRANSCODE_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
});

/**
 * Allow-list of output formats per media kind. Formats are validated against
 * this list before they ever reach a transcoder argument list, so a caller
 * cannot smuggle an encoder/muxer (or shell metacharacters) into the pipeline.
 */
export const OUTPUT_FORMATS = Object.freeze({
  [MEDIA_KINDS.VIDEO]: Object.freeze(['mp4', 'webm', 'hls', 'mov']),
  [MEDIA_KINDS.AUDIO]: Object.freeze(['mp3', 'aac', 'ogg', 'wav', 'flac']),
  [MEDIA_KINDS.IMAGE]: Object.freeze(['jpeg', 'png', 'webp', 'avif'])
});

/** Named presets keep clients from hand-tuning encoder parameters. */
export const TRANSCODE_PRESETS = Object.freeze({
  'video-1080p': { kind: MEDIA_KINDS.VIDEO, format: 'mp4', width: 1920, height: 1080, videoBitrateKbps: 4500, audioBitrateKbps: 128 },
  'video-720p': { kind: MEDIA_KINDS.VIDEO, format: 'mp4', width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
  'video-480p': { kind: MEDIA_KINDS.VIDEO, format: 'mp4', width: 854, height: 480, videoBitrateKbps: 1200, audioBitrateKbps: 96 },
  'video-hls-ladder': { kind: MEDIA_KINDS.VIDEO, format: 'hls', width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
  'audio-podcast': { kind: MEDIA_KINDS.AUDIO, format: 'mp3', audioBitrateKbps: 128, channels: 2, sampleRate: 44100 },
  'audio-voice': { kind: MEDIA_KINDS.AUDIO, format: 'aac', audioBitrateKbps: 64, channels: 1, sampleRate: 22050 },
  'image-thumbnail': { kind: MEDIA_KINDS.IMAGE, format: 'webp', width: 320, height: 320, quality: 80 },
  'image-avatar': { kind: MEDIA_KINDS.IMAGE, format: 'webp', width: 512, height: 512, quality: 85 },
  'image-web': { kind: MEDIA_KINDS.IMAGE, format: 'jpeg', width: 1600, height: 1600, quality: 82 }
});

export const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_DIMENSION = 8192;
const MAX_BITRATE_KBPS = 60_000;
const SAFE_PATH = /^[\w./-]{1,512}$/;

function assertEnum(value, allowed, code, message) {
  if (!allowed.includes(value)) {
    throw createError(code, message, { status: 400, details: { value, allowed } });
  }
}

function assertBoundedInteger(value, { min, max, field }) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw createError('MEDIA_INVALID_PARAMETER', `${field} must be an integer between ${min} and ${max}`, { status: 400, details: { field } });
  }
  return value;
}

/**
 * Validates a transcoding request and returns a normalized job specification.
 * Source and destination are object-storage keys, never shell strings: they are
 * checked against a conservative character allow-list, and `..` is rejected so a
 * job cannot escape its bucket prefix (path traversal).
 */
export function normalizeTranscodeJob(input = {}) {
  const kind = input.kind ?? TRANSCODE_PRESETS[input.preset]?.kind;
  assertEnum(kind, Object.values(MEDIA_KINDS), 'MEDIA_INVALID_KIND', 'Media kind must be video, audio, or image');

  const preset = input.preset === undefined ? undefined : TRANSCODE_PRESETS[input.preset];
  if (input.preset !== undefined && preset === undefined) {
    throw createError('MEDIA_UNKNOWN_PRESET', `Unknown transcoding preset: ${String(input.preset)}`, { status: 400 });
  }
  if (preset && preset.kind !== kind) {
    throw createError('MEDIA_PRESET_KIND_MISMATCH', `Preset ${input.preset} does not apply to ${kind}`, { status: 400 });
  }

  const format = input.format ?? preset?.format;
  assertEnum(format, [...OUTPUT_FORMATS[kind]], 'MEDIA_INVALID_FORMAT', `Unsupported output format for ${kind}`);

  if (input.id !== undefined && (typeof input.id !== 'string' || !SAFE_JOB_ID.test(input.id))) {
    throw createError('MEDIA_INVALID_JOB_ID', 'id must be a filename-safe string of letters, digits, \'_\', or \'-\' (max 128 chars)', { status: 400 });
  }

  for (const [field, value] of Object.entries({ source: input.source, destination: input.destination })) {
    if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.includes('..')) {
      throw createError('MEDIA_INVALID_LOCATION', `${field} must be a safe object key (letters, digits, '.', '_', '-', '/')`, { status: 400, details: { field } });
    }
  }

  return {
    id: input.id,
    kind,
    preset: input.preset,
    format,
    source: input.source,
    destination: input.destination,
    width: assertBoundedInteger(input.width ?? preset?.width, { min: 16, max: MAX_DIMENSION, field: 'width' }),
    height: assertBoundedInteger(input.height ?? preset?.height, { min: 16, max: MAX_DIMENSION, field: 'height' }),
    videoBitrateKbps: assertBoundedInteger(input.videoBitrateKbps ?? preset?.videoBitrateKbps, { min: 64, max: MAX_BITRATE_KBPS, field: 'videoBitrateKbps' }),
    audioBitrateKbps: assertBoundedInteger(input.audioBitrateKbps ?? preset?.audioBitrateKbps, { min: 16, max: 1_024, field: 'audioBitrateKbps' }),
    channels: assertBoundedInteger(input.channels ?? preset?.channels, { min: 1, max: 8, field: 'channels' }),
    sampleRate: assertBoundedInteger(input.sampleRate ?? preset?.sampleRate, { min: 8_000, max: 192_000, field: 'sampleRate' }),
    quality: assertBoundedInteger(input.quality ?? preset?.quality, { min: 1, max: 100, field: 'quality' }),
    metadata: { ...(input.metadata ?? {}) }
  };
}
