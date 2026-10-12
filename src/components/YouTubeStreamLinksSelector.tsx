import React, { useState } from 'react';
import { 
  Play, Download, ExternalLink, Copy, Check, Subtitles, 
  Music, Video, Radio, Sparkles, RefreshCw, AlertCircle, FileText, ArrowRight 
} from 'lucide-react';
import { 
  ExtractedMediaDetails, 
  StreamFormatItem, 
  SubtitleTrackInfo, 
  downloadDirectStreamToMediaFile, 
  DownloadStreamProgress 
} from '../services/youtube';

interface YouTubeStreamLinksSelectorProps {
  details: ExtractedMediaDetails;
  onSelectStreamFile: (file: File) => void;
  onImportSubtitleText?: (subtitleContent: string, languageName: string) => void;
  onClose?: () => void;
}

export const YouTubeStreamLinksSelector: React.FC<YouTubeStreamLinksSelectorProps> = ({
  details,
  onSelectStreamFile,
  onImportSubtitleText,
  onClose
}) => {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<DownloadStreamProgress | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [importingSubLang, setImportingSubLang] = useState<string | null>(null);
  const [previewStreamUrl, setPreviewStreamUrl] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<'audio' | 'video'>('audio');

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSelectFormat = async (format: StreamFormatItem) => {
    setDownloadingId(format.id);
    setDownloadProgress({
      stage: 'downloading',
      percent: 20,
      message: `Loading ${format.label}...`
    });

    try {
      const isAudio = format.type === 'audio';
      const ext = isAudio ? 'mp3' : 'mp4';
      const cleanTitle = (details.title || 'youtube_stream').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
      const filename = `${cleanTitle}_${format.quality || format.type}.${ext}`;

      const file = await downloadDirectStreamToMediaFile(
        format.url,
        filename,
        format.mimeType,
        (progress) => setDownloadProgress(progress)
      );

      onSelectStreamFile(file);
    } catch (err: any) {
      console.error('Failed to download selected stream format:', err);
      alert(`Could not directly ingest this stream link: ${err?.message || 'Upstream connection error'}. Please click the direct link or use one of the 1-click downloaders below.`);
    } finally {
      setDownloadingId(null);
      setDownloadProgress(null);
    }
  };

  const handleImportCaption = async (sub: SubtitleTrackInfo) => {
    if (!onImportSubtitleText) return;
    setImportingSubLang(sub.code);

    try {
      const proxyUrl = `/api/youtube/subtitles?url=${encodeURIComponent(sub.url)}`;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();
      onImportSubtitleText(content, sub.name);
    } catch (err) {
      console.error('Failed to import subtitle track:', err);
      alert('Failed to fetch closed caption track directly. Please try a different track or manual download.');
    } finally {
      setImportingSubLang(null);
    }
  };

  return (
    <div className="bg-[#141419] border border-white/10 rounded-2xl p-5 space-y-5 shadow-2xl text-left">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-white/10">
        <div className="flex items-center gap-3 min-w-0">
          {details.thumbnailUrl ? (
            <img 
              src={details.thumbnailUrl} 
              alt={details.title} 
              className="w-16 h-12 object-cover rounded-lg border border-white/10 shrink-0" 
            />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-red-600/20 border border-red-500/30 flex items-center justify-center shrink-0">
              <Video className="w-6 h-6 text-red-400" />
            </div>
          )}
          <div className="min-w-0">
            <h3 className="text-white font-bold text-sm truncate max-w-md sm:max-w-lg" title={details.title}>
              {details.title || 'YouTube Video'}
            </h3>
            <div className="flex items-center gap-2 text-[11px] text-white/50">
              <span>ID: <code className="text-amber-400">{details.videoId}</code></span>
              {details.duration ? <span>• {Math.floor(details.duration / 60)}m {details.duration % 60}s</span> : null}
              <span>•</span>
              <a 
                href={`https://www.youtube.com/watch?v=${details.videoId}`} 
                target="_blank" 
                rel="noreferrer" 
                className="text-red-400 hover:underline flex items-center gap-1"
              >
                <span>YouTube Watch</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        </div>

        {onClose && (
          <button 
            type="button" 
            onClick={onClose}
            className="text-white/40 hover:text-white text-xs px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
          >
            Close Links Panel
          </button>
        )}
      </div>

      {/* Notice & Prompt */}
      <div className="p-3 bg-indigo-950/30 border border-indigo-500/20 rounded-xl flex items-center gap-2.5 text-xs text-indigo-200">
        <Sparkles className="w-4 h-4 text-indigo-400 shrink-0" />
        <span>
          <strong>Select your preferred stream link below</strong> to ingest it into the timeline for Gemini multimodal analysis, or use the 1-click verified downloaders.
        </span>
      </div>

      {/* Audio/Video Preview Player if active */}
      {previewStreamUrl && (
        <div className="p-3 bg-black/60 border border-white/10 rounded-xl space-y-2">
          <div className="flex items-center justify-between text-xs text-white/70">
            <span className="font-bold flex items-center gap-1.5 text-emerald-400">
              <Play className="w-3.5 h-3.5 fill-emerald-400" />
              Stream Preview Playing
            </span>
            <button 
              type="button" 
              onClick={() => setPreviewStreamUrl(null)} 
              className="text-white/40 hover:text-white text-[11px]"
            >
              Close Preview
            </button>
          </div>
          {previewType === 'video' ? (
            <video 
              src={previewStreamUrl} 
              controls 
              autoPlay 
              className="w-full max-h-48 rounded-lg bg-black" 
            />
          ) : (
            <audio 
              src={previewStreamUrl} 
              controls 
              autoPlay 
              className="w-full h-10" 
            />
          )}
        </div>
      )}

      {/* 1. Direct Stream Formats List */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
            <Radio className="w-4 h-4 text-emerald-400" />
            <span>Available Direct Stream Formats ({details.formats.length})</span>
          </h4>
          <span className="text-[10px] text-white/40">Click any format to load & play</span>
        </div>

        <div className="grid grid-cols-1 gap-2 max-h-72 overflow-y-auto pr-1">
          {details.formats.length === 0 ? (
            <div className="p-4 bg-white/5 rounded-xl text-center text-xs text-white/50">
              No direct stream formats were returned by upstream. Use the 1-click downloaders below.
            </div>
          ) : (
            details.formats.map((fmt) => {
              const isAudio = fmt.type === 'audio';
              const isDownloading = downloadingId === fmt.id;

              return (
                <div 
                  key={fmt.id} 
                  className="p-3 bg-black/40 hover:bg-black/60 border border-white/10 hover:border-indigo-500/40 rounded-xl transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isAudio ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                      {isAudio ? <Music className="w-4 h-4" /> : <Video className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate flex items-center gap-2">
                        <span>{fmt.label}</span>
                        {fmt.quality && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/80 font-mono">
                            {fmt.quality}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-white/40 font-mono truncate max-w-xs sm:max-w-md">
                        {fmt.mimeType} {fmt.bitrate ? `• ${Math.round(fmt.bitrate / 1000)} kbps` : ''}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 self-end sm:self-auto shrink-0">
                    {/* Test Preview */}
                    <button
                      type="button"
                      onClick={() => {
                        setPreviewType(fmt.type === 'audio' ? 'audio' : 'video');
                        setPreviewStreamUrl(fmt.url);
                      }}
                      className="px-2 py-1 bg-white/5 hover:bg-white/15 text-white/70 hover:text-white rounded-lg text-[11px] transition-colors"
                      title="Test playback in mini player"
                    >
                      Test Play
                    </button>

                    {/* Copy Link */}
                    <button
                      type="button"
                      onClick={() => handleCopy(fmt.id, fmt.url.startsWith('/') ? `${window.location.origin}${fmt.url}` : fmt.url)}
                      className="p-1.5 bg-white/5 hover:bg-white/15 text-white/60 hover:text-white rounded-lg text-xs transition-colors"
                      title="Copy stream URL"
                    >
                      {copiedId === fmt.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>

                    {/* Select & Ingest Stream */}
                    <button
                      type="button"
                      onClick={() => handleSelectFormat(fmt)}
                      disabled={isDownloading}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shadow-md shadow-indigo-600/20 cursor-pointer"
                    >
                      {isDownloading ? (
                        <>
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Ingesting...</span>
                        </>
                      ) : (
                        <>
                          <Check className="w-3.5 h-3.5" />
                          <span>Select This Stream</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {downloadProgress && (
          <div className="p-3 bg-indigo-950/40 border border-indigo-500/30 rounded-xl space-y-1">
            <div className="flex justify-between text-xs text-indigo-300 font-medium">
              <span>{downloadProgress.message}</span>
              <span>{downloadProgress.percent}%</span>
            </div>
            <div className="w-full bg-black/50 rounded-full h-1.5 overflow-hidden">
              <div 
                className="bg-indigo-500 h-full transition-all duration-300 rounded-full" 
                style={{ width: `${downloadProgress.percent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 2. Closed Captions & Subtitles Tracks */}
      {details.subtitles && details.subtitles.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-white/10">
          <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
            <Subtitles className="w-4 h-4 text-amber-400" />
            <span>Native Closed Captions Tracks ({details.subtitles.length})</span>
          </h4>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {details.subtitles.map((sub, idx) => (
              <div 
                key={idx} 
                className="p-2.5 bg-black/40 border border-white/10 rounded-xl flex items-center justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="text-xs font-bold text-white truncate">
                    {sub.name} {sub.isAutoGenerated ? '(Auto-Generated)' : ''}
                  </div>
                  <div className="text-[10px] text-white/40">Code: {sub.code} • {sub.mimeType}</div>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {onImportSubtitleText && (
                    <button
                      type="button"
                      onClick={() => handleImportCaption(sub)}
                      disabled={importingSubLang === sub.code}
                      className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 rounded-lg text-[11px] font-bold transition-all flex items-center gap-1"
                      title="Import into SRT subtitle timeline editor"
                    >
                      {importingSubLang === sub.code ? <RefreshCw className="w-3 h-3 animate-spin" /> : <FileText className="w-3 h-3" />}
                      <span>Import CC</span>
                    </button>
                  )}
                  <a
                    href={sub.url}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1 bg-white/5 hover:bg-white/15 text-white/60 hover:text-white rounded-lg"
                    title="Open raw caption track"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 3. Verified 1-Click Fast Web Downloader Links */}
      {details.directLinks && (
        <div className="space-y-2.5 pt-2 border-t border-white/10">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <Download className="w-4 h-4 text-cyan-400" />
              <span>Verified 1-Click Fast Downloaders</span>
            </h4>
            <span className="text-[10px] text-white/40">Pre-fills this exact video</span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            <a
              href={details.directLinks.cobalt}
              target="_blank"
              rel="noreferrer"
              className="p-2.5 bg-white/5 hover:bg-cyan-600/20 border border-white/10 hover:border-cyan-500/40 rounded-xl transition-all flex items-center justify-between group"
            >
              <div>
                <div className="text-xs font-bold text-white group-hover:text-cyan-300">Cobalt Tools</div>
                <div className="text-[10px] text-white/40">Ad-free direct save</div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-white/30 group-hover:text-cyan-400 shrink-0" />
            </a>

            <a
              href={details.directLinks.tenDownloader}
              target="_blank"
              rel="noreferrer"
              className="p-2.5 bg-white/5 hover:bg-red-600/20 border border-white/10 hover:border-red-500/40 rounded-xl transition-all flex items-center justify-between group"
            >
              <div>
                <div className="text-xs font-bold text-white group-hover:text-red-300">10Downloader</div>
                <div className="text-[10px] text-white/40">Instant MP3/MP4</div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-white/30 group-hover:text-red-400 shrink-0" />
            </a>

            <a
              href={details.directLinks.y2mate}
              target="_blank"
              rel="noreferrer"
              className="p-2.5 bg-white/5 hover:bg-emerald-600/20 border border-white/10 hover:border-emerald-500/40 rounded-xl transition-all flex items-center justify-between group"
            >
              <div>
                <div className="text-xs font-bold text-white group-hover:text-emerald-300">Y2Mate</div>
                <div className="text-[10px] text-white/40">Fast audio & video</div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-white/30 group-hover:text-emerald-400 shrink-0" />
            </a>

            <a
              href={details.directLinks.saveFrom}
              target="_blank"
              rel="noreferrer"
              className="p-2.5 bg-white/5 hover:bg-purple-600/20 border border-white/10 hover:border-purple-500/40 rounded-xl transition-all flex items-center justify-between group"
            >
              <div>
                <div className="text-xs font-bold text-white group-hover:text-purple-300">SaveFrom.net</div>
                <div className="text-[10px] text-white/40">Web converter</div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-white/30 group-hover:text-purple-400 shrink-0" />
            </a>

            <a
              href={details.directLinks.piped}
              target="_blank"
              rel="noreferrer"
              className="p-2.5 bg-white/5 hover:bg-amber-600/20 border border-white/10 hover:border-amber-500/40 rounded-xl transition-all flex items-center justify-between group"
            >
              <div>
                <div className="text-xs font-bold text-white group-hover:text-amber-300">Piped Web Player</div>
                <div className="text-[10px] text-white/40">Privacy stream</div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-white/30 group-hover:text-amber-400 shrink-0" />
            </a>

            <a
              href={details.directLinks.invidious}
              target="_blank"
              rel="noreferrer"
              className="p-2.5 bg-white/5 hover:bg-pink-600/20 border border-white/10 hover:border-pink-500/40 rounded-xl transition-all flex items-center justify-between group"
            >
              <div>
                <div className="text-xs font-bold text-white group-hover:text-pink-300">Invidious Web</div>
                <div className="text-[10px] text-white/40">Ad-free direct</div>
              </div>
              <ExternalLink className="w-3.5 h-3.5 text-white/30 group-hover:text-pink-400 shrink-0" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
};
