/**
 * Media detection utilities for robust audio/video recognition
 * Supports MIME types, generic binary blobs, and file extensions.
 */

export const isVideoFile = (file: File | null | undefined): boolean => {
  if (!file) return false;
  const type = (file.type || '').toLowerCase().split(';', 1)[0].trim();
  const name = (file.name || '').toLowerCase().trim();

  // Browsers and Android document providers don't always assign the same MIME
  // type to a video. Treat common video container extensions as authoritative
  // when MIME is empty, generic, or incorrectly reported as audio/application.
  if (type.startsWith('video/') || type.includes('video')) return true;
  return /\.(mp4|webm|mkv|mov|avi|flv|wmv|m4v|3gp|3g2|ogv|mpeg|mpg|mpe|m2v|m2ts|mts|ts|vob|f4v|mxf|ogm)$/i.test(name);
};

export const isAudioFile = (file: File | null | undefined): boolean => {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return (
    type.startsWith('audio/') ||
    type.includes('audio') ||
    /\.(mp3|wav|ogg|m4a|aac|flac|wma|opus|aiff)$/i.test(name)
  );
};

export const isMediaFile = (file: File | null | undefined): boolean => {
  return isVideoFile(file) || isAudioFile(file);
};
