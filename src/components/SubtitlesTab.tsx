import React, { useState, useRef, useEffect } from 'react';
import { 
    Subtitles, Youtube, ChevronDown, Sparkles, AlertCircle, FileText, Download, Play, Pause, 
    Video, FileAudio, Upload, Layers, Globe, Languages, Link, Check, Copy, RefreshCw, Info, ListFilter, 
    ExternalLink, Search
} from 'lucide-react';
import ReactPlayer from 'react-player';
const Player = ReactPlayer as any;
import { generateSRT, formatExistingSRTKeepTime } from '../services/gemini_srt';
import { SubtitleTimelineEditor } from './SubtitleTimelineEditor';
import { YouTubeSubtitleTimelineEditor } from './YouTubeSubtitleTimelineEditor';
import { ExportModal } from './ExportModal';
import { SubtitleFormatDropdown } from './SubtitleFormatDropdown';
import { YouTubeStreamLinksSelector } from './YouTubeStreamLinksSelector';
import { SubtitleType } from '../types';
import { parseSubtitles, generateSrt as generateSrtString, splitOversizedBlocks } from '../utils/subtitleParser';
import { segmentsToSrt } from '../services/youtubeCaptionService';
import { get, set, del } from 'idb-keyval';
import { isMediaFile, isVideoFile, isAudioFile } from '../utils/mediaUtils';
import { 
    normalizeYoutubeUrl, 
    downloadYouTubeMediaStream, 
    extractYouTubeMediaDetails, 
    fetchYouTubeCaptions,
    fetchYouTubeManifestDetails,
    ExtractedMediaDetails, 
    YouTubeQualityOption, 
    DownloadStreamProgress 
} from '../services/youtube';

interface SubtitlesTabProps {
    file?: File | null;
    apiKeys?: any;
    apiKeySource?: string;
    onMediaSwap?: (file: File) => void;
}

type PersistedMediaRecord = {
    __mvDirectorMediaRecord: true;
    name: string;
    type: string;
    lastModified: number;
    data: ArrayBuffer;
};

/**
 * Some embedded browser/Studio environments cannot structured-clone a File/Blob into
 * IndexedDB and report DataError: Failed to write blobs (InvalidBlob). Store bytes as
 * an ArrayBuffer in that case, while remaining backwards-compatible with old File/Blob
 * entries already saved by previous app versions.
 */
async function restorePersistedMedia(value: unknown, fallbackName: string): Promise<File | null> {
    if (typeof File !== 'undefined' && value instanceof File) return value;
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        const storedName = (value as Blob & { name?: string }).name || fallbackName;
        return new File([value], storedName, { type: value.type });
    }

    if (value && typeof value === 'object') {
        const record = value as Partial<PersistedMediaRecord>;
        if (record.__mvDirectorMediaRecord === true && record.data instanceof ArrayBuffer) {
            return new File([record.data], record.name || fallbackName, {
                type: record.type || 'application/octet-stream',
                lastModified: record.lastModified || Date.now(),
            });
        }
    }
    return null;
}

async function persistMediaFile(key: string, file: File): Promise<void> {
    try {
        await set(key, file);
    } catch (blobStorageError) {
        // Fallback for IndexedDB implementations that reject File/Blob structured cloning.
        const data = await file.arrayBuffer();
        const record: PersistedMediaRecord = {
            __mvDirectorMediaRecord: true,
            name: file.name,
            type: file.type || 'application/octet-stream',
            lastModified: file.lastModified || Date.now(),
            data,
        };
        try {
            await set(key, record);
        } catch (recordStorageError) {
            console.warn('[Media Storage] Blob and ArrayBuffer persistence both failed.', {
                blobStorageError,
                recordStorageError,
                fileName: file.name,
                fileSize: file.size,
            });
            throw recordStorageError;
        }
    }
}

export const SubtitlesTab: React.FC<SubtitlesTabProps> = ({ file, apiKeys, apiKeySource, onMediaSwap }) => {
    const [isGenerating, setIsGenerating] = useState(false);
    const [showExportModal, setShowExportModal] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [generationTime, setGenerationTime] = useState<number | null>(() => {
        const saved = localStorage.getItem('mv_subtitles_gen_time');
        return saved ? parseInt(saved, 10) : null;
    });

    const safeGetItem = (key: string, defaultValue: string) => {
        try {
            const val = localStorage.getItem(key);
            return (val !== null && val !== 'null' && val !== 'undefined') ? val : defaultValue;
        } catch (e) {
            return defaultValue;
        }
    };

    const safeSetItem = (key: string, value: string) => {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            console.warn('Could not save to localStorage:', e);
        }
    };

    const [mediaSourceType, setMediaSourceType] = useState<'upload' | 'youtube'>(() => 
        safeGetItem('mv_subtitles_source_type', 'upload') as 'upload' | 'youtube'
    );
    const [youtubeUrl, setYoutubeUrl] = useState<string>(() => safeGetItem('mv_subtitles_youtube_url', ''));
    const [youtubeInput, setYoutubeInput] = useState<string>(() => safeGetItem('mv_subtitles_youtube_url', ''));
    const [autoPlayYoutubeTrigger, setAutoPlayYoutubeTrigger] = useState<number>(0);

    const handleApplyYoutubeAndPlay = (rawInput: string) => {
        const raw = (rawInput || '').trim();
        if (!raw) return;
        const { url: clean, videoId, isValid } = normalizeYoutubeUrl(raw);
        if (isValid && clean) {
            setYoutubeUrl(clean);
            setYoutubeInput(clean);
            setMediaSourceType('youtube');
            setAutoPlayYoutubeTrigger(Date.now());
            setActiveView('editor');
        } else {
            setError(`Invalid YouTube link: ${raw}`);
        }
    };

    useEffect(() => {
        safeSetItem('mv_subtitles_source_type', mediaSourceType);
    }, [mediaSourceType]);

    useEffect(() => {
        safeSetItem('mv_subtitles_youtube_url', youtubeUrl);
    }, [youtubeUrl]);

    useEffect(() => {
        if (generationTime !== null) {
            localStorage.setItem('mv_subtitles_gen_time', generationTime.toString());
        } else {
            localStorage.removeItem('mv_subtitles_gen_time');
        }
    }, [generationTime]);

    // Initialize from localStorage
    const [srtContent, setSrtContent] = useState<string>(() => safeGetItem('mv_subtitles_srt', ''));
    
    const [activeView, setActiveView] = useState<'generator' | 'editor'>(() => {
        const saved = safeGetItem('mv_subtitles_view', 'generator');
        return (saved === 'generator' || saved === 'editor') ? saved : 'generator';
    });
    
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [generatorPreviewUrl, setGeneratorPreviewUrl] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // A delayed IndexedDB restore must never overwrite a file selected by the user
    // after this component mounted.
    const mediaSelectionVersion = useRef(0);

    // The Max Generator view needs its own preview: the Timeline Editor player is not
    // mounted while the Generator view is active. Keep this object URL scoped to the file.
    useEffect(() => {
        if (!audioFile || mediaSourceType !== 'upload' || !isVideoFile(audioFile)) {
            setGeneratorPreviewUrl(null);
            return;
        }
        const objectUrl = URL.createObjectURL(audioFile);
        setGeneratorPreviewUrl(objectUrl);
        return () => URL.revokeObjectURL(objectUrl);
    }, [audioFile, mediaSourceType]);

    // Persist SRT content
    useEffect(() => {
        safeSetItem('mv_subtitles_srt', srtContent);
        // Auto-switch to editor if we just generated new content
        if (srtContent && activeView === 'generator' && progress === 100) {
            setActiveView('editor');
        }
    }, [srtContent]);

    // Persist View
    useEffect(() => {
        safeSetItem('mv_subtitles_view', activeView);
    }, [activeView]);

    // Visual media reference state (companion video/image for Timeline Editor when audio track is used)
    const [visualMediaFile, setVisualMediaFile] = useState<File | null>(null);

    // Load persisted audio/video file and visual companion deterministically
    useEffect(() => {
        const loadAllMedia = async () => {
            const selectionVersionAtStart = mediaSelectionVersion.current;
            try {
                const storedFile = await get('mv_subtitles_media');
                const effectiveStoredFile = await restorePersistedMedia(storedFile, 'uploaded_media.mp4');

                // IndexedDB is asynchronous. If the user selected another file while
                // restoration was pending, the user's current selection takes priority.
                if (effectiveStoredFile && mediaSelectionVersion.current === selectionVersionAtStart) {
                    setAudioFile(effectiveStoredFile);
                    // Keep the restored primary source intact. The timeline editor only uses
                    // View Media as a companion when this source is audio-only.
                }

                // If media is an audio track (or empty), check if user had a companion video/image to match the view
                const storedVisual = await get('mv_subtitles_visual_media');
                const restoredVisual = await restorePersistedMedia(storedVisual, 'visual_view.mp4');
                if (restoredVisual) {
                    setVisualMediaFile(restoredVisual);
                }
            } catch (err) {
                console.warn('Failed to load persisted media', err);
            }
        };
        loadAllMedia();
    }, []);

    const updateVisualMediaFile = async (newFile: File | null) => {
        setVisualMediaFile(newFile);
        try {
            if (newFile) {
                await persistMediaFile('mv_subtitles_visual_media', newFile);
            } else {
                await del('mv_subtitles_visual_media');
            }
        } catch (err) {
            console.warn('Failed to persist visual media', err);
        }
    };

    // Persist audio/video file when it changes and keep visual companion in sync
    const updateAudioFile = async (newFile: File | null) => {
        mediaSelectionVersion.current += 1;
        setAudioFile(newFile);
        if (newFile) {
            setMediaSourceType('upload');
            if (isVideoFile(newFile)) {
                setProcessingMode('video_audio');
                // View Media is retained in storage, but it must not replace or overlay
                // the newly uploaded primary video in the timeline.
            } else if (isAudioFile(newFile)) {
                setProcessingMode('audio');
            }
            if (onMediaSwap) onMediaSwap(newFile);
        } else {
            setVisualMediaFile(null);
            try {
                await del('mv_subtitles_visual_media');
            } catch (e) {}
        }
        try {
            if (newFile) {
                await persistMediaFile('mv_subtitles_media', newFile);
            } else {
                await del('mv_subtitles_media');
            }
        } catch (err) {
            console.error('Failed to persist media', err);
        }
    };
    
    // Generator Options
    const [subtitleType, setSubtitleType] = useState<'standard' | 'bilingual' | 'dual_trans' | 'triple' | 'quad'>(() => 
        safeGetItem('ai_sub_type', 'standard') as any
    );
    const [sourceLanguage, setSourceLanguage] = useState(() => 
        safeGetItem('ai_sub_src_lang', 'Auto-detect')
    );
    const [targetLanguage, setTargetLanguage] = useState(() => 
        safeGetItem('ai_sub_tgt_lang', 'English')
    );
    const [styling, setStyling] = useState<'none' | 'colors' | 'emojis'>(() => 
        safeGetItem('ai_sub_styling', 'none') as any
    );
    const [processingMode, setProcessingMode] = useState<'audio' | 'video_audio' | 'youtube_transcript'>(() => 
        safeGetItem('ai_sub_proc_mode', 'video_audio') as any
    );
    const [resumeTime, setResumeTime] = useState('');
    const [contextInstruction, setContextInstruction] = useState(() => 
        safeGetItem('ai_sub_context', '')
    );
    const [isIngestingStream, setIsIngestingStream] = useState(false);
    const [streamProgress, setStreamProgress] = useState<DownloadStreamProgress | null>(null);
    const [streamQuality, setStreamQuality] = useState<YouTubeQualityOption>('audio');
    const [ingestSuccessMessage, setIngestSuccessMessage] = useState<string | null>(null);
    const [ingestErrorHelper, setIngestErrorHelper] = useState<{ videoId?: string | null; cleanUrl?: string } | null>(null);
    const [extractedDetails, setExtractedDetails] = useState<ExtractedMediaDetails | null>(null);
    const [isExtractingDetails, setIsExtractingDetails] = useState(false);
    const [subtitleSource, setSubtitleSource] = useState<'youtube_cc' | 'gemini_transcription' | 'user_srt' | null>(() =>
        safeGetItem('ai_sub_source', null) as any
    );

    const [isFetchingYoutubeCaptions, setIsFetchingYoutubeCaptions] = useState(false);
    const [youtubeCaptionFetchStatus, setYoutubeCaptionFetchStatus] = useState<string | null>(null);
    const [tinyFishCaptionQuery, setTinyFishCaptionQuery] = useState('');
    const [tinyFishCaptionLoading, setTinyFishCaptionLoading] = useState(false);
    const [tinyFishCaptionStatus, setTinyFishCaptionStatus] = useState<string | null>(null);
    const [tinyFishCaptionSources, setTinyFishCaptionSources] = useState<Array<{ title: string; url: string; snippet: string; domain: string }>>([]);
    const [isFetchingYoutubeManifests, setIsFetchingYoutubeManifests] = useState(false);
    const [youtubeManifestResult, setYoutubeManifestResult] = useState<Awaited<ReturnType<typeof fetchYouTubeManifestDetails>> | null>(null);

    // Uses the server-side caption endpoint; never inspect the cross-origin iframe DOM.
    const handleFetchYoutubeCaptions = async () => {
        const targetUrl = youtubeInput.trim() || youtubeUrl.trim();
        if (!targetUrl) {
            setError('Please enter a valid YouTube URL first.');
            return;
        }
        const { videoId, url: cleanYtUrl } = normalizeYoutubeUrl(targetUrl);
        if (!videoId) {
            setYoutubeCaptionFetchStatus('Could not identify a valid YouTube video ID.');
            return;
        }
        if (cleanYtUrl && cleanYtUrl !== youtubeUrl) {
            setYoutubeUrl(cleanYtUrl);
        }

        setIsFetchingYoutubeCaptions(true);
        setYoutubeCaptionFetchStatus('Fetching native YouTube timed captions…');
        setError(null);
        try {
            const result = await fetchYouTubeCaptions(videoId, sourceLanguage === 'Auto-detect' ? undefined : sourceLanguage);
            if (!result.success || (!result.rawSrt && !result.segments?.length)) {
                setYoutubeCaptionFetchStatus(result.message || 'No readable native captions found. Use Generate Subtitle for AI transcription.');
                return;
            }
            const rawSrt = result.rawSrt || segmentsToSrt(result.segments || []);
            const parsed = parseSubtitles(rawSrt);
            if (!parsed.length) {
                setYoutubeCaptionFetchStatus('YouTube returned caption data, but no timed cues could be parsed.');
                return;
            }
            const { blocks, splitCount } = splitOversizedBlocks(parsed);
            const finalBlocks = blocks.length ? blocks : parsed;
            setSrtContent(generateSrtString(finalBlocks));
            setSubtitleSource('youtube_cc');
            safeSetItem('ai_sub_source', 'youtube_cc');
            setActiveView('editor');
            setYoutubeCaptionFetchStatus(`Imported ${finalBlocks.length} timed cues from native YouTube captions (${result.language || 'source language'}).${splitCount ? ` Split ${splitCount} oversized cue(s).` : ''}`);
        } catch (err: any) {
            setYoutubeCaptionFetchStatus(err?.message || 'Native caption retrieval failed.');
        } finally {
            setIsFetchingYoutubeCaptions(false);
        }
    };

    const handleTinyFishCaptionResearch = async () => {
        const query = tinyFishCaptionQuery.trim();
        if (!query) return;
        setTinyFishCaptionLoading(true);
        setTinyFishCaptionStatus(null);
        setTinyFishCaptionSources([]);
        try {
            const response = await fetch('/api/tinyfish/context', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ purpose: 'caption', query: `Caption research for source language "${sourceLanguage || 'Auto-detect'}" and target language "${targetLanguage || 'Original'}": ${query}` })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || 'TinyFish caption research failed.');
            setTinyFishCaptionSources(Array.isArray(data.sources) ? data.sources : []);
            setTinyFishCaptionStatus(data.message || 'Caption research complete.');
        } catch (err: any) {
            setTinyFishCaptionStatus(err?.message || 'Could not retrieve caption research.');
        } finally { setTinyFishCaptionLoading(false); }
    };

    const handleFetchYoutubeManifests = async () => {
        const targetUrl = youtubeInput.trim() || youtubeUrl.trim();
        if (!targetUrl) {
            setError('Please enter a valid YouTube URL first.');
            return;
        }
        setIsFetchingYoutubeManifests(true);
        setYoutubeManifestResult(null);
        setYoutubeCaptionFetchStatus('Checking YouTube player clients and manifest providers…');
        try {
            const result = await fetchYouTubeManifestDetails(targetUrl);
            setYoutubeManifestResult(result);
            setYoutubeCaptionFetchStatus(result.message || (result.hlsUrl || result.dashUrl
                ? 'Manifest URLs discovered.'
                : 'No manifest URLs were exposed for this video.'));
        } catch (err: any) {
            setYoutubeCaptionFetchStatus(err?.message || 'Manifest lookup failed.');
        } finally {
            setIsFetchingYoutubeManifests(false);
        }
    };

    const handleCopyYoutubeManifest = async (url: string, type: 'HLS' | 'DASH') => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(url);
            setYoutubeCaptionFetchStatus(`${type} manifest URL copied.`);
        } catch {
            setYoutubeCaptionFetchStatus('Clipboard access is unavailable. Select the displayed URL and copy it manually.');
        }
    };

    const handleInspectStreamLinks = async () => {
        const targetUrl = youtubeInput.trim() || youtubeUrl.trim();
        if (!targetUrl) {
            setError('Please enter a valid YouTube URL first.');
            return;
        }
        const { url: cleanYtUrl, isValid } = normalizeYoutubeUrl(targetUrl);
        if (isValid && cleanYtUrl && cleanYtUrl !== youtubeUrl) {
            setYoutubeUrl(cleanYtUrl);
        }

        setIsExtractingDetails(true);
        setError(null);

        try {
            const details = await extractYouTubeMediaDetails(targetUrl);
            setExtractedDetails(details);
        } catch (err: any) {
            console.warn('Failed to extract stream details:', err);
            const { videoId } = normalizeYoutubeUrl(targetUrl);
            setExtractedDetails({
                title: 'YouTube Video',
                videoId: videoId || 'unknown',
                dashUrl: null,
                hlsUrl: null,
                combinedVideoUrl: null,
                combinedResolution: null,
                videoOnlyUrl: null,
                videoOnlyResolution: null,
                audioOnlyUrl: null,
                audioBitrate: null,
                subtitles: [],
                formats: [
                    {
                        id: `proxy-audio-${videoId}`,
                        type: 'audio',
                        label: 'High-Quality Audio Stream (Backend Stream Proxy)',
                        quality: 'High Bitrate Audio',
                        mimeType: 'audio/mpeg',
                        url: `/api/youtube/stream?videoId=${encodeURIComponent(videoId || '')}&quality=audio`,
                        isProxyUrl: true
                    },
                    {
                        id: `proxy-video-720-${videoId}`,
                        type: 'combined',
                        label: '720p HD Video Stream (Backend Stream Proxy)',
                        quality: '720p',
                        mimeType: 'video/mp4',
                        url: `/api/youtube/stream?videoId=${encodeURIComponent(videoId || '')}&quality=720`,
                        isProxyUrl: true
                    }
                ],
                directLinks: {
                    cobalt: `https://cobalt.tools`,
                    tenDownloader: `https://10downloader.com/download?v=https://www.youtube.com/watch?v=${videoId}`,
                    y2mate: `https://www.y2mate.com/youtube/${videoId}`,
                    saveFrom: `https://en.savefrom.net/20/#url=https://www.youtube.com/watch?v=${videoId}`,
                    piped: `https://piped.video/watch?v=${videoId}`,
                    invidious: `https://inv.nadeko.net/watch?v=${videoId}`
                },
                selectedPriority: 'NONE',
                mediaKind: 4 as any,
                error: err?.message
            });
        } finally {
            setIsExtractingDetails(false);
        }
    };

    const handleIngestStream = async () => {
        const targetUrl = youtubeInput.trim() || youtubeUrl.trim();
        if (!targetUrl) {
            setError('Please enter a valid YouTube URL first.');
            return;
        }

        setIsIngestingStream(true);
        setError(null);
        setIngestSuccessMessage(null);
        setIngestErrorHelper(null);

        try {
            const downloadedFile = await downloadYouTubeMediaStream(targetUrl, streamQuality, (p) => {
                setStreamProgress(p);
            });

            updateAudioFile(downloadedFile);
            if (onMediaSwap) {
                onMediaSwap(downloadedFile);
            }
            setMediaSourceType('upload');
            setProcessingMode(streamQuality === 'audio' ? 'audio' : 'video_audio');
            setIngestSuccessMessage(`Successfully fetched & converted "${downloadedFile.name}" (${(downloadedFile.size / (1024 * 1024)).toFixed(1)} MB)! Gemini is ready for full multimodal analysis.`);
        } catch (err: any) {
            console.warn('Failed to ingest YouTube stream:', err);
            setIngestErrorHelper({ videoId: err.videoId, cleanUrl: err.cleanUrl || targetUrl });
            // Automatically trigger detailed stream link inspector
            handleInspectStreamLinks();
        } finally {
            setIsIngestingStream(false);
        }
    };

    // Persist settings
    useEffect(() => {
        safeSetItem('ai_sub_type', subtitleType);
        safeSetItem('ai_sub_src_lang', sourceLanguage);
        safeSetItem('ai_sub_tgt_lang', targetLanguage);
        safeSetItem('ai_sub_styling', styling);
        safeSetItem('ai_sub_proc_mode', processingMode);
        safeSetItem('ai_sub_context', contextInstruction);
    }, [subtitleType, sourceLanguage, targetLanguage, styling, processingMode, contextInstruction]);

    // Keep track of the audio file when the global file changes
    useEffect(() => {
        if (file && isMediaFile(file)) {
            updateAudioFile(file);
        }
    }, [file]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const file = e.target.files[0];
            if (isMediaFile(file)) {
                setError(null);
                updateAudioFile(file);
            } else {
                setError('Invalid file type. Please upload an audio or video file (MP4, WebM, MKV, MOV, MP3, WAV, etc.).');
            }
        }
    };

    const [isReformattingMode, setIsReformattingMode] = useState(false);

    const handleReformatKeepTime = async () => {
        const baseSrt = safeGetItem('mv_stage1_native_srt', '') || srtContent;
        if (!baseSrt || !baseSrt.trim()) {
            setError('Generate or import native subtitles first before adjusting Style Format / Mode.');
            return;
        }
        setIsReformattingMode(true);
        setError(null);
        setProgress(15);
        try {
            const mode = subtitleType === 'standard' ? 'ori' : subtitleType === 'bilingual' ? 'dual' : subtitleType === 'dual_trans' ? 'dual_trans' : subtitleType === 'triple' ? 'triple' : 'quad';
            const apiKey = (apiKeySource === 'custom' ? apiKeys?.google : undefined) || apiKeys?.google || (localStorage.getItem('gemini_api_key') || undefined);
            const updatedSrt = await formatExistingSRTKeepTime(baseSrt, {
                mode: mode as any,
                targetLang: targetLanguage,
                sourceLang: sourceLanguage,
                styling,
                apiKey,
                contextInstruction,
                onProgress: (p) => setProgress(Math.max(15, p))
            });
            if (updatedSrt && updatedSrt.trim()) {
                setSrtContent(updatedSrt);
                setActiveView('editor');
            }
        } catch (err: any) {
            setError(err?.message || 'Failed to adjust Style Format / Subtitle Mode.');
        } finally {
            setIsReformattingMode(false);
        }
    };

    const handleGenerate = async () => {
        let effectiveYoutubeUrl = youtubeUrl.trim();
        if (mediaSourceType === 'youtube') {
            const candidateInput = youtubeInput.trim() || effectiveYoutubeUrl;
            const { url: normalizedYt, isValid } = normalizeYoutubeUrl(candidateInput);
            if (!isValid || !normalizedYt) {
                setError('Please enter a valid YouTube URL first.');
                return;
            }
            effectiveYoutubeUrl = normalizedYt;
            if (effectiveYoutubeUrl !== youtubeUrl) {
                setYoutubeUrl(effectiveYoutubeUrl);
            }
        } else {
            if (!audioFile) {
                setError('Please upload an audio or video file first.');
                return;
            }
        }

        setIsGenerating(true);
        setError(null);
        setProgress(10);
        setGenerationTime(null);
        const startTime = Date.now();

        try {
            const mode = subtitleType === 'standard' ? 'ori' : subtitleType === 'bilingual' ? 'dual' : subtitleType === 'dual_trans' ? 'dual_trans' : subtitleType === 'triple' ? 'triple' : 'quad';
            const apiKey = (apiKeySource === 'custom' ? apiKeys?.google : undefined) || apiKeys?.google || (localStorage.getItem('gemini_api_key') || undefined);
            
            const srt = await generateSRT({
                audioFile: mediaSourceType === 'upload' ? audioFile : null,
                youtubeUrl: mediaSourceType === 'youtube' ? effectiveYoutubeUrl : null,
                mode: mode as any, 
                targetLang: targetLanguage,
                sourceLang: sourceLanguage,
                styling,
                apiKey,
                onProgress: (p) => setProgress(Math.max(10, p)),
                processingMode,
                resumeTime,
                contextInstruction
            });
            
            const endTime = Date.now();
            setGenerationTime(endTime - startTime);
            
            setProgress(90);
            if (srt) {
                let finalSrt = srt;
                if (resumeTime && resumeTime.trim() !== '' && srtContent && srtContent.trim() !== '') {
                    try {
                        const existingBlocks = parseSubtitles(srtContent);
                        const newBlocks = parseSubtitles(srt);
                        
                        const parts = resumeTime.replace(',', '.').split(':').map(Number);
                        let h = 0, m = 0, s = 0;
                        if (parts.length === 3) {
                            [h, m, s] = parts;
                        } else if (parts.length === 2) {
                            [m, s] = parts;
                        } else {
                            s = parts[0] || 0;
                        }
                        const resumeTimeMs = (h * 3600 + m * 60 + s) * 1000;
                        
                        const keptBlocks = existingBlocks.filter(b => b.start < resumeTimeMs);
                        
                        let adjustedNewBlocks = newBlocks;
                        if (newBlocks.length > 0 && resumeTimeMs > 10000 && newBlocks[0].start < resumeTimeMs * 0.5) {
                            adjustedNewBlocks = newBlocks.map(b => ({
                                ...b,
                                start: b.start + resumeTimeMs,
                                end: b.end + resumeTimeMs
                            }));
                        }
                        
                        const combined = [...keptBlocks, ...adjustedNewBlocks].sort((a, b) => a.start - b.start);
                        combined.forEach((b, idx) => b.id = (idx + 1).toString());
                        finalSrt = generateSrtString(combined);
                    } catch (e) {
                        console.error("Error merging SRTs:", e);
                    }
                }

                // Note: Stage 1 already segmented oversized native cues and locked original timestamps
                // BEFORE Stage 2 formatted the selected Style Format / Subtitle Mode.
                // Do not re-split after Stage 2 so original timestamps and multi-layer lines stay 100% intact.

                setSrtContent(finalSrt);
                const resolvedSource = mediaSourceType === 'youtube'
                    ? (processingMode === 'youtube_transcript' ? 'youtube_cc' : 'gemini_transcription')
                    : 'gemini_transcription';
                setSubtitleSource(resolvedSource);
                safeSetItem('ai_sub_source', resolvedSource);
                setActiveView('editor');
            } else {
                setError('Failed to generate subtitles.');
            }
        } catch (err: any) {
            let msg = err?.message || 'An unexpected error occurred.';
            try {
                if (typeof msg === 'string' && (msg.startsWith('{') || msg.includes('{"error"'))) {
                    const jsonStart = msg.indexOf('{');
                    const jsonEnd = msg.lastIndexOf('}');
                    if (jsonStart !== -1 && jsonEnd !== -1) {
                        const parsed = JSON.parse(msg.slice(jsonStart, jsonEnd + 1));
                        if (parsed?.error?.message) {
                            msg = parsed.error.message;
                        }
                    }
                }
            } catch (_) {}

            if (msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('does not have permission')) {
                msg = "Permission Denied (403): The active API key lacks permission for this model or file processing. Please open Settings -> API Settings Vault and verify your Gemini API key.";
            } else if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
                msg = "API Rate Limit / Quota Exceeded (429). Please wait a moment before trying again or check your Gemini API key in Settings.";
            }

            setError(msg);
        } finally {
            setProgress(100);
            setTimeout(() => setIsGenerating(false), 500);
        }
    };

    const executeDownload = (filename: string) => {
        if (!srtContent) return;
        const blob = new Blob([srtContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setShowExportModal(false);
    };

    return (
        <div className="flex flex-col h-full bg-black/95">
            <div className="p-2 sm:p-4 border-b border-white/10 flex items-center justify-between shrink-0 bg-white/5 gap-2">
                <div className="flex items-center gap-3">
                    <div className="hidden sm:flex items-center gap-2"> 
                        <Subtitles className="w-5 h-5 text-indigo-400" />
                        <span className="font-bold text-white">
                            {activeView === 'generator' ? 'AI Subtitle Generator' : 'Timeline Editor'}
                        </span>
                    </div>
                    {generationTime !== null && srtContent && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-md text-[10px] sm:text-xs font-bold text-emerald-400 whitespace-nowrap">
                            <Sparkles className="w-3 h-3" />
                            Generated in {(generationTime / 1000).toFixed(1)}s
                        </div>
                    )}
                    {subtitleSource && (
                        <div className={`hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] sm:text-xs font-bold whitespace-nowrap border ${
                            subtitleSource === 'youtube_cc'
                                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                                : subtitleSource === 'gemini_transcription'
                                ? 'bg-indigo-500/15 border-indigo-500/30 text-indigo-300'
                                : 'bg-blue-500/15 border-blue-500/30 text-blue-300'
                        }`}>
                            <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
                            <span>
                                {subtitleSource === 'youtube_cc' && 'SOURCE: YouTube Authentic CC'}
                                {subtitleSource === 'gemini_transcription' && 'SOURCE: Gemini Media Transcription'}
                                {subtitleSource === 'user_srt' && 'SOURCE: User Provided SRT'}
                            </span>
                        </div>
                    )}
                </div>
                
                <div className="flex bg-black/40 p-1 rounded-lg w-full sm:w-fit border border-white/10 shrink-0 gap-1">
                    <button 
                        onClick={() => setActiveView('generator')} 
                        className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs sm:text-sm font-bold transition-colors cursor-pointer ${activeView === 'generator' ? 'bg-indigo-600 text-white shadow-lg' : 'text-white/50 hover:text-white'}`}
                    >
                        Max Generator
                    </button>
                    <button 
                        onClick={() => setActiveView('editor')} 
                        className={`flex-1 sm:flex-none px-3 py-1.5 rounded-md text-xs sm:text-sm font-bold transition-colors cursor-pointer ${activeView === 'editor' ? 'bg-indigo-600 text-white shadow-lg' : 'text-white/50 hover:text-white'}`}
                    >
                        Timeline Editor
                    </button>
                </div>
            </div>

            {/* View 1: Generator */}
            <div className={`flex-1 flex flex-col p-4 md:p-6 overflow-y-auto custom-scrollbar ${activeView === 'generator' ? 'block' : 'hidden'}`}>
                <div className="mx-auto w-full max-w-4xl space-y-8">
                            {/* About / Header Card */}
                            <div className="bg-gradient-to-br from-indigo-900/40 to-black/60 border border-indigo-500/20 p-6 rounded-2xl relative overflow-hidden">
                                <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/3"></div>
                                <div className="relative z-10 flex items-start gap-4">
                                    <div className="w-12 h-12 bg-indigo-500/20 rounded-xl flex items-center justify-center shrink-0">
                                        <Subtitles className="w-6 h-6 text-indigo-400" />
                                    </div>
                                    <div>
                                        <h2 className="text-xl font-bold text-white mb-2">SRT Subtitle Crafter</h2>
                                        <p className="text-white/70 text-sm leading-relaxed max-w-2xl">
                                            Generate original, dual, triple, or quad-layered subtitles directly from your audio or video files. 
                                            Powered by AI to automatically transcribe and sync precise timeline timestamps.
                                        </p>
                                    </div>
                                </div>
                            </div>
                    
                            {/* Media Source Selector */}
                            <div className="space-y-4">
                                <div className="flex bg-black/40 p-1 rounded-xl border border-white/10 max-w-md">
                                    <button
                                        type="button"
                                        onClick={() => setMediaSourceType('upload')}
                                        className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition-all ${mediaSourceType === 'upload' ? 'bg-indigo-600 text-white shadow' : 'text-white/50 hover:text-white'}`}
                                    >
                                        <Upload className="w-3.5 h-3.5" />
                                        <span>Local Media File</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setMediaSourceType('youtube')}
                                        className={`flex-1 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-bold transition-all ${mediaSourceType === 'youtube' ? 'bg-red-600 text-white shadow' : 'text-white/50 hover:text-white'}`}
                                    >
                                        <Youtube className="w-3.5 h-3.5 text-white" />
                                        <span>YouTube Video URL</span>
                                    </button>
                                </div>

                                {mediaSourceType === 'upload' ? (
                                    !audioFile ? (
                                        <div className="space-y-4">
                                            <label 
                                                onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                                onDrop={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                                                        const file = e.dataTransfer.files[0];
                                                        if (isMediaFile(file)) {
                                                            setError(null);
                                                            updateAudioFile(file);
                                                        } else {
                                                            setError('Invalid file type. Please upload an audio or video file (MP4, WebM, MKV, MOV, MP3, WAV, etc.).');
                                                        }
                                                    }
                                                }}
                                                className="w-full h-44 border-2 border-dashed border-white/20 rounded-2xl flex flex-col items-center justify-center cursor-pointer hover:bg-white/5 hover:border-indigo-500/50 transition-all group relative"
                                            >
                                                <input type="file" ref={fileInputRef} className="absolute inset-0 w-full h-full opacity-0 cursor-pointer" onChange={handleFileChange} />
                                                <div className="w-14 h-14 bg-white/5 rounded-full flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                                                    <Upload className="w-7 h-7 text-white/50 group-hover:text-indigo-400" />
                                                </div>
                                                <h3 className="text-white font-bold text-base mb-1">Select Media Source</h3>
                                                <p className="text-white/40 text-xs">Click or drag & drop audio or video file</p>
                                            </label>
                                        </div>
                                    ) : (
                                        <div className="space-y-3">
                                            <div className="bg-[#111] border border-white/10 p-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-12 h-12 rounded-lg flex items-center justify-center bg-indigo-500/20 text-indigo-400 shrink-0">
                                                        {isVideoFile(audioFile) ? <Video className="w-6 h-6" /> : <FileAudio className="w-6 h-6" />}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <h3 className="text-white font-medium max-w-[200px] sm:max-w-xs truncate">{audioFile.name}</h3>
                                                        <div className="flex flex-col gap-0.5 mt-0.5">
                                                            <div className="text-white/40 text-xs flex items-center gap-1.5 flex-wrap">
                                                                <span className={isVideoFile(audioFile) ? "text-purple-300 font-semibold" : "text-indigo-300 font-semibold"}>
                                                                    {isVideoFile(audioFile) ? "Video File Linked (Video + Audio)" : "Audio Track Linked (Audio Only)"}
                                                                </span>
                                                                <span>•</span>
                                                                <span>{(audioFile.size / (1024 * 1024)).toFixed(1)} MB</span>
                                                            </div>
                                                            <span className="text-[11px] text-white/50">
                                                                {isVideoFile(audioFile) 
                                                                    ? "Contains both video picture and dialogue audio for transcription and timeline playback."
                                                                    : "Soundtrack audio for AI subtitles. In Timeline Editor, you can use 'Match View' to pair any video or image preview."}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                                                    <button 
                                                        type="button"
                                                        onClick={() => {
                                                            setAutoPlayYoutubeTrigger(Date.now());
                                                            setActiveView('editor');
                                                        }}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-bold text-white transition-colors cursor-pointer shadow-md"
                                                        title="Open this video in the timeline editor and start playing"
                                                    >
                                                        <Play className="w-3.5 h-3.5 fill-white" />
                                                        <span>Open & Play in Timeline</span>
                                                    </button>
                                                    <button onClick={() => updateAudioFile(null)} className="text-red-400 text-xs font-medium hover:underline px-2 py-1 cursor-pointer">
                                                        Remove
                                                    </button>
                                                </div>
                                            </div>

                                            {isVideoFile(audioFile) && generatorPreviewUrl && (
                                                <div className="p-3 bg-black/40 border border-indigo-500/20 rounded-xl space-y-2">
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="min-w-0">
                                                            <div className="text-xs font-bold text-white flex items-center gap-1.5">
                                                                <Video className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                                                Primary Video Preview
                                                            </div>
                                                            <div className="text-[10px] text-white/50 truncate">{audioFile.name}</div>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            onClick={() => setActiveView('editor')}
                                                            className="shrink-0 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-[11px] font-bold text-white cursor-pointer"
                                                        >
                                                            Open Timeline
                                                        </button>
                                                    </div>
                                                    <video
                                                        key={generatorPreviewUrl}
                                                        src={generatorPreviewUrl}
                                                        controls
                                                        playsInline
                                                        preload="metadata"
                                                        className="w-full max-h-[42vh] rounded-lg bg-black object-contain"
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )
                                ) : (
                                    <div className="bg-[#111] border border-white/10 p-5 rounded-2xl space-y-4">
                                        <div className="flex flex-col gap-2 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04]">
                                            <div className="flex flex-col sm:flex-row gap-2">
                                                <button
                                                    type="button"
                                                    onClick={handleFetchYoutubeCaptions}
                                                    disabled={isFetchingYoutubeCaptions || !(youtubeInput.trim() || youtubeUrl.trim())}
                                                    className="flex-1 px-4 py-2.5 bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 disabled:opacity-50 text-emerald-100 text-xs font-bold rounded-xl flex items-center justify-center gap-2"
                                                >
                                                    {isFetchingYoutubeCaptions ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Subtitles className="w-4 h-4" />}
                                                    {isFetchingYoutubeCaptions ? 'Fetching YouTube CC…' : 'Fetch Native YouTube Captions'}
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={handleFetchYoutubeManifests}
                                                    disabled={isFetchingYoutubeManifests || !(youtubeInput.trim() || youtubeUrl.trim())}
                                                    className="flex-1 px-4 py-2.5 bg-orange-600/15 hover:bg-orange-600/25 border border-orange-500/25 disabled:opacity-50 text-orange-100 text-xs font-bold rounded-xl flex items-center justify-center gap-2"
                                                >
                                                    {isFetchingYoutubeManifests ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Link className="w-4 h-4" />}
                                                    {isFetchingYoutubeManifests ? 'Looking up manifests…' : 'Get HLS/DASH Manifest'}
                                                </button>
                                            </div>
                                            {youtubeCaptionFetchStatus && (
                                                <div role="status" className="text-[11px] text-white/65 leading-relaxed">{youtubeCaptionFetchStatus}</div>
                                            )}
                                            {youtubeManifestResult && (
                                                <div className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-2">
                                                    <div className="text-xs font-semibold text-white/80 truncate">{youtubeManifestResult.title || 'YouTube Manifest Results'}</div>
                                                    {youtubeManifestResult.hlsUrl && (
                                                        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] p-2 space-y-1">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">HLS Manifest (.m3u8)</span>
                                                                <button type="button" onClick={() => void handleCopyYoutubeManifest(youtubeManifestResult.hlsUrl!, 'HLS')} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] text-white/75 hover:bg-white/10">
                                                                    <Copy className="w-3 h-3" /> Copy URL
                                                                </button>
                                                            </div>
                                                            <a href={youtubeManifestResult.hlsUrl} target="_blank" rel="noreferrer" className="block max-h-20 overflow-y-auto break-all text-[10px] leading-relaxed text-white/60">{youtubeManifestResult.hlsUrl}</a>
                                                        </div>
                                                    )}
                                                    {youtubeManifestResult.dashUrl && (
                                                        <div className="rounded-lg border border-sky-500/20 bg-sky-500/[0.04] p-2 space-y-1">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="text-[10px] font-bold uppercase tracking-wide text-sky-300">DASH Manifest (.mpd)</span>
                                                                <button type="button" onClick={() => void handleCopyYoutubeManifest(youtubeManifestResult.dashUrl!, 'DASH')} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] text-white/75 hover:bg-white/10">
                                                                    <Copy className="w-3 h-3" /> Copy URL
                                                                </button>
                                                            </div>
                                                            <a href={youtubeManifestResult.dashUrl} target="_blank" rel="noreferrer" className="block max-h-20 overflow-y-auto break-all text-[10px] leading-relaxed text-white/60">{youtubeManifestResult.dashUrl}</a>
                                                        </div>
                                                    )}
                                                    {!youtubeManifestResult.hlsUrl && !youtubeManifestResult.dashUrl && (
                                                        <div className="text-[11px] text-white/55">No HLS/DASH URL was returned. Some ordinary videos expose only temporary progressive/adaptive stream URLs, and manifest availability varies by player/session.</div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex flex-col sm:flex-row gap-2">
                                            <div className="relative flex-1">
                                                <Youtube className="w-4 h-4 text-red-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
                                                 <input
                                                    type="text"
                                                    value={youtubeInput}
                                                    onChange={(e) => setYoutubeInput(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter' && youtubeInput.trim()) {
                                                            handleApplyYoutubeAndPlay(youtubeInput);
                                                        }
                                                    }}
                                                    placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
                                                    className="w-full bg-black/60 border border-white/10 text-white rounded-xl pl-10 pr-4 py-3 text-xs outline-none focus:border-red-500 placeholder:text-white/30 transition-colors"
                                                />
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={handleInspectStreamLinks}
                                                    disabled={!youtubeInput.trim() || isExtractingDetails}
                                                    className="px-4 py-3 bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-2 whitespace-nowrap border border-white/10 cursor-pointer"
                                                    title="Show all direct stream links, available formats, and subtitle tracks to select the correct one"
                                                >
                                                    {isExtractingDetails ? <RefreshCw className="w-4 h-4 animate-spin text-amber-400" /> : <ListFilter className="w-4 h-4 text-amber-400" />}
                                                    <span>Inspect & Select Stream Links</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleApplyYoutubeAndPlay(youtubeInput)}
                                                    disabled={!youtubeInput.trim()}
                                                    className="px-5 py-3 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-2 whitespace-nowrap shadow-lg shadow-red-600/20 cursor-pointer"
                                                    title="Load video and immediately play in the timeline editor"
                                                >
                                                    <Play className="w-4 h-4 fill-white" />
                                                    <span>Load & Play</span>
                                                </button>
                                            </div>
                                        </div>

                                        {/* Direct Stream Links & Format Selector Panel */}
                                        {extractedDetails && (
                                            <YouTubeStreamLinksSelector
                                                details={extractedDetails}
                                                onSelectStreamFile={(selectedFile) => {
                                                    updateAudioFile(selectedFile);
                                                    if (onMediaSwap) onMediaSwap(selectedFile);
                                                    setMediaSourceType('upload');
                                                    setProcessingMode('video_audio');
                                                    setExtractedDetails(null);
                                                    setIngestSuccessMessage(`Successfully loaded selected stream "${selectedFile.name}" (${(selectedFile.size / (1024 * 1024)).toFixed(1)} MB)!`);
                                                }}
                                                onImportSubtitleText={(subContent, langName) => {
                                                    const blocks = parseSubtitles(subContent);
                                                    const { blocks: splitBlocks, splitCount } = splitOversizedBlocks(blocks);
                                                    const finalBlocks = splitBlocks.length > 0 ? splitBlocks : blocks;
                                                    const standardSrt = finalBlocks.length > 0 ? generateSrtString(finalBlocks) : subContent;
                                                    setSrtContent(standardSrt);
                                                    setSubtitleSource('youtube_cc');
                                                    safeSetItem('ai_sub_source', 'youtube_cc');
                                                    setActiveView('editor');
                                                    setExtractedDetails(null);
                                                    setIngestSuccessMessage(`Imported ${langName} caption track (${finalBlocks.length} concise cues${splitCount > 0 ? `, auto-segmented ${splitCount} long blocks` : ''})!`);
                                                }}
                                                onClose={() => setExtractedDetails(null)}
                                            />
                                        )}

                                        {/* Download & Ingest Stream Controller */}
                                        <div className="p-4 bg-gradient-to-r from-red-950/30 to-purple-950/30 border border-red-500/20 rounded-2xl space-y-3 text-left">
                                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                                <div className="space-y-0.5">
                                                    <div className="text-xs font-bold text-white flex items-center gap-2">
                                                        <Sparkles className="w-4 h-4 text-amber-400" />
                                                        <span>Direct Multimodal AI Ingestion (Watch & Listen)</span>
                                                    </div>
                                                    <p className="text-[11px] text-white/60">
                                                        Fetch YouTube stream into local memory so Gemini can analyze real acoustic waveforms and video frames.
                                                    </p>
                                                </div>

                                                <div className="flex items-center gap-1 bg-black/40 p-1 rounded-xl border border-white/10 self-start sm:self-auto">
                                                    <button
                                                        type="button"
                                                        onClick={() => setStreamQuality('audio')}
                                                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all ${streamQuality === 'audio' ? 'bg-red-600 text-white shadow' : 'text-white/60 hover:text-white'}`}
                                                    >
                                                        ⚡ Audio (Fastest)
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setStreamQuality('360')}
                                                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all ${streamQuality === '360' ? 'bg-red-600 text-white shadow' : 'text-white/60 hover:text-white'}`}
                                                    >
                                                        🎬 360p Video
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => setStreamQuality('720')}
                                                        className={`px-2.5 py-1 text-[11px] font-bold rounded-lg transition-all ${streamQuality === '720' ? 'bg-red-600 text-white shadow' : 'text-white/60 hover:text-white'}`}
                                                    >
                                                        🌟 720p HD
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-3">
                                                <button
                                                    type="button"
                                                    onClick={handleIngestStream}
                                                    disabled={(!youtubeInput.trim() && !youtubeUrl) || isIngestingStream}
                                                    className="flex-1 py-2.5 px-4 bg-gradient-to-r from-red-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer"
                                                >
                                                    {isIngestingStream ? (
                                                        <>
                                                            <RefreshCw className="w-4 h-4 animate-spin" />
                                                            <span>{streamProgress?.message || 'Ingesting stream...'}</span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Download className="w-4 h-4" />
                                                            <span>Fetch & Convert to Local Media ({streamQuality === 'audio' ? 'Audio Track' : `${streamQuality}p Video`})</span>
                                                        </>
                                                    )}
                                                </button>
                                            </div>

                                            {isIngestingStream && streamProgress && (
                                                <div className="space-y-1 pt-1">
                                                    <div className="w-full bg-black/50 rounded-full h-1.5 overflow-hidden">
                                                        <div 
                                                            className="bg-red-500 h-full transition-all duration-300 rounded-full" 
                                                            style={{ width: `${streamProgress.percent}%` }}
                                                        />
                                                    </div>
                                                    <div className="flex justify-between text-[10px] text-white/50">
                                                        <span>{streamProgress.message}</span>
                                                        <span>{streamProgress.percent}%</span>
                                                    </div>
                                                </div>
                                            )}

                                            {ingestSuccessMessage && (
                                                <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center gap-2 text-[11px] text-emerald-300">
                                                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                                                    <span className="flex-1">{ingestSuccessMessage}</span>
                                                </div>
                                            )}

                                            {ingestErrorHelper && (
                                                <div className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-xl space-y-2.5 text-left">
                                                    <div className="flex items-center gap-2 text-xs font-bold text-amber-300">
                                                        <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                                                        <span>YouTube Direct Stream Throttled — Quick Bypass Options</span>
                                                    </div>
                                                    <p className="text-[11px] text-white/70 leading-relaxed">
                                                        YouTube's rate-limiting blocked automated proxy stream download. Choose one of the quick bypass options below:
                                                    </p>

                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                const downloadUrl = ingestErrorHelper.cleanUrl || (ingestErrorHelper.videoId ? `https://www.youtube.com/watch?v=${ingestErrorHelper.videoId}` : youtubeInput);
                                                                window.open(`https://10downloader.com/download?v=${encodeURIComponent(downloadUrl)}`, '_blank');
                                                            }}
                                                            className="p-2.5 bg-white/10 hover:bg-white/15 border border-white/10 rounded-lg text-left transition-colors flex items-center gap-2.5 group cursor-pointer"
                                                        >
                                                            <div className="w-7 h-7 rounded-md bg-red-500/20 flex items-center justify-center shrink-0">
                                                                <Download className="w-3.5 h-3.5 text-red-400 group-hover:scale-110 transition-transform" />
                                                            </div>
                                                            <div className="min-w-0">
                                                                <div className="text-[11px] font-bold text-white">1. Download via 10Downloader</div>
                                                                <div className="text-[10px] text-white/50 truncate">Pre-fills link for instant MP3/MP4</div>
                                                            </div>
                                                        </button>

                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                const targetUrl = ingestErrorHelper.cleanUrl || youtubeInput;
                                                                handleApplyYoutubeAndPlay(targetUrl);
                                                                setIngestErrorHelper(null);
                                                            }}
                                                            className="p-2.5 bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 rounded-lg text-left transition-colors flex items-center gap-2.5 group cursor-pointer"
                                                        >
                                                            <div className="w-7 h-7 rounded-md bg-indigo-500/20 flex items-center justify-center shrink-0">
                                                                <Play className="w-3.5 h-3.5 text-indigo-400 group-hover:scale-110 transition-transform" />
                                                            </div>
                                                            <div className="min-w-0">
                                                                <div className="text-[11px] font-bold text-indigo-300">2. Use Native YouTube Timeline</div>
                                                                <div className="text-[10px] text-white/50 truncate">Extract native CC & timed subtitles</div>
                                                            </div>
                                                        </button>
                                                    </div>

                                                    {/* Inline Dropzone */}
                                                    <div
                                                        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                                        onDrop={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                                                                const droppedFile = e.dataTransfer.files[0];
                                                                updateAudioFile(droppedFile);
                                                                if (onMediaSwap) onMediaSwap(droppedFile);
                                                                setMediaSourceType('upload');
                                                                setIngestErrorHelper(null);
                                                                setIngestSuccessMessage(`Loaded "${droppedFile.name}" for Gemini Multimodal analysis!`);
                                                            }
                                                        }}
                                                        className="p-3 border-2 border-dashed border-white/20 hover:border-amber-400/50 rounded-lg text-center transition-colors bg-black/30"
                                                    >
                                                        <label className="cursor-pointer block">
                                                            <input
                                                                type="file"
                                                                accept="audio/*,video/*"
                                                                className="hidden"
                                                                onChange={(e) => {
                                                                    if (e.target.files && e.target.files[0]) {
                                                                        const picked = e.target.files[0];
                                                                        updateAudioFile(picked);
                                                                        if (onMediaSwap) onMediaSwap(picked);
                                                                        setMediaSourceType('upload');
                                                                        setIngestErrorHelper(null);
                                                                        setIngestSuccessMessage(`Loaded "${picked.name}" for Gemini Multimodal analysis!`);
                                                                    }
                                                                }}
                                                            />
                                                            <div className="text-[11px] text-white/80 font-medium flex items-center justify-center gap-1.5">
                                                                <Upload className="w-3.5 h-3.5 text-amber-400" />
                                                                <span>Drop your downloaded audio/video file here</span>
                                                            </div>
                                                            <div className="text-[10px] text-white/40 pt-0.5">or click to browse from device</div>
                                                        </label>
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {youtubeUrl ? (
                                            <div className="space-y-3 pt-2">
                                                <div className="flex items-center justify-between text-xs">
                                                    <span className="text-emerald-400 font-semibold flex items-center gap-1.5">
                                                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                                                        YouTube Video Linked for Timeline
                                                    </span>
                                                    <div className="flex items-center gap-2">
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setAutoPlayYoutubeTrigger(Date.now());
                                                                setActiveView('editor');
                                                            }}
                                                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-[11px] font-bold transition-colors shadow flex items-center gap-1.5 cursor-pointer"
                                                        >
                                                            <Play className="w-3 h-3 fill-white" />
                                                            <span>Open & Play in Editor</span>
                                                        </button>
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setYoutubeUrl('');
                                                                setYoutubeInput('');
                                                            }}
                                                            className="text-red-400 hover:text-red-300 text-xs transition-colors"
                                                        >
                                                            Clear
                                                        </button>
                                                    </div>
                                                </div>
                                                 <div className="p-3 bg-white/5 border border-white/10 rounded-xl space-y-1 text-left">
                                                    <div className="text-[11px] font-bold text-white flex items-center gap-1.5">
                                                        <Info className="w-3.5 h-3.5 text-indigo-400" />
                                                        <span>YouTube Mode Active</span>
                                                    </div>
                                                    <p className="text-[11px] text-white/60 leading-relaxed">
                                                        Video is linked for the <strong>Timeline Editor</strong>. Open the editor to watch the video, scrub the timeline, and click <strong>"Generate Subtitle"</strong> to have AI inspect the YouTube video/script and generate subtitle timings.
                                                    </p>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="p-3 bg-white/5 border border-white/10 rounded-xl space-y-1 text-left">
                                                <p className="text-[11px] text-white/70 leading-relaxed">
                                                    Paste any public YouTube video link to enable <strong>synchronized video playback and subtitle scrub/editing</strong> in the Timeline Editor.
                                                </p>
                                                <p className="text-[10px] text-white/40">
                                                    Tip: Use the <strong>"Fetch & Convert"</strong> button above to download the stream directly into local memory for full acoustic & visual Gemini analysis!
                                                </p>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                    {/* Generator Options */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-white/70 uppercase tracking-wider flex items-center gap-1.5">
                                <Layers className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Style format</span>
                            </label>
                            <SubtitleFormatDropdown 
                                value={subtitleType} 
                                onChange={setSubtitleType} 
                            />
                            <p className="text-white/40 text-[11px] leading-relaxed pt-0.5">
                                {subtitleType === 'standard' && 'Clean, single-line subtitles (Native or Translated).'}
                                {subtitleType === 'bilingual' && 'Native language on top, Translated below.'}
                                {subtitleType === 'dual_trans' && 'English on top, Target Language below (No Native).'}
                                {subtitleType === 'triple' && 'Native + Romanized + Translated.'}
                                {subtitleType === 'quad' && 'Native + Romanized + English + Target.'}
                            </p>
                        </div>

                        <datalist id="language-suggestions">
                            <option value="Auto-detect" />
                            <option value="English" />
                            <option value="Spanish" />
                            <option value="French" />
                            <option value="German" />
                            <option value="Italian" />
                            <option value="Portuguese" />
                            <option value="Dutch" />
                            <option value="Russian" />
                            <option value="Japanese" />
                            <option value="Chinese (Mandarin)" />
                            <option value="Chinese (Cantonese)" />
                            <option value="Korean" />
                            <option value="Arabic" />
                            <option value="Hindi" />
                            <option value="Thai" />
                            <option value="Vietnamese" />
                            <option value="Indonesian" />
                            <option value="Turkish" />
                            <option value="Polish" />
                            <option value="Swedish" />
                            <option value="Tagalog" />
                        </datalist>

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-white/70 uppercase tracking-wider flex items-center gap-1.5">
                                <Globe className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Source Language</span>
                            </label>
                            <input 
                                type="text"
                                list="language-suggestions"
                                value={sourceLanguage} 
                                onChange={(e) => setSourceLanguage(e.target.value)}
                                placeholder="e.g. Japanese, Auto-detect"
                                className="w-full bg-black/40 border border-white/10 text-white rounded-xl px-4 py-3 text-xs outline-none focus:border-indigo-500 placeholder:text-white/20 transition-colors"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-white/70 uppercase tracking-wider flex items-center gap-1.5">
                                <Languages className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Target Language</span>
                            </label>
                            <input 
                                type="text"
                                list="language-suggestions"
                                value={targetLanguage} 
                                onChange={(e) => setTargetLanguage(e.target.value)}
                                placeholder="e.g. English, Thai (Leave blank for Original)"
                                className="w-full bg-black/40 border border-white/10 text-white rounded-xl px-4 py-3 text-xs outline-none focus:border-indigo-500 placeholder:text-white/20 transition-colors"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-bold text-white/70 uppercase tracking-wider">Visual Styling (Experimental)</label>
                            <div className="grid grid-cols-2 gap-2">
                                <button onClick={() => setStyling('none')} className={`p-2.5 rounded-xl border text-center transition-all ${styling === 'none' ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-black/40 border-white/10 hover:bg-white/10 text-white/70'}`}>
                                    <h4 className="font-bold text-xs">Plain Text</h4>
                                </button>
                                <button onClick={() => setStyling('colors')} className={`p-2.5 rounded-xl border text-center transition-all ${styling === 'colors' ? 'bg-indigo-600/20 border-indigo-500 text-indigo-300' : 'bg-black/40 border-white/10 hover:bg-white/10 text-white/70'}`}>
                                    <h4 className="font-bold text-xs">Colored</h4>
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* 2-Stage Native-First & Locked Original Time Bar */}
                    <div className="mt-4 p-3.5 rounded-xl bg-indigo-950/25 border border-indigo-500/25 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="space-y-0.5 text-left">
                            <div className="text-xs font-bold text-indigo-200 flex items-center gap-1.5">
                                <Layers className="w-3.5 h-3.5 text-indigo-400" />
                                <span>2-Stage Pipeline: Native First → Style Format / Mode (Original Time Locked)</span>
                            </div>
                            <p className="text-[11px] text-white/60">
                                Stage 1 transcribes the native spoken audio and locks exact timestamps. Stage 2 adjusts your selected <strong>Style format</strong>, <strong>Target Language</strong>, and <strong>Visual Styling</strong> without altering original timecodes.
                            </p>
                        </div>
                        {Boolean(srtContent.trim()) && (
                            <button
                                type="button"
                                onClick={() => void handleReformatKeepTime()}
                                disabled={isReformattingMode || isGenerating}
                                className="px-3.5 py-2 bg-indigo-600/30 hover:bg-indigo-600/50 border border-indigo-400/40 disabled:opacity-40 text-indigo-100 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 cursor-pointer"
                                title="Re-adjust Style Format, Target Language, or Visual Styling from the Stage 1 native baseline while keeping 100% of the original timestamps"
                            >
                                {isReformattingMode ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 text-indigo-300" />}
                                <span>{isReformattingMode ? 'Adjusting Format...' : 'Adjust Mode / Style (Keep Original Time)'}</span>
                            </button>
                        )}
                    </div>

                    {mediaSourceType === 'youtube' ? (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4 mt-4">
                            <button 
                                onClick={() => setProcessingMode('video_audio')} 
                                className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${processingMode === 'video_audio' ? 'bg-red-600/20 border-red-500 shadow-lg' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                            >
                                <Video className={`w-6 h-6 ${processingMode === 'video_audio' ? 'text-red-400' : 'text-white/50'}`} />
                                <span className="font-bold text-white text-xs sm:text-sm">Watch & Listen</span>
                                <span className="text-[11px] text-white/50 text-center">AI watches frames + audio stream</span>
                            </button>
                            <button 
                                onClick={() => setProcessingMode('audio')} 
                                className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${processingMode === 'audio' ? 'bg-red-600/20 border-red-500 shadow-lg' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                            >
                                <FileAudio className={`w-6 h-6 ${processingMode === 'audio' ? 'text-red-400' : 'text-white/50'}`} />
                                <span className="font-bold text-white text-xs sm:text-sm">Listen Only</span>
                                <span className="text-[11px] text-white/50 text-center">Audio-focused speech timing</span>
                            </button>
                            <button 
                                onClick={() => setProcessingMode('youtube_transcript')} 
                                className={`p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${processingMode === 'youtube_transcript' ? 'bg-red-600/20 border-red-500 shadow-lg' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}
                            >
                                <Subtitles className={`w-6 h-6 ${processingMode === 'youtube_transcript' ? 'text-red-400' : 'text-white/50'}`} />
                                <span className="font-bold text-white text-xs sm:text-sm">YouTube Subtitle / CC</span>
                                <span className="text-[11px] text-white/50 text-center">Reads authentic CC only (no untimed transcripts)</span>
                            </button>
                        </div>
                    ) : (
                        <div className="flex flex-col sm:flex-row gap-4 mb-2 mt-4">
                            <button onClick={() => setProcessingMode('audio')} className={`flex-1 p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${processingMode === 'audio' ? 'bg-indigo-600/20 border-indigo-500' : 'bg-white/5 border-white/10 hover:bg-white/10'}`}>
                                <FileAudio className={`w-6 h-6 ${processingMode === 'audio' ? 'text-indigo-400' : 'text-white/50'}`} />
                                <span className="font-bold text-white text-sm">Listen Only (Audio)</span>
                                <span className="text-xs text-white/50 text-center">Process audio only. Faster, ignores video frames.</span>
                            </button>
                            <button onClick={() => setProcessingMode('video_audio')} disabled={Boolean(audioFile && !isVideoFile(audioFile))} className={`flex-1 p-4 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all ${processingMode === 'video_audio' ? 'bg-indigo-600/20 border-indigo-500' : 'bg-white/5 border-white/10 hover:bg-white/10'} ${audioFile && !isVideoFile(audioFile) ? 'opacity-50 cursor-not-allowed' : ''}`}>
                                <Video className={`w-6 h-6 ${processingMode === 'video_audio' ? 'text-indigo-400' : 'text-white/50'}`} />
                                <span className="font-bold text-white text-sm">Watch & Listen (Video)</span>
                                <span className="text-xs text-white/50 text-center">Read lips, action, and text for deeper context.</span>
                            </button>
                        </div>
                    )}

                    <div className="space-y-3 mb-6">
                        <label className="text-sm font-bold text-white/70 uppercase tracking-wider flex items-center justify-between">
                            <span>Resume / Start From (Optional)</span>
                        </label>
                        <div className="flex items-center gap-2">
                            <input 
                                type="text"
                                value={resumeTime} 
                                onChange={(e) => setResumeTime(e.target.value)}
                                placeholder="e.g. 00:52:00 (Format: HH:MM:SS)"
                                className="flex-1 bg-[#111] border border-white/10 text-white rounded-xl p-3 outline-none focus:border-indigo-500 placeholder:text-white/20 font-mono text-sm"
                            />
                        </div>
                        <p className="text-xs text-white/40">If generation failed halfway, input the timestamp where it stopped. The AI will ignore everything before this time.</p>
                    </div>

                    <div className="space-y-3 mb-6">
                        <label className="text-sm font-bold text-white/70 uppercase tracking-wider flex items-center justify-between">
                            <span>Context / Instructions (Optional)</span>
                        </label>
                        <textarea 
                            value={contextInstruction}
                            onChange={(e) => setContextInstruction(e.target.value)}
                            placeholder="e.g. This is a scene from a sci-fi movie. The character's name is 'Kael'. Make sure to use casual tone."
                            className="w-full bg-[#111] border border-white/10 text-white rounded-xl p-3 outline-none focus:border-indigo-500 placeholder:text-white/20 text-sm resize-none h-24 custom-scrollbar"
                        />
                        <p className="text-xs text-white/40">Provide details about the video, character names, or specific instructions for the AI generator.</p>
                    </div>

                    <div className="mb-6 rounded-2xl border border-teal-500/25 bg-teal-950/15 p-4 space-y-3">
                        <div className="flex items-center gap-2 text-sm font-bold text-teal-200"><Globe className="w-4 h-4 text-teal-300" /><span>TinyFish Caption Research</span><span className="text-[9px] px-1.5 py-0.5 rounded bg-teal-500/15 border border-teal-400/25 uppercase">Live web</span></div>
                        <p className="text-[11px] text-white/55">Research names, idioms, slang, cultural references, or translation nuances. This enriches context; speech transcription and timed SRT generation still use your configured transcription model.</p>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <input value={tinyFishCaptionQuery} onChange={(e) => setTinyFishCaptionQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleTinyFishCaptionResearch(); } }} placeholder="e.g. Research slang in this song or a character's name spelling" className="flex-1 min-w-0 bg-black/40 border border-white/10 text-white rounded-xl px-3 py-2.5 text-xs outline-none focus:border-teal-500 placeholder:text-white/25" maxLength={1000} />
                            <button type="button" onClick={() => void handleTinyFishCaptionResearch()} disabled={!tinyFishCaptionQuery.trim() || tinyFishCaptionLoading} className="px-4 py-2.5 bg-teal-600/25 hover:bg-teal-600/40 border border-teal-500/30 disabled:opacity-40 rounded-xl text-xs font-bold text-teal-100 flex items-center justify-center gap-2">{tinyFishCaptionLoading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}{tinyFishCaptionLoading ? 'Researching…' : 'Research captions'}</button>
                        </div>
                        {tinyFishCaptionStatus && <p className="text-[11px] text-white/65">{tinyFishCaptionStatus}</p>}
                        {tinyFishCaptionSources.length > 0 && <div className="space-y-2">{tinyFishCaptionSources.map((source, index) => <a key={source.url + index} href={source.url} target="_blank" rel="noopener noreferrer" className="block rounded-xl border border-white/10 bg-black/30 p-3 hover:border-teal-500/30"><div className="text-xs font-semibold text-teal-100">{source.title}</div><div className="text-[10px] text-white/40 mt-0.5">{source.domain}</div>{source.snippet && <p className="text-[11px] text-white/65 mt-1">{source.snippet}</p>}</a>)}</div>}
                    </div>

                    <button 
                        onClick={handleGenerate}
                        disabled={(mediaSourceType === 'upload' && !audioFile) || (mediaSourceType === 'youtube' && !youtubeUrl && !youtubeInput.trim()) || isGenerating}
                        className="w-full py-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-white/10 disabled:text-white/30 text-white font-bold rounded-xl transition-all flex items-center justify-center gap-2 shadow-xl cursor-pointer disabled:cursor-not-allowed"
                    >
                        {isGenerating ? (
                            <>
                                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                                {mediaSourceType === 'youtube' ? 'Generating Subtitles from YouTube...' : 'Analyzing Media & Generating Subtitles...'}
                            </>
                        ) : mediaSourceType === 'youtube' ? (
                            (!youtubeUrl && !youtubeInput.trim()) ? (
                                <>
                                    <Youtube className="w-5 h-5 text-red-400" />
                                    <span>Enter YouTube Link to Generate</span>
                                </>
                            ) : (
                                <>
                                    <Sparkles className="w-5 h-5" />
                                    <span>Generate YouTube SRT Subtitles</span>
                                </>
                            )
                        ) : !audioFile ? (
                            <>
                                <FileAudio className="w-5 h-5" />
                                <span>Upload Local File to Generate</span>
                            </>
                        ) : (
                            <>
                                <Sparkles className="w-5 h-5" />
                                <span>Generate SRT Subtitles</span>
                            </>
                        )}
                    </button>

                    {error && (
                        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                            <p className="text-red-200 text-sm">{error}</p>
                        </div>
                    )}
                    
                    {isGenerating && (
                        <div className="w-full bg-white/5 rounded-full h-2 mt-4 overflow-hidden">
                            <div className="bg-indigo-500 h-full transition-all duration-300" style={{ width: `${progress}%` }} />
                        </div>
                    )}

                    {/* Result Section */}
                    {srtContent && activeView === 'generator' && (
                        <div className="bg-[#111] border border-white/10 rounded-2xl p-4 sm:p-6 flex flex-col space-y-4 shadow-xl">
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/10 pb-4">
                                <div>
                                    <h3 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                                        <span>Generated Subtitles (.SRT)</span>
                                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/10 text-white/70 uppercase">
                                            {subtitleType}
                                        </span>
                                    </h3>
                                    <p className="text-[11px] text-white/50">
                                        Review or edit your raw SRT script, download the file, or open it directly in the timeline editor.
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 self-end sm:self-auto flex-wrap">
                                    <button 
                                        type="button"
                                        onClick={() => setShowExportModal(true)} 
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-white/10 hover:bg-white/20 rounded-lg text-xs font-bold text-white transition-colors cursor-pointer border border-white/10"
                                    >
                                        <Download className="w-3.5 h-3.5 text-indigo-400" />
                                        <span>Download .SRT</span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => {
                                            setAutoPlayYoutubeTrigger(Date.now());
                                            setActiveView('editor');
                                        }}
                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-bold text-white transition-colors cursor-pointer shadow-md"
                                    >
                                        <Play className="w-3.5 h-3.5 fill-white" />
                                        <span>Open in Timeline Editor</span>
                                    </button>
                                </div>
                            </div>

                            <textarea 
                                value={srtContent}
                                onChange={(e) => setSrtContent(e.target.value)}
                                className="w-full h-80 bg-black/60 border border-white/10 rounded-xl p-4 text-xs font-mono text-white/80 resize-none outline-none focus:border-indigo-500/50 custom-scrollbar leading-relaxed"
                                placeholder="Your generated SRT subtitles will appear here..."
                            />
                            
                            <div className="flex items-center justify-between text-[11px] text-white/40">
                                <span>Live SRT text representation</span>
                                <span>{srtContent.split('\n').filter(Boolean).length} lines • {srtContent.length} characters</span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* View 2: Timeline Editor */}
            <div className={`flex-1 flex flex-col p-0 overflow-hidden min-h-0 ${activeView === 'editor' ? 'flex' : 'hidden'}`}>
                <div className="mx-auto w-full max-w-none h-full min-h-0 flex flex-col overflow-hidden">
                    <div className="bg-[#111] border-none sm:border-solid sm:border-white/10 rounded-none sm:rounded-2xl flex flex-col flex-1 h-full min-h-0 overflow-hidden w-full m-0">
                        {mediaSourceType === 'youtube' && youtubeUrl ? (
                            <YouTubeSubtitleTimelineEditor
                                initialContent={srtContent}
                                youtubeUrl={youtubeUrl}
                                autoPlayTrigger={autoPlayYoutubeTrigger}
                                onContentChange={setSrtContent}
                                onYoutubeUrlChange={(url) => {
                                    setYoutubeUrl(url);
                                    setYoutubeInput(url);
                                }}
                                apiKey={apiKeySource === 'custom' ? apiKeys?.google : (localStorage.getItem('gemini_api_key') || undefined)}
                            />
                        ) : (
                            <SubtitleTimelineEditor
                                key={audioFile ? audioFile.name + '-' + audioFile.size + '-' + audioFile.lastModified : 'no-primary-media'}
                                initialContent={srtContent}
                                audioFile={audioFile}
                                visualMediaFile={visualMediaFile}
                                onVisualMediaChange={updateVisualMediaFile}
                                youtubeUrl={null}
                                autoPlayTrigger={autoPlayYoutubeTrigger}
                                onContentChange={setSrtContent}
                                onMediaSwap={(newFile) => {
                                    mediaSelectionVersion.current += 1;
                                    setMediaSourceType('upload');
                                    setAudioFile(newFile);
                                    if (onMediaSwap) onMediaSwap(newFile);
                                }}
                                onYoutubeUrlChange={(url) => {
                                    setYoutubeUrl(url);
                                    setYoutubeInput(url);
                                    if (url) {
                                        setMediaSourceType('youtube');
                                    }
                                }}
                                apiKey={apiKeySource === 'custom' ? apiKeys?.google : (localStorage.getItem('gemini_api_key') || undefined)}
                            />
                        )}
                    </div>
                </div>
            </div>

            {/* Export Modal */}
            {showExportModal && (
                <ExportModal
                    defaultName="subtitles.srt"
                    onExport={executeDownload}
                    onClose={() => setShowExportModal(false)}
                />
            )}
        </div>
    );
};
