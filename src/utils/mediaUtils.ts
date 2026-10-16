/**
 * Media detection utilities for robust audio/video recognition.
 * Browser-provided MIME types are not always reliable, especially in embedded
 * browsers and Android file pickers, so known file extensions take priority.
 */
const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  ogv: 'video/ogg', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  flv: 'video/x-flv', wmv: 'video/x-ms-wmv', mpeg: 'video/mpeg',
  mpg: 'video/mpeg', mpe: 'video/mpeg', '3gp': 'video/3gpp', '3g2': 'video/3gpp2',
  ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t', mxf: 'application/mxf',
  vob: 'video/mpeg', rm: 'application/vnd.rn-realmedia', rmvb: 'application/vnd.rn-realmedia-vbr',
  divx: 'video/divx', f4v: 'video/mp4', asf: 'video/x-ms-asf',
};
const VIDEO_EXTENSION = /\.(mp4|m4v|mov|webm|ogv|mkv|avi|flv|wmv|mpeg|mpg|mpe|3gp|3g2|ts|m2ts|mts|mxf|vob|rm|rmvb|divx|f4v|asf)$/i;
const AUDIO_EXTENSION = /\.(mp3|wav|ogg|m4a|aac|flac|wma|opus|aiff|alac|amr|mid|midi)$/i;
const IMAGE_EXTENSION = /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i;

export const inferMediaMimeType = (file: File | null | undefined): string => {
  if (!file) return '';
  const extension = (file.name || '').toLowerCase().split('.').pop() || '';
  const inferredVideoMime = VIDEO_MIME_BY_EXTENSION[extension];
  const actualMime = (file.type || '').toLowerCase().split(';', 1)[0].trim();
  if (inferredVideoMime && (!actualMime || actualMime === 'application/octet-stream' || actualMime === 'binary/octet-stream' || !actualMime.startsWith('video/'))) {
    return inferredVideoMime;
  }
  return actualMime || inferredVideoMime || '';
};

export const isVideoFile = (file: File | null | undefined): boolean => {
  if (!file) return false;
  const type = (file.type || '').toLowerCase().split(';', 1)[0].trim();
  return VIDEO_EXTENSION.test((file.name || '').trim()) || type.startsWith('video/') || type.includes('video');
};

export const isAudioFile = (file: File | null | undefined): boolean => {
  if (!file || isVideoFile(file)) return false;
  const type = (file.type || '').toLowerCase().split(';', 1)[0].trim();
  return AUDIO_EXTENSION.test((file.name || '').trim()) || type.startsWith('audio/') || type.includes('audio');
};

export const isImageFile = (file: File | null | undefined): boolean => {
  if (!file) return false;
  const type = (file.type || '').toLowerCase().split(';', 1)[0].trim();
  return type.startsWith('image/') || IMAGE_EXTENSION.test(file.name || '');
};

export const isMediaFile = (file: File | null | undefined): boolean => isVideoFile(file) || isAudioFile(file);
