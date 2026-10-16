/**
 * Media detection utilities for robust audio/video recognition
 * Supports MIME types, generic binary blobs, and file extensions.
 */

export const isVideoFile = (file: File | null | undefined): boolean => {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();
  return (
    type.startsWith('video/') ||
    type.includes('video') ||
    /\.(mp4|webm|mkv|mov|avi|flv|wmv|m4v|3gp|3g2|ogv|ogm|ts|mts|m2ts|mpeg|mpg|mpe|m2v|mxf|vob|f4v|asf|divx)$/i.test(name)
  );
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
