import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
    Upload, Download, Split, Copy, Trash2, Plus, Play, Pause, RotateCcw, RotateCw, 
    ZoomIn, ZoomOut, X, Edit2, Edit3, GripHorizontal, Camera, Settings, Maximize, Clock, 
    ListTree, Scan, Scissors, FilePlus, Undo, Redo, Lock, Unlock, AudioWaveform, 
    Sparkles, Tv, ChevronLeft, ChevronRight, FileText, RefreshCw, AlertTriangle, 
    FastForward, Youtube, Link, ExternalLink, Languages, Check, Type 
} from 'lucide-react';
import { BulkTextToolsModal } from "./BulkTextToolsModal";
import { ExportModal } from "./ExportModal";
import { FrameTranslateModal } from "./FrameTranslateModal";
import { generateYouTubeSRT } from '../services/gemini_srt';
import { normalizeYoutubeUrl, downloadYouTubeMediaStream, fetchYouTubeCaptions, fetchYouTubeManifestDetails } from '../services/youtube';
import { segmentsToSrt } from '../services/youtubeCaptionService';
import { syncSubtitleTranslations, translateSingleLine, fixSubtitleWithAgenticVideo, fixSubtitleWithAudio, uploadVideoToGemini, fixSubtitleWithFrame, getEffectiveGeminiApiKey } from '../services/gemini';
import { captureScreenFrame } from '../utils/frameCapture';
import { splitSingleBlockBySentences, splitSentences, parseSubtitles } from '../utils/subtitleParser';

declare global {
    interface Window {
        YT?: any;
        onYouTubeIframeAPIReady?: () => void;
    }
}

// Loads official YouTube IFrame API script once globally
function loadYouTubeIframeApi(): Promise<any> {
    return new Promise((resolve) => {
        if (typeof window === 'undefined') return;
        if (window.YT && window.YT.Player) {
            resolve(window.YT);
            return;
        }

        const existingScript = document.getElementById('youtube-iframe-api-script');
        if (!existingScript) {
            const tag = document.createElement('script');
            tag.id = 'youtube-iframe-api-script';
            tag.src = 'https://www.youtube.com/iframe_api';
            const firstScriptTag = document.getElementsByTagName('script')[0];
            if (firstScriptTag && firstScriptTag.parentNode) {
                firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
            } else {
                document.head.appendChild(tag);
            }
        }

        const previousCallback = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => {
            if (previousCallback) previousCallback();
            resolve(window.YT);
        };

        const interval = setInterval(() => {
            if (window.YT && window.YT.Player) {
                clearInterval(interval);
                resolve(window.YT);
            }
        }, 100);
        setTimeout(() => clearInterval(interval), 10000);
    });
}

export interface SubtitleBlock {
    id: string;
    start: number; // in ms
    end: number;   // in ms
    text: string;
    isLocked?: boolean;
}

export type CaptionStyle = 'standard' | 'pop' | 'karaoke' | 'neon';
export type ShiftScope = 'from_selected' | 'all' | 'from_time' | 'selected_only';

export interface DetectedTimingJump {
    fromIndex: number;
    toIndex: number;
    fromBlock: SubtitleBlock;
    toBlock: SubtitleBlock;
    gapMs: number;
    gapFormatted: string;
}

// Parses inputs like "-10m", "-10min", "-600", "12.5", "-10:00", "-00:10:00", "+5m" into milliseconds
export const parseOffsetStringToMs = (input: string): number => {
    const trimmed = input.trim();
    if (!trimmed) return 0;
    
    const minMatch = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*m(?:in)?$/i);
    if (minMatch) {
        return Math.round(parseFloat(minMatch[1]) * 60 * 1000);
    }

    const secMatch = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*s(?:ec)?$/i);
    if (secMatch) {
        return Math.round(parseFloat(secMatch[1]) * 1000);
    }

    const isNegative = trimmed.startsWith('-');
    const cleanTc = trimmed.replace(/^[+-]/, '');
    const tcParts = cleanTc.split(':');
    if (tcParts.length === 3) {
        const [h, m, sWithMs] = tcParts;
        const [s, ms] = sWithMs.replace(',', '.').split('.');
        const totalMs = (parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 + (ms ? parseInt(ms.padEnd(3, '0').slice(0, 3), 10) : 0);
        return isNegative ? -totalMs : totalMs;
    } else if (tcParts.length === 2) {
        const [m, sWithMs] = tcParts;
        const [s, ms] = sWithMs.replace(',', '.').split('.');
        const totalMs = (parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000 + (ms ? parseInt(ms.padEnd(3, '0').slice(0, 3), 10) : 0);
        return isNegative ? -totalMs : totalMs;
    }

    const rawVal = parseFloat(trimmed);
    if (!isNaN(rawVal)) {
        return Math.round(rawVal * 1000);
    }
    return 0;
};

export const findTimingJumps = (blocksList: SubtitleBlock[], minGapMs: number = 20000): DetectedTimingJump[] => {
    const jumps: DetectedTimingJump[] = [];
    if (!blocksList || blocksList.length === 0) return jumps;
    const sorted = [...blocksList].sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length - 1; i++) {
        const gap = sorted[i + 1].start - sorted[i].end;
        if (gap >= minGapMs) {
            const minutes = Math.floor(gap / 60000);
            const seconds = Math.floor((gap % 60000) / 1000);
            const gapFormatted = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            jumps.push({
                fromIndex: i,
                toIndex: i + 1,
                fromBlock: sorted[i],
                toBlock: sorted[i + 1],
                gapMs: gap,
                gapFormatted
            });
        }
    }
    return jumps;
};

interface YouTubeSubtitleTimelineEditorProps {
    initialContent: string;
    youtubeUrl: string | null;
    autoPlayTrigger?: number;
    onContentChange?: (content: string) => void;
    onYoutubeUrlChange?: (url: string) => void;
    apiKey?: string;
}

// Resilient SRT/VTT/XML/JSON3 parser and generator
const parseSrt = (srt: string): SubtitleBlock[] => {
    if (!srt || srt.trim() === '') return [];
    const universalBlocks = parseSubtitles(srt);
    if (universalBlocks.length > 0) return universalBlocks;
    
    const blocks: SubtitleBlock[] = [];
    const chunks = srt.trim().split(/\r?\n\s*\r?\n/);
    
    for (const chunk of chunks) {
        const lines = chunk.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length < 2) continue;

        let timeLineIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('-->')) {
                timeLineIdx = i;
                break;
            }
        }
        if (timeLineIdx === -1) continue;

        const timeLine = lines[timeLineIdx];
        let textLines = lines.slice(timeLineIdx + 1).join('\n');
        textLines = textLines.replace(/\.$/, '').trim();

        const timeMatch = timeLine.match(/(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[.,](\d{1,3})/);
        if (timeMatch) {
            const start = (parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseInt(timeMatch[3], 10)) * 1000 + parseInt(timeMatch[4].padEnd(3, '0').slice(0, 3), 10);
            const end = (parseInt(timeMatch[5], 10) * 3600 + parseInt(timeMatch[6], 10) * 60 + parseInt(timeMatch[7], 10)) * 1000 + parseInt(timeMatch[8].padEnd(3, '0').slice(0, 3), 10);
            
            blocks.push({
                id: Math.random().toString(36).substring(7),
                start,
                end: Math.max(start + 100, end),
                text: textLines
            });
        } else {
            const mmssMatch = timeLine.match(/(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2})[.,](\d{1,3})/);
            if (mmssMatch) {
                const start = (parseInt(mmssMatch[1], 10) * 60 + parseInt(mmssMatch[2], 10)) * 1000 + parseInt(mmssMatch[3].padEnd(3, '0').slice(0, 3), 10);
                const end = (parseInt(mmssMatch[4], 10) * 60 + parseInt(mmssMatch[5], 10)) * 1000 + parseInt(mmssMatch[6].padEnd(3, '0').slice(0, 3), 10);
                blocks.push({
                    id: Math.random().toString(36).substring(7),
                    start,
                    end: Math.max(start + 100, end),
                    text: textLines
                });
            }
        }
    }
    return blocks.sort((a, b) => a.start - b.start);
};

const formatTimeSrt = (ms: number): string => {
    const d = new Date(ms);
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    const msStr = String(d.getUTCMilliseconds()).padStart(3, '0');
    return `${h}:${m}:${s},${msStr}`;
};

const generateSrt = (blocks: SubtitleBlock[]): string => {
    return blocks.map((block, i) => `${i + 1}\n${formatTimeSrt(block.start)} --> ${formatTimeSrt(block.end)}\n${block.text}`).join('\n\n');
};

const formatTimeWithMs = (ms: number): string => {
    const totalSeconds = Math.max(0, ms) / 1000;
    const h = Math.floor(totalSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const s = Math.floor(totalSeconds % 60).toString().padStart(2, '0');
    const fraction = Math.floor(Math.max(0, ms) % 1000).toString().padStart(3, '0');
    return `${h}:${m}:${s}.${fraction}`;
};

const formatTime = formatTimeWithMs;

export const YouTubeSubtitleTimelineEditor: React.FC<YouTubeSubtitleTimelineEditorProps> = ({ 
    initialContent, 
    youtubeUrl, 
    autoPlayTrigger, 
    onContentChange, 
    onYoutubeUrlChange, 
    apiKey 
}) => {
    const [blocksState, setBlocksState] = useState<SubtitleBlock[]>([]);
    const blocks = blocksState;
    const [showExportModal, setShowExportModal] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draggingId, setDraggingId] = useState<string | null>(null);

    const [currentTime, setCurrentTime] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [duration, setDuration] = useState(0);
    const [playbackRate, setPlaybackRate] = useState<number>(1);
    const [zoom, setZoom] = useState(100);
    const [pinchZoomFeedback, setPinchZoomFeedback] = useState<number | null>(null);
    const [dragMode, setDragMode] = useState<'normal' | 'sync'>('normal');
    const [moveModeId, setMoveModeId] = useState<string | null>(null);
    const [editBoxMode, setEditBoxMode] = useState<'split' | 'raw'>('split');
    const [quickTranslatingLine, setQuickTranslatingLine] = useState<'l1' | 'l2' | null>(null);
    const [isEditingText, setIsEditingText] = useState(false);
    const [showFrameTranslate, setShowFrameTranslate] = useState(false);
    const [isSyncingTranslation, setIsSyncingTranslation] = useState<false | 'line1' | 'line2' | 'all'>(false);
    const [isVisionFixing, setIsVisionFixing] = useState(false);
    const [isAudioFixing, setIsAudioFixing] = useState(false);
    const [uploadedFileUri, setUploadedFileUri] = useState<string | null>(null);
    const [isUploadingMedia, setIsUploadingMedia] = useState(false);
    const [editorNotification, setEditorNotification] = useState<string | null>(null);
    const [showClearConfirm, setShowClearConfirm] = useState(false);

    const [localYoutubeUrl, setLocalYoutubeUrl] = useState<string | null>(youtubeUrl || null);
    const [showYoutubeInputModal, setShowYoutubeInputModal] = useState(false);
    const [youtubeInputVal, setYoutubeInputVal] = useState(youtubeUrl || '');
    const [youtubeError, setYoutubeError] = useState(false);
    const [isPlayerReady, setIsPlayerReady] = useState(false);
    const [isFetchingYoutubeAssets, setIsFetchingYoutubeAssets] = useState(false);
    const [youtubeAssetReport, setYoutubeAssetReport] = useState<{ title: string; message: string; hlsUrl: string | null; dashUrl: string | null } | null>(null);
    const lastAutoPlayTriggerRef = useRef<number>(0);

    const ytContainerId = useMemo(() => `yt_iframe_${Math.random().toString(36).substring(2, 9)}`, []);
    const ytPlayerRef = useRef<any>(null);

    const effectiveYoutubeUrl = localYoutubeUrl || youtubeUrl;
    const youtubeVideoId = useMemo(() => {
        if (!effectiveYoutubeUrl) return null;
        const { videoId } = normalizeYoutubeUrl(effectiveYoutubeUrl);
        return videoId;
    }, [effectiveYoutubeUrl]);

    // Auto-dismiss editor notification
    useEffect(() => {
        if (editorNotification) {
            const timer = setTimeout(() => {
                setEditorNotification(null);
            }, 3500);
            return () => clearTimeout(timer);
        }
    }, [editorNotification]);

    const updateSelectedText = (text: string) => {
        if (selectedId) {
            setBlocksAndNotify(prev => prev.map(b => b.id === selectedId ? { ...b, text } : b));
        }
    };

    const handleSyncTranslation = async (direction?: 'line1' | 'line2') => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !selectedBlock.text || !effectiveKey) {
            if (!effectiveKey) setEditorNotification("Gemini API Key required for translation sync. Check Settings -> API Vault");
            return;
        }

        setIsSyncingTranslation(direction || 'all');
        try {
            const updatedText = await syncSubtitleTranslations(selectedBlock.text, effectiveKey, direction);
            if (updatedText) {
                updateSelectedText(updatedText);
                setEditorNotification(direction ? `Translation synced from ${direction === 'line1' ? 'Line 1' : 'Line 2'}` : "Translation synced & formatted");
            }
        } catch (e: any) {
            console.error("Translation sync failed:", e);
            setEditorNotification(`Translation sync failed: ${e?.message || 'Error'}`);
        } finally {
            setIsSyncingTranslation(false);
        }
    };

    const handleQuickTranslate = async (sourceLine: 'l1' | 'l2') => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !effectiveKey) {
            setEditorNotification("Gemini API Key required for quick translation");
            return;
        }

        const lines = (selectedBlock.text || '').split('\n');
        const l1 = lines[0] || '';
        const l2 = lines.slice(1).join('\n') || '';
        const targetLang = localStorage.getItem('ai_sub_tgt_lang') || 'English';

        setQuickTranslatingLine(sourceLine);
        try {
            if (sourceLine === 'l1') {
                if (!l1.trim()) return;
                const translated = await translateSingleLine(l1, targetLang, effectiveKey);
                if (translated) {
                    updateSelectedText(`${l1.trim()}\n${translated}`);
                    setEditorNotification(`Translation synced to Line 2 ⚡ (${targetLang})`);
                }
            } else {
                if (!l2.trim()) return;
                const sourceLang = localStorage.getItem('ai_sub_src_lang') || 'Auto-detect';
                const nativeLang = (sourceLang !== 'Auto-detect' && sourceLang) ? sourceLang : 'native';
                const translated = await translateSingleLine(l2, nativeLang, effectiveKey);
                if (translated) {
                    updateSelectedText(`${translated}\n${l2.trim()}`);
                    setEditorNotification(`Native text synced to Line 1 ⚡`);
                }
            }
        } catch (err: any) {
            console.error("Quick translate failed:", err);
            setEditorNotification(`Quick translate error: ${err?.message || 'Failed'}`);
        } finally {
            setQuickTranslatingLine(null);
        }
    };

    const handleVisionFix = async (mode: 'video' | 'frame' = 'frame') => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !effectiveKey) {
            if (!effectiveKey) setEditorNotification("Gemini API Key required for vision fix. Check Settings -> API Vault");
            return;
        }

        setIsVisionFixing(true);
        try {
            let updatedText = '';

            if (mode === 'frame') {
                setEditorNotification("Requesting screen frame for Vision analysis...");
                let base64 = '';
                try {
                    const screenCapture = await captureScreenFrame();
                    base64 = typeof screenCapture === 'string' ? screenCapture : (screenCapture as any)?.base64;
                } catch (screenErr) {
                    console.warn("Direct screen capture cancelled or unavailable:", screenErr);
                    setShowFrameTranslate(true);
                    setIsVisionFixing(false);
                    return;
                }

                if (!base64) {
                    setEditorNotification("Could not capture frame. Opening Vision...");
                    setShowFrameTranslate(true);
                    setIsVisionFixing(false);
                    return;
                }

                setEditorNotification("Analyzing frame with Gemini Vision...");
                updatedText = await fixSubtitleWithFrame(selectedBlock.text, base64, effectiveKey);
            } else {
                let fileUriToUse = '';
                if (uploadedFileUri) {
                    fileUriToUse = uploadedFileUri;
                } else if (effectiveYoutubeUrl) {
                    setEditorNotification("Acquiring YouTube video stream for Gemini analysis...");
                    setIsUploadingMedia(true);
                    try {
                        const downloadedVid = await downloadYouTubeMediaStream(effectiveYoutubeUrl, '360');
                        fileUriToUse = await uploadVideoToGemini(downloadedVid, effectiveKey);
                        setUploadedFileUri(fileUriToUse);
                    } catch (streamErr: any) {
                        console.warn("YouTube video stream error:", streamErr);
                        setEditorNotification("YouTube video stream unavailable. Opening Vision...");
                        setShowFrameTranslate(true);
                        setIsVisionFixing(false);
                        setIsUploadingMedia(false);
                        return;
                    } finally {
                        setIsUploadingMedia(false);
                    }
                } else {
                    setEditorNotification("Video source required for Vision Fix");
                    setIsVisionFixing(false);
                    return;
                }

                setEditorNotification("Agentic Video analyzing... (scrubbing timestamp)");
                updatedText = await fixSubtitleWithAgenticVideo(
                    selectedBlock.text,
                    fileUriToUse,
                    selectedBlock.start / 1000,
                    selectedBlock.end / 1000,
                    effectiveKey
                );
            }

            if (updatedText && updatedText !== selectedBlock.text) {
                updateSelectedText(updatedText);
                setEditorNotification(`Text adjusted by Agentic ${mode === 'frame' ? 'Vision (Frame)' : 'Video'}`);
            } else {
                setEditorNotification("No adjustments deemed necessary");
            }
        } catch (e: any) {
            console.error("Vision fix failed:", e);
            setEditorNotification(`Agentic Vision failed: ${e?.message || 'Error'}`);
        } finally {
            setIsVisionFixing(false);
            setIsUploadingMedia(false);
        }
    };

    const handleHearFix = async () => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !effectiveKey) {
            if (!effectiveKey) setEditorNotification("Gemini API Key required for audio fix. Check Settings -> API Vault");
            return;
        }

        setIsAudioFixing(true);
        try {
            let fileUriToUse = '';
            if (uploadedFileUri) {
                fileUriToUse = uploadedFileUri;
            } else if (effectiveYoutubeUrl) {
                setEditorNotification("Acquiring YouTube audio stream for Agentic Audio...");
                setIsUploadingMedia(true);
                try {
                    const downloadedAud = await downloadYouTubeMediaStream(effectiveYoutubeUrl, 'audio');
                    fileUriToUse = await uploadVideoToGemini(downloadedAud, effectiveKey);
                    setUploadedFileUri(fileUriToUse);
                } catch (streamErr: any) {
                    console.warn("YouTube audio stream error:", streamErr);
                    setEditorNotification("YouTube audio stream unavailable for Agentic Audio");
                    setIsAudioFixing(false);
                    setIsUploadingMedia(false);
                    return;
                } finally {
                    setIsUploadingMedia(false);
                }
            } else {
                setEditorNotification("Audio source required for Hear Fix");
                setIsAudioFixing(false);
                return;
            }

            setEditorNotification("Agentic Audio analyzing... (listening closely)");
            const updatedText = await fixSubtitleWithAudio(
                selectedBlock.text,
                fileUriToUse,
                selectedBlock.start / 1000,
                selectedBlock.end / 1000,
                effectiveKey
            );

            if (updatedText && updatedText !== selectedBlock.text) {
                updateSelectedText(updatedText);
                setEditorNotification("Text adjusted by Agentic Audio");
            } else {
                setEditorNotification("No adjustments deemed necessary");
            }
        } catch (e: any) {
            console.error("Audio fix failed:", e);
            setEditorNotification(`Agentic Audio failed: ${e?.message || 'Error'}`);
        } finally {
            setIsAudioFixing(false);
            setIsUploadingMedia(false);
        }
    };

    // Initialize Native YouTube IFrame API Player
    useEffect(() => {
        if (!youtubeVideoId) {
            if (ytPlayerRef.current) {
                try { ytPlayerRef.current.destroy(); } catch (e) {}
                ytPlayerRef.current = null;
            }
            setIsPlayerReady(false);
            return;
        }

        let isCancelled = false;
        loadYouTubeIframeApi().then((YT) => {
            if (isCancelled || !document.getElementById(ytContainerId)) return;

            if (ytPlayerRef.current) {
                try {
                    if (typeof ytPlayerRef.current.loadVideoById === 'function') {
                        ytPlayerRef.current.loadVideoById(youtubeVideoId);
                        return;
                    }
                    ytPlayerRef.current.destroy();
                } catch (e) {}
                ytPlayerRef.current = null;
            }

            try {
                const player = new YT.Player(ytContainerId, {
                    videoId: youtubeVideoId,
                    width: '100%',
                    height: '100%',
                    playerVars: {
                        autoplay: 1,
                        controls: 1,
                        modestbranding: 1,
                        rel: 0,
                        playsinline: 1,
                        enablejsapi: 1,
                        origin: typeof window !== 'undefined' ? window.location.origin : undefined
                    },
                    events: {
                        onReady: (event: any) => {
                            if (isCancelled) return;
                            ytPlayerRef.current = event.target;
                            setIsPlayerReady(true);
                            setYoutubeError(false);
                            try {
                                const dur = event.target.getDuration();
                                if (dur && dur > 0) setDuration(dur * 1000);
                            } catch (e) {}
                        },
                        onStateChange: (event: any) => {
                            if (isCancelled) return;
                            // YT.PlayerState: 1 = PLAYING, 2 = PAUSED, 0 = ENDED, 3 = BUFFERING
                            if (event.data === 1) {
                                setIsPlaying(true);
                            } else if (event.data === 2 || event.data === 0) {
                                setIsPlaying(false);
                            }
                        },
                        onError: (err: any) => {
                            if (isCancelled) return;
                            console.error('[Native YouTube IFrame] Playback error code:', err?.data);
                            setYoutubeError(true);
                            setIsPlaying(false);
                        }
                    }
                });
                ytPlayerRef.current = player;
            } catch (err) {
                console.error('[Native YouTube IFrame] Initialization error:', err);
                setYoutubeError(true);
            }
        });

        return () => {
            isCancelled = true;
            if (ytPlayerRef.current) {
                try { ytPlayerRef.current.destroy(); } catch (e) {}
                ytPlayerRef.current = null;
            }
            setIsPlayerReady(false);
        };
    }, [youtubeVideoId, ytContainerId]);

    useEffect(() => {
        if (youtubeUrl) {
            setLocalYoutubeUrl(youtubeUrl);
            setYoutubeInputVal(youtubeUrl);
            setYoutubeError(false);
            setIsPlaying(true);
        }
    }, [youtubeUrl]);

    useEffect(() => {
        if (autoPlayTrigger && autoPlayTrigger !== lastAutoPlayTriggerRef.current) {
            lastAutoPlayTriggerRef.current = autoPlayTrigger;
            setIsPlaying(true);
            setYoutubeError(false);
            if (ytPlayerRef.current && typeof ytPlayerRef.current.playVideo === 'function') {
                try { ytPlayerRef.current.playVideo(); } catch (e) {}
            }
        }
    }, [autoPlayTrigger]);

    useEffect(() => {
        if (ytPlayerRef.current && typeof ytPlayerRef.current.setPlaybackRate === 'function') {
            try { ytPlayerRef.current.setPlaybackRate(playbackRate); } catch (e) {}
        }
    }, [playbackRate]);

    const [isGeneratingYtSubtitles, setIsGeneratingYtSubtitles] = useState(false);

    const handleFetchYouTubeAssets = async () => {
        if (!effectiveYoutubeUrl || isFetchingYoutubeAssets) return;
        setIsFetchingYoutubeAssets(true);
        setSnapNotification("Fetching official YouTube captions and inspecting available manifest links...");
        let loadedCount = 0;
        try {
            // Import native CC as soon as that request finishes; manifest resolution can take longer.
            const captionPromise = fetchYouTubeCaptions(effectiveYoutubeUrl, 'English').then(captionData => {
                if (captionData.success && (captionData.rawSrt || captionData.segments?.length)) {
                    const rawSrt = captionData.rawSrt || segmentsToSrt(captionData.segments || []);
                    const parsed = parseSrt(rawSrt);
                    if (parsed.length > 0) {
                        loadedCount = parsed.length;
                        setBlocksAndNotify(parsed);
                    }
                }
                return captionData;
            });
            const mediaPromise = fetchYouTubeManifestDetails(effectiveYoutubeUrl);
            const [captionResult, mediaResult] = await Promise.allSettled([captionPromise, mediaPromise]);

            const captionData = captionResult.status === 'fulfilled' ? captionResult.value : null;
            const mediaData = mediaResult.status === 'fulfilled' ? mediaResult.value : null;
            const hlsUrl = mediaData?.hlsUrl || null;
            const dashUrl = mediaData?.dashUrl || null;
            const reportMessages: string[] = [];

            if (loadedCount > 0) {
                reportMessages.push(`Loaded ${loadedCount} timed cues from native YouTube captions (${captionData?.language || 'source language'}).`);
            } else if (captionResult.status === 'rejected') {
                const error = captionResult.reason;
                reportMessages.push(`Caption retrieval failed: ${error instanceof Error ? error.message : String(error)}`);
            } else {
                reportMessages.push(captionData?.message || "No accessible official YouTube caption track was returned. Use Generate Subtitle for AI audio transcription.");
            }

            if (mediaData?.success) {
                reportMessages.push(mediaData.message || (
                    hlsUrl || dashUrl
                        ? `Manifest discovery completed: ${[hlsUrl ? 'HLS' : '', dashUrl ? 'DASH' : ''].filter(Boolean).join(' + ')}.`
                        : "No HLS/DASH manifest URL was returned by the available YouTube providers for this video."
                ));
            } else if (mediaData) {
                reportMessages.push(mediaData.message || 'Manifest lookup did not return a result.');
            } else if (mediaResult.status === 'rejected') {
                const error = mediaResult.reason;
                reportMessages.push(`Manifest inspection failed: ${error instanceof Error ? error.message : String(error)}`);
            }

            setYoutubeAssetReport({
                title: mediaData?.title || captionData?.title || 'YouTube source inspection',
                message: reportMessages.join(' '),
                hlsUrl,
                dashUrl
            });
            setSnapNotification(loadedCount > 0
                ? `Fetched ${loadedCount} native YouTube subtitle cues. Manifest details are shown below the toolbar.`
                : "YouTube source inspection finished. See the result panel below the toolbar.");
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            setSnapNotification(`Could not fetch YouTube captions or manifests: ${detail}`);
        } finally {
            setIsFetchingYoutubeAssets(false);
        }
    };

    const copyYouTubeManifestUrl = async (url: string, label: string) => {
        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.');
            await navigator.clipboard.writeText(url);
            setSnapNotification(`${label} manifest URL copied.`);
        } catch {
            setSnapNotification(`Copy unavailable. The full ${label} URL is displayed in the manifest panel.`);
        }
    };

    const handleGenerateYouTubeSubtitles = async () => {
        if (!effectiveYoutubeUrl) return;
        setIsGeneratingYtSubtitles(true);
        setSnapNotification("AI is inspecting YouTube video and generating subtitles...");
        try {
            const effectiveApiKey = apiKey || localStorage.getItem('gemini_api_key') || undefined;
            const srt = await generateYouTubeSRT(effectiveYoutubeUrl, {
                apiKey: effectiveApiKey,
                mode: 'ori',
                targetLang: 'English',
                onProgress: (p) => {
                    setSnapNotification(`AI Subtitle Generation: ${p}%`);
                }
            });

            if (srt && srt.trim()) {
                const parsed = parseSrt(srt);
                if (parsed.length > 0) {
                    setBlocksAndNotify(parsed);
                    setSnapNotification(`Generated ${parsed.length} subtitles from YouTube video!`);
                } else {
                    setSnapNotification("No subtitle blocks parsed. Please check the video.");
                }
            } else {
                setSnapNotification("AI was unable to generate subtitles for this YouTube video.");
            }
        } catch (err: any) {
            console.error('[YouTube SRT] Generation error:', err);
            let msg = err?.message || 'Error generating subtitles.';
            if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
                msg = "Gemini API Quota Exceeded (429). Please wait a moment or verify your Gemini API key in Settings.";
            } else if (msg.includes('403') || msg.includes('PERMISSION_DENIED')) {
                msg = "Gemini API Permission Denied (403). Please verify your Gemini API key in Settings.";
            }
            setSnapNotification(msg);
        } finally {
            setIsGeneratingYtSubtitles(false);
        }
    };

    const handleApplyYoutubeUrl = (url: string) => {
        const raw = (url || '').trim();
        const { url: clean, videoId, isValid } = normalizeYoutubeUrl(raw);

        if (!isValid || !clean) {
            setSnapNotification("Invalid YouTube link: " + (raw || 'empty'));
            return;
        }

        setLocalYoutubeUrl(clean);
        setYoutubeAssetReport(null);
        setYoutubeError(false);
        setIsPlaying(true);
        if (onYoutubeUrlChange) {
            onYoutubeUrlChange(clean);
        }
        setShowYoutubeInputModal(false);
        setSnapNotification(videoId ? `YouTube Loaded (${videoId})` : 'Video Loaded');
    };

    const [dragHUD, setDragHUD] = useState<{
        id: string;
        type: 'move' | 'sync_move' | 'start' | 'sync_start' | 'end' | 'sync_end';
        deltaMs: number;
        newStart: number;
        newEnd: number;
        initStart: number;
        initEnd: number;
        atMinBound: boolean;
        atMaxBound: boolean;
        gapBefore: number | null;
        gapAfter: number | null;
        boundaryReason: string | null;
    } | null>(null);
    
    useEffect(() => {
        setMoveModeId(null);
        if (!selectedId) {
            setIsEditingText(false);
        }
    }, [selectedId]);
    
    // Preview Settings
    const [previewSize, setPreviewSize] = useState(() => {
        const saved = localStorage.getItem('vlog_previewSize');
        return saved ? Number(saved) : 24;
    });
    const [previewPosition, setPreviewPosition] = useState(() => {
        const saved = localStorage.getItem('vlog_previewPosition');
        return saved ? Number(saved) : 10;
    });
    const [captionStyle, setCaptionStyle] = useState<CaptionStyle>(() => {
        const saved = localStorage.getItem('vlog_captionStyle');
        return (saved as CaptionStyle) || 'standard';
    });
    
    useEffect(() => {
        localStorage.setItem('vlog_previewSize', previewSize.toString());
    }, [previewSize]);
    
    useEffect(() => {
        localStorage.setItem('vlog_previewPosition', previewPosition.toString());
    }, [previewPosition]);
    
    useEffect(() => {
        localStorage.setItem('vlog_captionStyle', captionStyle);
    }, [captionStyle]);

    const [showPreviewSettings, setShowPreviewSettings] = useState(false);
    const [showSyncSettings, setShowSyncSettings] = useState(false);
    const [syncScope, setSyncScope] = useState<ShiftScope>('all');
    const [syncFromTimeInput, setSyncFromTimeInput] = useState<string>('');
    const [showExtractSettings, setShowExtractSettings] = useState(false);
    const [extractStart, setExtractStart] = useState<number>(0);
    const [extractEnd, setExtractEnd] = useState<number>(0);

    const [snapNotification, setSnapNotification] = useState<string | null>(null);
    const detectedJumps = useMemo(() => findTimingJumps(blocks, 20000), [blocks]);
    const [showTextTools, setShowTextTools] = useState(false);

    // Selected Subtitle Action Bar
    const actionBarRef = useRef<HTMLDivElement>(null);
    const [actionBarCanScrollLeft, setActionBarCanScrollLeft] = useState(false);
    const [actionBarCanScrollRight, setActionBarCanScrollRight] = useState(false);
    const isDraggingActionBarRef = useRef(false);
    const actionBarStartXRef = useRef(0);
    const actionBarScrollLeftRef = useRef(0);

    const checkActionBarScroll = useCallback(() => {
        if (actionBarRef.current) {
            const { scrollLeft, scrollWidth, clientWidth } = actionBarRef.current;
            setActionBarCanScrollLeft(scrollLeft > 6);
            setActionBarCanScrollRight(scrollLeft < scrollWidth - clientWidth - 6);
        }
    }, []);

    useEffect(() => {
        checkActionBarScroll();
        const el = actionBarRef.current;
        if (!el) return;
        el.addEventListener('scroll', checkActionBarScroll, { passive: true });
        window.addEventListener('resize', checkActionBarScroll);
        const raf = requestAnimationFrame(checkActionBarScroll);
        return () => {
            el.removeEventListener('scroll', checkActionBarScroll);
            window.removeEventListener('resize', checkActionBarScroll);
            cancelAnimationFrame(raf);
        };
    }, [selectedId, checkActionBarScroll]);

    const scrollActionBar = (direction: 'left' | 'right') => {
        if (actionBarRef.current) {
            actionBarRef.current.scrollBy({
                left: direction === 'left' ? -200 : 200,
                behavior: 'smooth'
            });
        }
    };

    const handleActionBarMouseDown = (e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('button, input, textarea, a')) return;
        isDraggingActionBarRef.current = true;
        if (actionBarRef.current) {
            actionBarStartXRef.current = e.pageX - actionBarRef.current.offsetLeft;
            actionBarScrollLeftRef.current = actionBarRef.current.scrollLeft;
        }
    };

    const handleActionBarMouseMove = (e: React.MouseEvent) => {
        if (!isDraggingActionBarRef.current || !actionBarRef.current) return;
        e.preventDefault();
        const x = e.pageX - actionBarRef.current.offsetLeft;
        const walk = (x - actionBarStartXRef.current) * 1.3;
        actionBarRef.current.scrollLeft = actionBarScrollLeftRef.current - walk;
    };

    const handleActionBarMouseUpOrLeave = () => {
        isDraggingActionBarRef.current = false;
    };

    useEffect(() => {
        if (snapNotification) {
            const timer = setTimeout(() => {
                setSnapNotification(null);
            }, 3500);
            return () => clearTimeout(timer);
        }
    }, [snapNotification]);
    
    const extractSegment = () => {
        const startMs = Math.round(extractStart * 1000);
        const endMs = extractEnd > extractStart ? Math.round(extractEnd * 1000) : duration;
        
        setBlocksAndNotify(prev => {
            const filtered = prev.filter(b => b.end > startMs && b.start < endMs);
            return filtered.map(b => ({
                ...b,
                start: Math.max(0, b.start - startMs),
                end: Math.max(0, Math.min(b.end - startMs, endMs - startMs))
            }));
        });
        
        setShowExtractSettings(false);
    };

    const shiftSubtitles = (
        offsetMs: number,
        scope: ShiftScope = syncScope,
        targetBlockId: string | null = selectedId,
        customFromMs?: number
    ) => {
        if (offsetMs === 0) return;

        setBlocksAndNotify(prev => {
            const sorted = [...prev].sort((a, b) => a.start - b.start);
            const selectedIdx = targetBlockId ? sorted.findIndex(b => b.id === targetBlockId) : -1;

            let shiftedCount = 0;
            const updated = sorted.map((block, idx) => {
                let shouldShift = false;
                if (scope === 'all') {
                    shouldShift = true;
                } else if (scope === 'from_selected') {
                    shouldShift = selectedIdx !== -1 && idx >= selectedIdx;
                } else if (scope === 'selected_only') {
                    shouldShift = block.id === targetBlockId;
                } else if (scope === 'from_time') {
                    const cutoff = customFromMs !== undefined ? customFromMs : parseOffsetStringToMs(syncFromTimeInput);
                    shouldShift = block.start >= cutoff;
                }

                if (!shouldShift) return block;

                shiftedCount++;
                const newStart = Math.max(0, block.start + offsetMs);
                const newEnd = Math.max(newStart + 100, block.end + offsetMs);
                return {
                    ...block,
                    start: newStart,
                    end: newEnd
                };
            }).sort((a, b) => a.start - b.start);

            const sText = (Math.abs(offsetMs) / 1000).toFixed(1);
            const dir = offsetMs > 0 ? `forward by +${sText}s` : `backward by -${sText}s`;
            setSnapNotification(`Shifted ${shiftedCount} subtitle${shiftedCount !== 1 ? 's' : ''} ${dir}`);
            return updated;
        });
    };

    const [containerWidth, setContainerWidth] = useState(0);
    const timelineRef = useRef<HTMLDivElement>(null);
    const trackContainerRef = useRef<HTMLDivElement>(null);
    const currentTimeTextRef = useRef<HTMLDivElement>(null);
    const lastVideoSeekRef = useRef<number>(0);
    const lastUserSeekTimeRef = useRef<number>(0);
    const lastSavedSessionTimeRef = useRef<number>(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const appendInputRef = useRef<HTMLInputElement>(null);
    const mediaRef = useRef<any>(null);
    const playerContainerRef = useRef<HTMLDivElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [videoHeightMode, setVideoHeightMode] = useState<'normal' | 'large'>('normal');

    // Echo Guard: Prevents delayed async YouTube iframe progress events from overriding user drag
    const isSeekingOrDragging = useCallback(() => {
        return dragState.current.type !== null || (performance.now() - lastUserSeekTimeRef.current < 350);
    }, []);

    // Authoritative YouTube IFrame Player Seek Function
    const seekTo = useCallback((ms: number, throttleVideo: boolean = false) => {
        lastUserSeekTimeRef.current = performance.now();
        const clampedMs = Math.max(0, ms);
        const sec = clampedMs / 1000;

        if (ytPlayerRef.current) {
            const now = performance.now();
            if (!throttleVideo || now - lastVideoSeekRef.current > 50) {
                if (typeof ytPlayerRef.current.seekTo === 'function') {
                    try { ytPlayerRef.current.seekTo(sec, true); } catch (e) {}
                }
                lastVideoSeekRef.current = now;
            }
        }
        
        setCurrentTime(clampedMs); // Always update React state instantly for 60fps responsive UI
        
        const mediaId = effectiveYoutubeUrl || 'default';
        sessionStorage.setItem(`media_time_${mediaId}`, clampedMs.toString());
    }, [effectiveYoutubeUrl]);

    // Dedicated Manual "Sync YT" Action Button
    const handleSyncYT = useCallback(() => {
        if (!ytPlayerRef.current) {
            setSnapNotification("YouTube IFrame player is initializing...");
            return;
        }
        let curSec: number | null = null;
        if (typeof ytPlayerRef.current.getCurrentTime === 'function') {
            try { curSec = ytPlayerRef.current.getCurrentTime(); } catch (e) {}
        }
        if (typeof curSec === 'number' && !isNaN(curSec) && curSec >= 0) {
            const ms = Math.round(curSec * 1000);
            setCurrentTime(ms);
            setSnapNotification(`Synced timeline to YouTube IFrame: ${formatTimeWithMs(ms)}`);
        } else {
            setSnapNotification("Could not read YouTube IFrame timestamp. Ensure video is playing or ready.");
        }
    }, []);

    const toggleFullscreen = useCallback(() => {
        if (!document.fullscreenElement) {
            playerContainerRef.current?.requestFullscreen().catch(err => {
                console.warn(`Fullscreen request notice: ${err?.message || err}`);
            });
        } else {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            }
        }
    }, []);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    const lastGeneratedSrt = useRef<string | null>(null);
    const pendingSrtUpdates = useRef<Set<string>>(new Set());
    
    const latestBlocksRef = useRef(blocksState);
    latestBlocksRef.current = blocksState;

    const notifyChange = useCallback((blocks: SubtitleBlock[]) => {
        if (onContentChange) {
            const srt = generateSrt(blocks);
            lastGeneratedSrt.current = srt;
            pendingSrtUpdates.current.add(srt);
            if (pendingSrtUpdates.current.size > 20) {
                const iterator = pendingSrtUpdates.current.values();
                pendingSrtUpdates.current.delete(iterator.next().value);
            }
            onContentChange(srt);
        }
    }, [onContentChange]);

    const historyRef = useRef<{ states: SubtitleBlock[][], index: number }>({ states: [], index: -1 });
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);

    const updateHistoryState = useCallback(() => {
        setCanUndo(historyRef.current.index > 0);
        setCanRedo(historyRef.current.index < historyRef.current.states.length - 1);
    }, []);

    const pushToHistory = useCallback((newBlocks: SubtitleBlock[]) => {
        const { states, index } = historyRef.current;
        const currentBlocks = states[index];
        if (currentBlocks && JSON.stringify(currentBlocks) === JSON.stringify(newBlocks)) {
            return;
        }
        const newStates = states.slice(0, index + 1);
        newStates.push([...newBlocks]);
        if (newStates.length > 50) newStates.shift();
        historyRef.current = {
            states: newStates,
            index: newStates.length - 1
        };
        updateHistoryState();
    }, [updateHistoryState]);

    const handleUndo = useCallback(() => {
        if (historyRef.current.index > 0) {
            historyRef.current.index -= 1;
            const state = historyRef.current.states[historyRef.current.index];
            setBlocksState(state);
            setTimeout(() => notifyChange(state), 0);
            updateHistoryState();
        }
    }, [updateHistoryState, notifyChange]);

    const handleRedo = useCallback(() => {
        if (historyRef.current.index < historyRef.current.states.length - 1) {
            historyRef.current.index += 1;
            const state = historyRef.current.states[historyRef.current.index];
            setBlocksState(state);
            setTimeout(() => notifyChange(state), 0);
            updateHistoryState();
        }
    }, [updateHistoryState, notifyChange]);

    const setBlocksAndNotify = useCallback((newBlocks: SubtitleBlock[] | ((prev: SubtitleBlock[]) => SubtitleBlock[])) => {
        setBlocksState(prev => {
            const next = typeof newBlocks === 'function' ? newBlocks(prev) : newBlocks;
            pushToHistory(next);
            setTimeout(() => notifyChange(next), 0);
            return next;
        });
    }, [notifyChange, pushToHistory]);

    const clearSubtitles = useCallback(() => {
        setShowClearConfirm(true);
    }, []);

    const handleNudge = useCallback((deltaMs: number) => {
        if (!selectedId) return;
        const block = latestBlocksRef.current.find(b => b.id === selectedId);
        if (!block) return;
        if (block.isLocked) {
            setSnapNotification("This subtitle block is locked. Unlock it to nudge timing.");
            return;
        }

        const sorted = [...latestBlocksRef.current].sort((a, b) => a.start - b.start);
        const blockIndex = sorted.findIndex(b => b.id === selectedId);
        const prevBlock = blockIndex > 0 ? sorted[blockIndex - 1] : null;
        const nextBlock = blockIndex >= 0 && blockIndex < sorted.length - 1 ? sorted[blockIndex + 1] : null;

        const minStartAllowed = prevBlock ? prevBlock.end : 0;
        const maxEndAllowed = nextBlock ? nextBlock.start : Infinity;
        const duration = block.end - block.start;

        let newStart = block.start + deltaMs;
        let newEnd = block.end + deltaMs;

        if (newStart < minStartAllowed) {
            newStart = minStartAllowed;
            newEnd = newStart + duration;
        }
        if (newEnd > maxEndAllowed) {
            newEnd = maxEndAllowed;
            newStart = Math.max(minStartAllowed, newEnd - duration);
        }

        const actualShift = newStart - block.start;
        if (actualShift === 0) {
            setSnapNotification(deltaMs < 0 ? "Cannot move earlier: blocked by previous subtitle or 0s" : "Cannot move later: blocked by next subtitle");
            return;
        }

        setBlocksAndNotify(prev => prev.map(b => b.id === selectedId ? { ...b, start: newStart, end: newEnd } : b).sort((a, b) => a.start - b.start));
        seekTo(newStart, false);
        const sign = actualShift > 0 ? '+' : '';
        setSnapNotification(`Nudged ${sign}${(actualShift / 1000).toFixed(2)}s (${formatTimeWithMs(newStart)} → ${formatTimeWithMs(newEnd)})`);
    }, [selectedId, setBlocksAndNotify, seekTo]);

    // Zoom Constraints
    const minZoom = containerWidth > 0 ? containerWidth / 30 : 10; // 30s view
    const maxZoom = containerWidth > 0 ? containerWidth / 0.2 : 5000; // 0.2s view
    const activeZoom = Math.max(minZoom, Math.min(maxZoom, zoom));
    
    const activeZoomRef = useRef(activeZoom);
    activeZoomRef.current = activeZoom;

    const zoomBoundsRef = useRef({ min: minZoom, max: maxZoom });
    zoomBoundsRef.current = { min: minZoom, max: maxZoom };

    const autoScrollRef = useRef<number | null>(null);
    const pointerClientXRef = useRef<number>(0);
    const pointerEventRef = useRef<PointerEvent | null>(null);
    const lastScrollTimeRef = useRef<number>(0);

    const pinchStateRef = useRef<{
        isPinching: boolean;
        initialDistance: number;
        initialZoom: number;
    }>({
        isPinching: false,
        initialDistance: 0,
        initialZoom: 100
    });
    const justFinishedPinchRef = useRef<boolean>(false);
    const pointersRef = useRef<Map<number, { clientX: number; clientY: number }>>(new Map());
    const pinchFeedbackTimerRef = useRef<any>(null);

    const dragState = useRef<{
        type: 'move' | 'sync_move' | 'start' | 'sync_start' | 'end' | 'sync_end' | 'scrub' | 'select_only' | null;
        id: string | null;
        startX: number;
        initStart: number;
        initEnd: number;
        target?: EventTarget | null;
        pointerId?: number;
        initialBlocks: SubtitleBlock[];
        dragTimelineStart: number;
        targetSeekTime?: number;
    }>({
        type: null, id: null, startX: 0, initStart: 0, initEnd: 0, initialBlocks: [], dragTimelineStart: 0
    });

    useEffect(() => {
        if (initialContent) {
            if (pendingSrtUpdates.current.has(initialContent)) {
                pendingSrtUpdates.current.delete(initialContent);
                return;
            }
            if (initialContent !== lastGeneratedSrt.current) {
                const newBlocks = parseSrt(initialContent);
                setBlocksState(newBlocks);
                lastGeneratedSrt.current = initialContent;
                pendingSrtUpdates.current.clear();
                historyRef.current = { states: [newBlocks], index: 0 };
                updateHistoryState();
            }
        }
    }, [initialContent, updateHistoryState]);

    useEffect(() => {
        if (!timelineRef.current) return;
        const resizeObserver = new ResizeObserver((entries) => {
            if (entries[0]) {
                setContainerWidth(entries[0].contentRect.width);
            }
        });
        resizeObserver.observe(timelineRef.current);
        return () => {
            resizeObserver.disconnect();
            if (autoScrollRef.current) cancelAnimationFrame(autoScrollRef.current);
        };
    }, []);

    // Continuous 60fps synchronization loop specifically for Native YouTube IFrame Player
    useEffect(() => {
        if (!effectiveYoutubeUrl) return;

        let animId: number;
        const syncYoutubeLoop = () => {
            if (ytPlayerRef.current && isPlayerReady) {
                // Sync play/pause state from YouTube IFrame player
                if (typeof ytPlayerRef.current.getPlayerState === 'function') {
                    try {
                        const playerState = ytPlayerRef.current.getPlayerState();
                        // 1 = PLAYING, 2 = PAUSED, 0 = ENDED
                        if (playerState === 1 && !isPlaying) {
                            setIsPlaying(true);
                        } else if ((playerState === 2 || playerState === 0) && isPlaying) {
                            setIsPlaying(false);
                        }
                    } catch (e) {}
                }

                // Continuously stream currentTime from YouTube player to Subtitle Timeline when not actively dragging
                if (!isSeekingOrDragging()) {
                    let curSec: number | null = null;
                    if (typeof ytPlayerRef.current.getCurrentTime === 'function') {
                        try { curSec = ytPlayerRef.current.getCurrentTime(); } catch (e) {}
                    }
                    if (typeof curSec === 'number' && !isNaN(curSec) && curSec >= 0) {
                        const ms = Math.round(curSec * 1000);
                        setCurrentTime(ms);

                        // Throttle session storage save
                        const now = performance.now();
                        if (now - lastSavedSessionTimeRef.current > 1000) {
                            const mediaId = effectiveYoutubeUrl || 'default';
                            sessionStorage.setItem(`media_time_${mediaId}`, ms.toString());
                            lastSavedSessionTimeRef.current = now;
                        }
                    }
                }

                // Synchronize duration if not yet loaded
                if (!duration || duration <= 0) {
                    let durSec: number | null = null;
                    if (typeof ytPlayerRef.current.getDuration === 'function') {
                        try { durSec = ytPlayerRef.current.getDuration(); } catch (e) {}
                    }
                    if (typeof durSec === 'number' && durSec > 0) {
                        setDuration(Math.round(durSec * 1000));
                    }
                }
            }
            animId = requestAnimationFrame(syncYoutubeLoop);
        };

        animId = requestAnimationFrame(syncYoutubeLoop);
        return () => cancelAnimationFrame(animId);
    }, [effectiveYoutubeUrl, isPlaying, duration, isSeekingOrDragging, isPlayerReady]);

    const togglePlay = () => {
        if (ytPlayerRef.current) {
            if (isPlaying) {
                if (typeof ytPlayerRef.current.pauseVideo === 'function') {
                    try { ytPlayerRef.current.pauseVideo(); } catch (e) {}
                }
                setIsPlaying(false);
            } else {
                if (typeof ytPlayerRef.current.playVideo === 'function') {
                    try { ytPlayerRef.current.playVideo(); } catch (e) {}
                }
                setIsPlaying(true);
            }
        } else {
            setIsPlaying(prev => !prev);
        }
    };

    const handlePointerMove = useCallback((e: PointerEvent) => {
        const { type, id, startX, initStart, initEnd, initialBlocks, pointerId } = dragState.current;
        if (!type || e.pointerId !== pointerId) return;
        
        pointerClientXRef.current = e.clientX;
        pointerEventRef.current = e;
        
        if (e.cancelable) {
            e.preventDefault();
        }
        
        const deltaX = e.clientX - startX;
        const deltaMs = (deltaX / activeZoomRef.current) * 1000;
        
        if (type === 'select_only') return;
        
        if (type === 'scrub') {
            const newTime = Math.max(0, initStart - deltaMs);
            if (trackContainerRef.current) {
                const newOffset = (containerWidth / 2) - ((newTime / 1000) * activeZoomRef.current);
                trackContainerRef.current.style.transform = `translateX(${newOffset}px)`;
            }
            if (currentTimeTextRef.current) {
                currentTimeTextRef.current.innerText = formatTimeWithMs(newTime);
            }
            seekTo(newTime, true);
            return;
        }
        
        if (!id) return;
        
        let targetSeekTime: number | null = null;
        
        setBlocksState(prev => {
            if (type === 'sync_move' || type === 'sync_start' || type === 'sync_end') {
                const blockIndex = initialBlocks.findIndex(b => b.id === id);
                if (blockIndex === -1) return prev;
                const MIN_DURATION = 100;

                if (type === 'sync_move') {
                    const prevBlock = blockIndex > 0 ? initialBlocks[blockIndex - 1] : null;
                    const minStartAllowed = prevBlock ? prevBlock.end : 0;
                    
                    let newFirstStart = Math.max(minStartAllowed, initStart + deltaMs);
                    let allowedShift = newFirstStart - initStart;
                    
                    const nearestLockedIdx = initialBlocks.findIndex((b, i) => i > blockIndex && b.isLocked);
                    if (nearestLockedIdx !== -1 && allowedShift > 0) {
                        const maxAllowedShift = initialBlocks[nearestLockedIdx].start - initialBlocks[nearestLockedIdx - 1].end;
                        allowedShift = Math.min(allowedShift, maxAllowedShift);
                    }
                    
                    targetSeekTime = initStart + allowedShift;
                    
                    const atMin = newFirstStart <= minStartAllowed;
                    const atMax = nearestLockedIdx !== -1 && (initStart + allowedShift >= initialBlocks[nearestLockedIdx].start);
                    setDragHUD({
                        id,
                        type: 'sync_move',
                        deltaMs: allowedShift,
                        newStart: initStart + allowedShift,
                        newEnd: initEnd + allowedShift,
                        initStart,
                        initEnd,
                        atMinBound: atMin,
                        atMaxBound: atMax,
                        gapBefore: prevBlock ? Math.max(0, initStart + allowedShift - prevBlock.end) : null,
                        gapAfter: null,
                        boundaryReason: atMin 
                            ? (prevBlock ? `Touches prev: "${(prevBlock.text || '...').slice(0, 12)}"` : 'Audio start (0s)')
                            : atMax 
                                ? `Locked wall: "${(initialBlocks[nearestLockedIdx].text || '...').slice(0, 12)}"`
                                : null
                    });

                    if (allowedShift === 0 && deltaMs === 0) return prev;
                    
                    return initialBlocks.map((block, idx) => {
                        if (idx >= blockIndex && (nearestLockedIdx === -1 || idx < nearestLockedIdx)) {
                            return {
                                ...block,
                                start: block.start + allowedShift,
                                end: block.end + allowedShift
                            };
                        }
                        return block;
                    }).sort((a, b) => a.start - b.start);
                } else if (type === 'sync_start') {
                    const lockedBlocksBefore = initialBlocks.map((b, i) => ({ b, i })).filter(({ b, i }) => i < blockIndex && b.isLocked);
                    const nearestLockedIdx = lockedBlocksBefore.length > 0 ? lockedBlocksBefore[lockedBlocksBefore.length - 1].i : -1;
                    
                    const maxLeftShift = nearestLockedIdx !== -1 
                        ? initialBlocks[nearestLockedIdx].end - initialBlocks[nearestLockedIdx + 1].start
                        : (initialBlocks.length > 0 ? -initialBlocks[0].start : 0);
                        
                    const minStart = Math.max(0, initStart + maxLeftShift);
                    const newStart = Math.min(initEnd - MIN_DURATION, Math.max(minStart, initStart + deltaMs));
                    const allowedShift = newStart - initStart;
                    
                    targetSeekTime = newStart;
                    
                    if (allowedShift === 0 && deltaMs === 0) return prev;
                    
                    return initialBlocks.map((block, idx) => {
                        if (idx === blockIndex) return { ...block, start: newStart };
                        if (idx < blockIndex && idx > nearestLockedIdx) return { ...block, start: block.start + allowedShift, end: block.end + allowedShift };
                        return block;
                    }).sort((a, b) => a.start - b.start);
                } else if (type === 'sync_end') {
                    const nearestLockedIdx = initialBlocks.findIndex((b, i) => i > blockIndex && b.isLocked);
                    
                    let maxRightShift = Infinity;
                    if (nearestLockedIdx !== -1) {
                        maxRightShift = initialBlocks[nearestLockedIdx].start - initialBlocks[nearestLockedIdx - 1].end;
                    }
                    
                    const maxEnd = initEnd + maxRightShift;
                    const newEnd = Math.max(initStart + MIN_DURATION, Math.min(maxEnd, initEnd + deltaMs));
                    const allowedShift = newEnd - initEnd;
                    
                    targetSeekTime = newEnd;
                    
                    if (allowedShift === 0 && deltaMs === 0) return prev;
                    
                    return initialBlocks.map((block, idx) => {
                        if (idx === blockIndex) return { ...block, end: newEnd };
                        if (idx > blockIndex && (nearestLockedIdx === -1 || idx < nearestLockedIdx)) return { ...block, start: block.start + allowedShift, end: block.end + allowedShift };
                        return block;
                    }).sort((a, b) => a.start - b.start);
                }
            }
            
            // Standard drag
            return prev.map(block => {
                if (block.id !== id) return block;
                let newStart = block.start;
                let newEnd = block.end;
                const MIN_DURATION = 100;
                
                const blockIndex = initialBlocks.findIndex(b => b.id === id);
                const prevBlock = blockIndex > 0 ? initialBlocks[blockIndex - 1] : null;
                const nextBlock = blockIndex >= 0 && blockIndex < initialBlocks.length - 1 ? initialBlocks[blockIndex + 1] : null;
                
                const minStartAllowed = prevBlock ? prevBlock.end : 0;
                const maxEndAllowed = nextBlock ? nextBlock.start : Infinity;
                
                if (type === 'move') {
                    const blockDuration = initEnd - initStart;
                    const maxStartAllowed = maxEndAllowed - blockDuration;
                    newStart = Math.max(minStartAllowed, Math.min(maxStartAllowed, initStart + deltaMs));
                    newEnd = newStart + blockDuration;
                    targetSeekTime = newStart;

                    const atMin = newStart <= minStartAllowed;
                    const atMax = newEnd >= maxEndAllowed;
                    setDragHUD({
                        id,
                        type: 'move',
                        deltaMs: newStart - initStart,
                        newStart,
                        newEnd,
                        initStart,
                        initEnd,
                        atMinBound: atMin,
                        atMaxBound: atMax,
                        gapBefore: prevBlock ? Math.max(0, newStart - prevBlock.end) : (newStart > 0 ? newStart : null),
                        gapAfter: nextBlock ? Math.max(0, nextBlock.start - newEnd) : null,
                        boundaryReason: atMin 
                            ? (prevBlock ? `Touches prev: "${(prevBlock.text || '...').slice(0, 12)}"` : 'Audio start (0s)')
                            : atMax 
                                ? (nextBlock ? `Touches next: "${(nextBlock.text || '...').slice(0, 12)}"` : 'End of timeline')
                                : null
                    });
                } else if (type === 'start') {
                    newStart = Math.max(minStartAllowed, Math.min(initEnd - MIN_DURATION, initStart + deltaMs));
                    targetSeekTime = newStart;
                    const atMin = newStart <= minStartAllowed;
                    setDragHUD({
                        id,
                        type: 'start',
                        deltaMs: newStart - initStart,
                        newStart,
                        newEnd: initEnd,
                        initStart,
                        initEnd,
                        atMinBound: atMin,
                        atMaxBound: newStart >= initEnd - MIN_DURATION,
                        gapBefore: prevBlock ? Math.max(0, newStart - prevBlock.end) : null,
                        gapAfter: null,
                        boundaryReason: atMin ? (prevBlock ? `Touches prev: "${(prevBlock.text || '...').slice(0, 12)}"` : 'Audio start (0s)') : null
                    });
                } else if (type === 'end') {
                    newEnd = Math.max(initStart + MIN_DURATION, Math.min(maxEndAllowed, initEnd + deltaMs));
                    targetSeekTime = newEnd;
                    const atMax = newEnd >= maxEndAllowed;
                    setDragHUD({
                        id,
                        type: 'end',
                        deltaMs: newEnd - initEnd,
                        newStart: initStart,
                        newEnd,
                        initStart,
                        initEnd,
                        atMinBound: newEnd <= initStart + MIN_DURATION,
                        atMaxBound: atMax,
                        gapBefore: null,
                        gapAfter: nextBlock ? Math.max(0, nextBlock.start - newEnd) : null,
                        boundaryReason: atMax ? (nextBlock ? `Touches next: "${(nextBlock.text || '...').slice(0, 12)}"` : 'End of timeline') : null
                    });
                }
                
                return { ...block, start: newStart, end: newEnd };
            }).sort((a, b) => a.start - b.start);
        });

        if (targetSeekTime !== null) {
            dragState.current.targetSeekTime = targetSeekTime;
            seekTo(targetSeekTime, true);
        }
    }, [seekTo, containerWidth]);

    const autoScrollLoop = useCallback((time: number) => {
        if (!autoScrollRef.current) return;
        
        const dt = lastScrollTimeRef.current ? time - lastScrollTimeRef.current : 16;
        lastScrollTimeRef.current = time;

        const { type } = dragState.current;
        if (type && type !== 'scrub' && type !== 'select_only' && timelineRef.current && pointerEventRef.current) {
            const rect = timelineRef.current.getBoundingClientRect();
            const px = pointerClientXRef.current;
            const threshold = 60;
            let scrollDir = 0;
            
            let markerX = px; 
            if (dragState.current.targetSeekTime !== undefined) {
                const cw = rect.width;
                markerX = (cw / 2) + ((dragState.current.targetSeekTime - dragState.current.dragTimelineStart) / 1000) * activeZoomRef.current;
                markerX += rect.left;
            }
            
            const distLeftMouse = px - rect.left;
            const distRightMouse = rect.right - px;
            const distLeftMarker = markerX - rect.left;
            const distRightMarker = rect.right - markerX;
            
            const minLeft = Math.min(distLeftMouse, distLeftMarker);
            const minRight = Math.min(distRightMouse, distRightMarker);
            
            if (minLeft < threshold && minLeft <= minRight) {
                scrollDir = -1;
            } else if (minRight < threshold) {
                scrollDir = 1;
            }
            
            if (scrollDir !== 0) {
                const speedPxPerSec = 400;
                const deltaPx = speedPxPerSec * (dt / 1000) * scrollDir;
                const deltaMs = (deltaPx / activeZoomRef.current) * 1000;
                
                const newTimelineStart = Math.max(0, dragState.current.dragTimelineStart + deltaMs);
                const actualDeltaMs = newTimelineStart - dragState.current.dragTimelineStart;
                
                if (actualDeltaMs !== 0) {
                    const actualDeltaPx = (actualDeltaMs / 1000) * activeZoomRef.current;
                    dragState.current.dragTimelineStart = newTimelineStart;
                    dragState.current.startX -= actualDeltaPx;
                    
                    handlePointerMove(pointerEventRef.current);
                }
            }
        }
        
        autoScrollRef.current = requestAnimationFrame(autoScrollLoop);
    }, [handlePointerMove]);

    const handlePointerUp = useCallback((e: PointerEvent) => {
        pointersRef.current.delete(e.pointerId);
        if (justFinishedPinchRef.current) {
            dragState.current = { type: null, id: null, startX: 0, initStart: 0, initEnd: 0, initialBlocks: [], dragTimelineStart: 0 };
            setDraggingId(null);
            setDragHUD(null);
            document.removeEventListener('pointermove', handlePointerMove);
            document.removeEventListener('pointerup', handlePointerUp as EventListener);
            document.removeEventListener('pointercancel', handlePointerUp as EventListener);
            return;
        }

        const { type, id, startX, initStart, initialBlocks, target, pointerId } = dragState.current;
        if (e.pointerId !== pointerId) return;
        
        if (autoScrollRef.current) {
            cancelAnimationFrame(autoScrollRef.current);
            autoScrollRef.current = null;
        }
        
        if (type) {
            const absDeltaX = Math.abs(e.clientX - startX);
            if (absDeltaX >= 4) {
                const signedDeltaX = e.clientX - startX;
                const deltaMs = (signedDeltaX / activeZoomRef.current) * 1000;
                
                if (type === 'scrub') {
                    const targetTime = Math.max(0, dragState.current.initStart - deltaMs);
                    seekTo(targetTime, false);
                } else if (type === 'start' || type === 'sync_start') {
                    const finalBlock = latestBlocksRef.current.find(b => b.id === id);
                    if (finalBlock) {
                        seekTo(finalBlock.start, false);
                    }
                } else if (type === 'end' || type === 'sync_end') {
                    const finalBlock = latestBlocksRef.current.find(b => b.id === id);
                    if (finalBlock) {
                        seekTo(finalBlock.end, false);
                    }
                } else if (type === 'move' || type === 'sync_move') {
                    seekTo(dragState.current.dragTimelineStart, false);
                    const finalBlock = latestBlocksRef.current.find(b => b.id === id);
                    if (finalBlock) {
                        const shift = finalBlock.start - initStart;
                        const sign = shift > 0 ? '+' : '';
                        setSnapNotification(`Moved ${sign}${(shift / 1000).toFixed(2)}s (${formatTimeWithMs(finalBlock.start)} → ${formatTimeWithMs(finalBlock.end)})`);
                    }
                }
            }
        }
        
        if (type === 'move' || type === 'start' || type === 'end' || type === 'sync_move' || type === 'sync_start' || type === 'sync_end') {
            const finalBlocks = latestBlocksRef.current;
            if (JSON.stringify(initialBlocks) !== JSON.stringify(finalBlocks)) {
                pushToHistory(finalBlocks);
                setTimeout(() => notifyChange(finalBlocks), 0);
            }
        }
        
        if (target && (target as Element).releasePointerCapture && pointerId !== undefined) {
            try {
                (target as Element).releasePointerCapture(pointerId);
            } catch (err) {}
        }
        dragState.current = { type: null, id: null, startX: 0, initStart: 0, initEnd: 0, initialBlocks: [], dragTimelineStart: 0 };
        setDraggingId(null);
        setDragHUD(null);
        document.removeEventListener('pointermove', handlePointerMove);
        document.removeEventListener('pointerup', handlePointerUp as EventListener);
        document.removeEventListener('pointercancel', handlePointerUp as EventListener);
    }, [handlePointerMove, seekTo, pushToHistory, notifyChange]);

    const handlePointerDown = (e: React.PointerEvent, type: 'move'|'sync_move'|'start'|'sync_start'|'end'|'sync_end'|'scrub'|'select_scrub'|'select_only', id?: string, block?: SubtitleBlock) => {
        if (e.pointerType === 'touch' && (pinchStateRef.current.isPinching || justFinishedPinchRef.current)) {
            return;
        }

        pointersRef.current.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
        if (pointersRef.current.size >= 2) {
            if (dragState.current.type) {
                dragState.current = { type: null, id: null, startX: 0, initStart: 0, initEnd: 0, initialBlocks: [], dragTimelineStart: 0 };
                setDraggingId(null);
                setDragHUD(null);
            }
            return;
        }

        if (block?.isLocked && type !== 'select_only' && type !== 'scrub' && type !== 'select_scrub') {
            type = 'select_only';
        }
        
        e.stopPropagation();
        const target = e.currentTarget;
        if (target.setPointerCapture) {
            try { target.setPointerCapture(e.pointerId); } catch (err) {}
        }
        
        setIsPlaying(false);
        if (mediaRef.current) {
            const player = mediaRef.current as any;
            const internal = player.getInternalPlayer ? player.getInternalPlayer() : null;
            if (internal && typeof internal.pauseVideo === 'function') {
                try { internal.pauseVideo(); } catch (err) {}
            }
        }
        
        if (id && block && type !== 'scrub') {
            setSelectedId(id);
            if (type === 'move' || type === 'sync_move' || type === 'start' || type === 'sync_start' || type === 'end' || type === 'sync_end') {
                setDraggingId(id);
                dragState.current = { type, id, startX: e.clientX, initStart: block.start, initEnd: block.end, target, pointerId: e.pointerId, initialBlocks: blocksState, dragTimelineStart: currentTime };
            } else if (type === 'select_only') {
                dragState.current = { type, id, startX: e.clientX, initStart: block.start, initEnd: block.end, target, pointerId: e.pointerId, initialBlocks: blocksState, dragTimelineStart: currentTime };
            } else if (type === 'select_scrub') {
                dragState.current = { type: 'scrub', id: null, startX: e.clientX, initStart: currentTime, initEnd: 0, target, pointerId: e.pointerId, initialBlocks: [], dragTimelineStart: currentTime };
            }
        } else {
            dragState.current = { type: 'scrub', id: null, startX: e.clientX, initStart: currentTime, initEnd: 0, target, pointerId: e.pointerId, initialBlocks: [], dragTimelineStart: currentTime };
        }
        
        pointerClientXRef.current = e.clientX;
        pointerEventRef.current = e.nativeEvent as PointerEvent;
        
        if (!autoScrollRef.current) {
            lastScrollTimeRef.current = performance.now();
            autoScrollRef.current = requestAnimationFrame(autoScrollLoop);
        }
        
        document.addEventListener('pointermove', handlePointerMove, { passive: false });
        document.addEventListener('pointerup', handlePointerUp as EventListener);
        document.addEventListener('pointercancel', handlePointerUp as EventListener);
    };

    const blocksDuration = blocks.length > 0 ? Math.max(...blocks.map(b => b.end)) : 0;
    const totalTimelineMs = Math.max(duration, blocksDuration) + 10000;
    const timelineWidth = (totalTimelineMs / 1000) * activeZoom;
    const isDraggingBlock = draggingId !== null && dragState.current.type !== 'scrub';
    const effectiveTimeForTrack = isDraggingBlock ? dragState.current.dragTimelineStart : currentTime;
    const trackOffset = (containerWidth / 2) - ((effectiveTimeForTrack / 1000) * activeZoom);
    
    const activeBlocks = blocks.filter(b => currentTime >= b.start && currentTime <= b.end);
    const selectedBlock = blocks.find(b => b.id === selectedId);
    const sortedSubtitles = [...blocks].sort((a, b) => a.start - b.start);
    const selectedSubIndex = selectedBlock ? sortedSubtitles.findIndex(b => b.id === selectedBlock.id) : -1;
    const isFirstSub = selectedSubIndex <= 0;
    const isLastSub = selectedSubIndex === -1 || selectedSubIndex >= sortedSubtitles.length - 1;

    // Pinch to Zoom Gesture Handler on Subtitle Box & Timeline Area
    useEffect(() => {
        const el = timelineRef.current;
        if (!el) return;

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length >= 2) {
                // Abort any ongoing single-finger drag/move/scrub
                if (dragState.current.type) {
                    if (dragState.current.target && (dragState.current.target as Element).releasePointerCapture && dragState.current.pointerId !== undefined) {
                        try {
                            (dragState.current.target as Element).releasePointerCapture(dragState.current.pointerId);
                        } catch (_) {}
                    }
                    dragState.current = { type: null, id: null, startX: 0, initStart: 0, initEnd: 0, initialBlocks: [], dragTimelineStart: 0 };
                    setDraggingId(null);
                    setDragHUD(null);
                }
                if (autoScrollRef.current) {
                    cancelAnimationFrame(autoScrollRef.current);
                    autoScrollRef.current = null;
                }

                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

                pinchStateRef.current = {
                    isPinching: true,
                    initialDistance: Math.max(dist, 10),
                    initialZoom: activeZoomRef.current
                };
                setPinchZoomFeedback(activeZoomRef.current);
            }
        };

        const onTouchMove = (e: TouchEvent) => {
            if (pinchStateRef.current.isPinching && e.touches.length >= 2) {
                if (e.cancelable) e.preventDefault();
                const t1 = e.touches[0];
                const t2 = e.touches[1];
                const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
                const scale = dist / pinchStateRef.current.initialDistance;

                const bounds = zoomBoundsRef.current;
                const targetZoom = Math.max(bounds.min, Math.min(bounds.max, Math.round(pinchStateRef.current.initialZoom * scale * 10) / 10));
                setZoom(targetZoom);
                activeZoomRef.current = targetZoom;
                setPinchZoomFeedback(targetZoom);

                if (pinchFeedbackTimerRef.current) clearTimeout(pinchFeedbackTimerRef.current);
            }
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (pinchStateRef.current.isPinching && e.touches.length < 2) {
                pinchStateRef.current.isPinching = false;
                justFinishedPinchRef.current = true;
                setTimeout(() => {
                    justFinishedPinchRef.current = false;
                }, 300);

                if (pinchFeedbackTimerRef.current) clearTimeout(pinchFeedbackTimerRef.current);
                pinchFeedbackTimerRef.current = setTimeout(() => {
                    setPinchZoomFeedback(null);
                }, 800);
            }
        };

        const onWheel = (e: WheelEvent) => {
            if (e.ctrlKey || e.altKey) {
                if (e.cancelable) e.preventDefault();
                const bounds = zoomBoundsRef.current;
                const factor = Math.exp(-e.deltaY * 0.005);
                const targetZoom = Math.max(bounds.min, Math.min(bounds.max, Math.round(activeZoomRef.current * factor * 10) / 10));
                setZoom(targetZoom);
                activeZoomRef.current = targetZoom;
                setPinchZoomFeedback(targetZoom);
                if (pinchFeedbackTimerRef.current) clearTimeout(pinchFeedbackTimerRef.current);
                pinchFeedbackTimerRef.current = setTimeout(() => {
                    setPinchZoomFeedback(null);
                }, 800);
            }
        };

        el.addEventListener('touchstart', onTouchStart, { passive: false });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: false });
        el.addEventListener('touchcancel', onTouchEnd, { passive: false });
        el.addEventListener('wheel', onWheel, { passive: false });

        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchEnd);
            el.removeEventListener('wheel', onWheel);
            if (pinchFeedbackTimerRef.current) clearTimeout(pinchFeedbackTimerRef.current);
        };
    }, [containerWidth]);

    const addBlock = () => {
        const newStart = Math.round(currentTime);
        const newEnd = newStart + 2000;
        const newBlock: SubtitleBlock = {
            id: Math.random().toString(36).substring(7),
            start: newStart,
            end: newEnd,
            text: "New Subtitle"
        };
        setBlocksAndNotify(prev => [...prev, newBlock].sort((a, b) => a.start - b.start));
        setSelectedId(newBlock.id);
        setIsEditingText(true);
    };

    const deleteBlock = () => {
        if (!selectedId) return;
        setBlocksAndNotify(prev => prev.filter(b => b.id !== selectedId));
        setSelectedId(null);
    };

    const splitBlock = () => {
        if (!selectedId) return;
        const block = blocks.find(b => b.id === selectedId);
        if (!block) return;
        
        if (currentTime <= block.start || currentTime >= block.end) {
            setSnapNotification("Playhead must be inside the subtitle to split");
            return;
        }

        const splitTime = Math.round(currentTime);
        const b1: SubtitleBlock = { ...block, end: splitTime };
        const b2: SubtitleBlock = { ...block, id: Math.random().toString(36).substring(7), start: splitTime };

        setBlocksAndNotify(prev => prev.map(b => b.id === selectedId ? b1 : b).concat(b2).sort((a, b) => a.start - b.start));
        setSelectedId(b2.id);
    };

    const splitBlockSentences = () => {
        if (!selectedBlock) return;
        const subBlocks = splitSingleBlockBySentences(selectedBlock);
        if (subBlocks.length <= 1) {
            splitBlock();
            return;
        }
        setBlocksAndNotify(prev => prev.filter(b => b.id !== selectedBlock.id).concat(subBlocks).sort((a, b) => a.start - b.start));
        setSelectedId(subBlocks[0].id);
        setSnapNotification(`Split into ${subBlocks.length} concise sentence boxes`);
    };

    const duplicateBlock = () => {
        if (!selectedId) return;
        const block = blocks.find(b => b.id === selectedId);
        if (!block) return;

        const dur = block.end - block.start;
        const newStart = block.end + 500;
        const newBlock: SubtitleBlock = {
            id: Math.random().toString(36).substring(7),
            start: newStart,
            end: newStart + dur,
            text: block.text
        };

        setBlocksAndNotify(prev => [...prev, newBlock].sort((a, b) => a.start - b.start));
        setSelectedId(newBlock.id);
    };

    const toggleLockBlock = () => {
        if (!selectedId) return;
        setBlocksAndNotify(prev => prev.map(b => b.id === selectedId ? { ...b, isLocked: !b.isLocked } : b));
    };

    const handleSetMarkIn = (blockId: string) => {
        const targetStart = Math.round(currentTime);
        setBlocksAndNotify(prev => prev.map(b => {
            if (b.id === blockId) {
                const newEnd = b.end <= targetStart ? targetStart + 1500 : b.end;
                return { ...b, start: Math.max(0, targetStart), end: newEnd };
            }
            if (b.start < targetStart && b.end > targetStart) {
                return { ...b, end: targetStart };
            }
            return b;
        }).sort((a, b) => a.start - b.start));
        seekTo(targetStart, false);
        setSnapNotification(`Set Mark In: ${formatTimeWithMs(targetStart)}`);
    };

    const handleSetMarkOut = (blockId: string) => {
        const targetEnd = Math.round(currentTime);
        setBlocksAndNotify(prev => prev.map(b => {
            if (b.id === blockId) {
                const newStart = b.start >= targetEnd ? Math.max(0, targetEnd - 1500) : b.start;
                return { ...b, start: newStart, end: targetEnd };
            }
            if (b.start < targetEnd && b.end > targetEnd) {
                return { ...b, start: targetEnd };
            }
            return b;
        }).sort((a, b) => a.start - b.start));
        seekTo(targetEnd, false);
        setSnapNotification(`Set Mark Out: ${formatTimeWithMs(targetEnd)}`);
    };

    const handleSelectPrevSubtitle = useCallback(() => {
        if (blocksState.length === 0) return;
        const sorted = [...blocksState].sort((a, b) => a.start - b.start);
        if (!selectedId) {
            const target = sorted[0];
            setSelectedId(target.id);
            setSnapNotification(`Selected: "${target.text.slice(0, 20) || 'Subtitle'}" (1/${sorted.length})`);
            return;
        }
        const idx = sorted.findIndex(b => b.id === selectedId);
        if (idx > 0) {
            const prev = sorted[idx - 1];
            setSelectedId(prev.id);
            setSnapNotification(`Sub Left: "${prev.text.slice(0, 20) || 'Subtitle'}" (${idx}/${sorted.length})`);
        }
    }, [blocksState, selectedId]);

    const handleSelectNextSubtitle = useCallback(() => {
        if (blocksState.length === 0) return;
        const sorted = [...blocksState].sort((a, b) => a.start - b.start);
        if (!selectedId) {
            const target = sorted[0];
            setSelectedId(target.id);
            setSnapNotification(`Selected: "${target.text.slice(0, 20) || 'Subtitle'}" (1/${sorted.length})`);
            return;
        }
        const idx = sorted.findIndex(b => b.id === selectedId);
        if (idx >= 0 && idx < sorted.length - 1) {
            const next = sorted[idx + 1];
            setSelectedId(next.id);
            setSnapNotification(`Sub Right: "${next.text.slice(0, 20) || 'Subtitle'}" (${idx + 2}/${sorted.length})`);
        }
    }, [blocksState, selectedId]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }

            if (e.key === '[' && selectedId) {
                e.preventDefault();
                handleSetMarkIn(selectedId);
            } else if (e.key === ']' && selectedId) {
                e.preventDefault();
                handleSetMarkOut(selectedId);
            } else if (selectedId && e.shiftKey && e.key === 'ArrowLeft') {
                e.preventDefault();
                handleNudge(e.altKey ? -500 : -100);
            } else if (selectedId && e.shiftKey && e.key === 'ArrowRight') {
                e.preventDefault();
                handleNudge(e.altKey ? 500 : 100);
            } else if ((e.altKey && e.key === 'ArrowLeft') || e.key === '<' || (selectedId && e.key === ',')) {
                e.preventDefault();
                handleSelectPrevSubtitle();
            } else if ((e.altKey && e.key === 'ArrowRight') || e.key === '>' || (selectedId && e.key === '.')) {
                e.preventDefault();
                handleSelectNextSubtitle();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedId, currentTime, handleSelectPrevSubtitle, handleSelectNextSubtitle, handleNudge]);

    const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const txt = evt.target?.result as string;
            setBlocksState(parseSrt(txt));
        };
        reader.readAsText(file);
    };

    const handleFileAppend = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (evt) => {
            const txt = evt.target?.result as string;
            const newBlocks = parseSrt(txt);
            
            setBlocksAndNotify(prev => {
                if (prev.length === 0) return newBlocks;
                const lastBlockEnd = Math.max(...prev.map(b => b.end));
                const shiftedBlocks = newBlocks.map(b => ({
                    ...b,
                    start: b.start + lastBlockEnd + 1000,
                    end: b.end + lastBlockEnd + 1000,
                    id: Math.random().toString(36).substr(2, 9)
                }));
                return [...prev, ...shiftedBlocks].sort((a,b) => a.start - b.start);
            });
        };
        reader.readAsText(file);
        if (appendInputRef.current) {
             appendInputRef.current.value = '';
        }
    };

    const executeExport = (filename: string) => {
        const txt = generateSrt(blocks);
        const blob = new Blob([txt], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        setShowExportModal(false);
    };

    let tickInterval = 10;
    if (activeZoom > 400) tickInterval = 1;
    else if (activeZoom > 150) tickInterval = 2;
    else if (activeZoom > 50) tickInterval = 5;

    const numTicks = Math.ceil(totalTimelineMs / 1000 / tickInterval);
    const visibleTicks = Array.from({length: numTicks}, (_, i) => i);

    const renderCaptionBlock = (block: SubtitleBlock) => {
        return (
            <p 
                key={block.id} 
                className="text-white font-bold px-4 py-1 drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)] mx-auto leading-snug whitespace-pre-wrap transition-all duration-200"
                style={{ 
                    fontSize: `${previewSize}px`,
                    textShadow: '2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 0 2px 0 #000, 2px 0 0 #000, 0 -2px 0 #000, -2px 0 0 #000',
                }}
            >
                {block.text}
            </p>
        );
    };

    return (
        <div className="flex flex-col h-full bg-[#0a0a0a] text-white rounded-xl overflow-hidden relative">
            {/* Top Section: YouTube Player */}
            <div 
                ref={playerContainerRef} 
                onDoubleClick={toggleFullscreen} 
                className={`bg-black relative flex flex-col items-center justify-center overflow-hidden group transition-all duration-200 ${
                    videoHeightMode === 'large' 
                        ? 'h-[40vh] min-h-[180px] shrink-0' 
                        : 'flex-1 min-h-0'
                }`}
            >
                {effectiveYoutubeUrl ? (
                    <div className="w-full h-full flex items-center justify-center relative bg-black">
                        <div id={ytContainerId} className="w-full h-full min-h-[160px]" />

                        {/* Top-Right Direct Pop-Out Button */}
                        <div className="absolute top-2 right-2 flex items-center gap-1.5 z-20 pointer-events-auto">
                            <button
                                type="button"
                                onClick={() => window.open(effectiveYoutubeUrl, '_blank')}
                                className="p-1.5 bg-black/80 hover:bg-black border border-white/20 text-white/80 hover:text-white rounded-lg text-[10px] backdrop-blur-md transition-colors shadow cursor-pointer"
                                title="Open video directly on YouTube"
                            >
                                <ExternalLink className="w-3.5 h-3.5" />
                            </button>
                        </div>

                        {youtubeError && (
                            <div className="absolute inset-0 bg-black/95 flex flex-col items-center justify-center p-4 text-center z-30 space-y-3">
                                <AlertTriangle className="w-8 h-8 text-amber-400" />
                                <div className="space-y-1">
                                    <p className="text-xs text-white font-bold">YouTube Embedding Unavailable</p>
                                    <p className="text-[11px] text-white/70 max-w-xs leading-relaxed">
                                        Playback blocked by YouTube (Error 150/153: DRM copyright protection or publisher embedding restriction).
                                    </p>
                                </div>
                                <div className="flex items-center gap-2 pt-1">
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            window.open(effectiveYoutubeUrl, '_blank');
                                        }}
                                        className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold transition-colors shadow cursor-pointer"
                                    >
                                        Open on YouTube
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="text-white/20 text-sm font-medium border-2 border-dashed border-white/10 p-12 rounded-2xl text-center mx-4 flex flex-col items-center gap-3">
                        <Youtube className="w-10 h-10 text-red-500/50" />
                        <span>Paste YouTube URL to enable synchronized playback</span>
                        <button
                            type="button"
                            onClick={() => setShowYoutubeInputModal(true)}
                            className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-xl text-xs font-bold transition-colors flex items-center gap-2 cursor-pointer"
                        >
                            <Youtube className="w-4 h-4 text-red-500" />
                            <span>Load YouTube Video</span>
                        </button>
                    </div>
                )}
                
                {/* Fixed Captions overlay */}
                <div 
                    className="absolute w-[90%] md:w-[70%] text-center z-10 pointer-events-none flex flex-col gap-2 transition-all duration-200"
                    style={{ bottom: `${previewPosition}%` }}
                >
                    {activeBlocks.map(block => renderCaptionBlock(block))}
                </div>
            </div>

            {/* Global Video Scrubber & Playback Controls */}
            <div className="flex flex-col bg-[#111] border-t border-white/10 shrink-0 relative z-20">
                {/* Global Scrubber */}
                <div className="w-full px-2 sm:px-6 pt-1.5 pb-0.5 sm:pt-2.5 flex items-center group cursor-pointer relative" title="YouTube Video Position">
                    <input 
                        type="range" 
                        min={0} 
                        max={Math.max(duration, blocksDuration, 100)} 
                        value={currentTime} 
                        onChange={(e) => seekTo(Number(e.target.value))}
                        className="w-full h-1.5 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-red-500 hover:[&::-webkit-slider-thumb]:w-4 hover:[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:transition-all"
                        style={{
                           background: `linear-gradient(to right, #ef4444 ${(currentTime / Math.max(duration, blocksDuration, 1)) * 100}%, rgba(255,255,255,0.2) ${(currentTime / Math.max(duration, blocksDuration, 1)) * 100}%)`
                        }}
                    />
                </div>

                {/* Zoom Scrubber */}
                <div className="w-full px-2 sm:px-6 py-0.5 sm:py-1 flex items-center gap-2 group cursor-pointer relative" title="Timeline Zoom (Spread Subtitles)">
                    <ZoomOut className="w-3.5 h-3.5 text-white/50 shrink-0" />
                    <input 
                        type="range" 
                        min={minZoom} 
                        max={maxZoom} 
                        value={zoom} 
                        onChange={(e) => setZoom(Number(e.target.value))}
                        className="w-full h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-500 hover:[&::-webkit-slider-thumb]:w-4 hover:[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:transition-all"
                        style={{
                           background: `linear-gradient(to right, #f59e0b ${((zoom - minZoom) / (maxZoom - minZoom)) * 100}%, rgba(255,255,255,0.1) ${((zoom - minZoom) / (maxZoom - minZoom)) * 100}%)`
                        }}
                    />
                    <ZoomIn className="w-3.5 h-3.5 text-white/50 shrink-0" />
                </div>

                {/* Controls Bar */}
                <div className="h-auto min-h-[42px] sm:min-h-[48px] py-1 sm:py-2 flex flex-wrap items-center justify-between px-2 sm:px-6 gap-y-1.5 sm:gap-y-2">
                    <div className="flex items-center gap-2 text-[10px] sm:text-xs font-mono text-white/70 w-auto sm:w-48">
                        <span className="text-white font-bold">{formatTimeWithMs(currentTime)}</span>
                        <span className="text-white/30">/</span>
                        <span>{formatTimeWithMs(Math.max(duration, blocksDuration))}</span>
                    </div>
                    
                    <div className="flex items-center justify-center gap-2 sm:gap-4 flex-1 min-w-[140px]">
                        <button className="text-white/50 hover:text-white transition-colors p-1" onClick={() => seekTo(Math.max(0, currentTime - 5000))} title="Rewind 5s">
                            <RotateCcw className="w-4 h-4 sm:w-5 sm:h-5" />
                        </button>
                        <button onClick={togglePlay} className="w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center bg-red-600 text-white rounded-full hover:scale-105 transition-transform shadow-md cursor-pointer" title={isPlaying ? "Pause YouTube" : "Play YouTube"}>
                            {isPlaying ? <Pause className="w-4 h-4 sm:w-5 sm:h-5 fill-white" /> : <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-white ml-0.5 sm:ml-1" />}
                        </button>
                        <button className="text-white/50 hover:text-white transition-colors p-1" onClick={() => seekTo(currentTime + 5000)} title="Forward 5s">
                            <RotateCw className="w-4 h-4 sm:w-5 sm:h-5" />
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
                                const currIdx = speeds.indexOf(playbackRate);
                                const nextIdx = (currIdx + 1) % speeds.length;
                                const nextSpeed = speeds[currIdx >= 0 ? nextIdx : 2];
                                setPlaybackRate(nextSpeed);
                                setSnapNotification(`YouTube Speed: ${nextSpeed}x`);
                            }}
                            className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-white/5 hover:bg-white/10 active:bg-white/20 text-white/80 hover:text-white rounded-md text-[10px] sm:text-xs font-mono font-bold transition-all border border-white/10 cursor-pointer"
                            title="YouTube Playback Speed"
                        >
                            {playbackRate}x
                        </button>
                    </div>
                    
                    <div className="flex justify-start sm:justify-end items-center gap-1 sm:gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] flex-nowrap shrink-0">
                        {/* Dedicated Manual "Sync YT" Button */}
                        <button
                            type="button"
                            onClick={handleSyncYT}
                            className="shrink-0 px-2.5 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all border shadow-sm bg-red-600/30 hover:bg-red-600/50 text-red-200 border-red-500/40 font-bold text-xs cursor-pointer"
                            title="Sync YT: Immediately reads the timestamp from the YouTube player and synchronizes the subtitle timeframe"
                        >
                            <RefreshCw className="w-3.5 h-3.5 text-red-300 shrink-0" />
                            <span>Sync YT</span>
                        </button>

                        <button 
                            type="button"
                            onClick={() => setShowYoutubeInputModal(true)} 
                            className="shrink-0 px-2 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all border shadow-sm bg-white/5 hover:bg-white/10 text-white/80 border-white/10" 
                            title={effectiveYoutubeUrl ? "Change YouTube Video URL" : "Load YouTube Video URL"}
                        >
                            <Youtube className="w-3.5 h-3.5 text-red-400 shrink-0" />
                            <span className="text-xs font-semibold hidden md:inline">{effectiveYoutubeUrl ? "Change Link" : "YouTube Link"}</span>
                        </button>

                        {effectiveYoutubeUrl && (
                            <button
                                type="button"
                                onClick={handleFetchYouTubeAssets}
                                disabled={isFetchingYoutubeAssets}
                                className="shrink-0 px-2.5 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all border shadow-sm bg-white/5 hover:bg-white/10 disabled:opacity-50 text-white/90 border-white/10 font-bold text-xs cursor-pointer animate-in fade-in"
                                title="Fetch official YouTube caption tracks and inspect HLS/DASH manifest URLs without reading the cross-origin iframe"
                            >
                                {isFetchingYoutubeAssets ? (
                                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <Scan className="w-3.5 h-3.5 text-emerald-300" />
                                )}
                                <span className="whitespace-nowrap">{isFetchingYoutubeAssets ? "Fetching..." : "Fetch CC + Manifest"}</span>
                            </button>
                        )}

                        {effectiveYoutubeUrl && (
                            <button
                                type="button"
                                onClick={handleGenerateYouTubeSubtitles}
                                disabled={isGeneratingYtSubtitles}
                                className="shrink-0 px-2.5 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all border shadow-sm bg-gradient-to-r from-red-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 disabled:opacity-50 text-white font-bold text-xs cursor-pointer animate-in fade-in"
                                title="AI Inspects YouTube Video, Transcript, and Generates Subtitles"
                            >
                                {isGeneratingYtSubtitles ? (
                                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                                )}
                                <span className="whitespace-nowrap">{isGeneratingYtSubtitles ? "Generating..." : "Generate Subtitle"}</span>
                            </button>
                        )}

                        <div className="shrink-0 w-px h-4 bg-white/10 mx-1 hidden sm:block"></div>
                        <button onClick={handleUndo} disabled={!canUndo} className={`shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-md transition-colors ${canUndo ? 'bg-white/5 hover:bg-white/10 text-white' : 'bg-white/5 text-white/20 cursor-not-allowed'}`} title="Undo">
                            <Undo className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={handleRedo} disabled={!canRedo} className={`shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-md transition-colors ${canRedo ? 'bg-white/5 hover:bg-white/10 text-white' : 'bg-white/5 text-white/20 cursor-not-allowed'}`} title="Redo">
                            <Redo className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={clearSubtitles} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-red-500/20 rounded-md text-white hover:text-red-400 transition-colors" title="Clear All Subtitles">
                            <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <div className="shrink-0 w-px h-4 bg-white/10 mx-1 hidden sm:block"></div>
                        <button onClick={() => setShowExtractSettings(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Extract Segment">
                            <Scissors className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={() => setShowSyncSettings(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Sync Subtitles">
                            <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={() => setShowTextTools(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Bulk Text Tools">
                            <FileText className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={() => setShowPreviewSettings(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Caption Style">
                            <Settings className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={() => setVideoHeightMode(prev => prev === 'large' ? 'normal' : 'large')} className={`shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-md transition-colors ${videoHeightMode === 'large' ? 'bg-red-600 text-white' : 'bg-white/5 hover:bg-white/10 text-white'}`} title={videoHeightMode === 'large' ? "Standard Video Size" : "Enlarge Video View"}>
                            <Tv className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={toggleFullscreen} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Fullscreen">
                            <Maximize className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <div className="shrink-0 w-px h-4 bg-white/10 mx-1 hidden sm:block"></div>
                        <div className="shrink-0 flex items-center bg-black/40 rounded-lg p-0.5 border border-white/5 mx-1">
                            <button onClick={() => setDragMode('normal')} className={`shrink-0 px-2 py-1 flex items-center gap-1.5 rounded-md text-[10px] font-bold tracking-wide uppercase transition-colors ${dragMode === 'normal' ? 'bg-amber-500 text-black' : 'text-white/40 hover:text-white'}`} title="Normal Drag (Move single block)">
                                <GripHorizontal className="w-3 h-3" /> Normal
                            </button>
                            <button onClick={() => setDragMode('sync')} className={`shrink-0 px-2 py-1 flex items-center gap-1.5 rounded-md text-[10px] font-bold tracking-wide uppercase transition-colors ${dragMode === 'sync' ? 'bg-indigo-500 text-white' : 'text-white/40 hover:text-white'}`} title="Ripple Sync (Move block and all after it)">
                                <ListTree className="w-3 h-3" /> Sync
                            </button>
                        </div>
                        <div className="shrink-0 w-px h-4 bg-white/10 mx-1 hidden sm:block"></div>
                        <input type="file" accept=".srt,.vtt" ref={fileInputRef} className="hidden" onChange={handleFileUpload} />
                        <input type="file" accept=".srt,.vtt" ref={appendInputRef} className="hidden" onChange={handleFileAppend} />
                        <button onClick={() => fileInputRef.current?.click()} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Import/Overwrite Subtitles">
                            <Upload className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={() => appendInputRef.current?.click()} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Append Subtitles">
                            <FilePlus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={() => setShowExportModal(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-red-600 hover:bg-red-500 rounded-md text-white transition-colors" title="Export SRT">
                            <Download className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <div className="shrink-0 w-px h-4 bg-white/10 mx-1 hidden sm:block"></div>
                        <button onClick={() => setZoom(containerWidth > 0 ? containerWidth / 10 : 100)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Fit Zoom">
                            <Scan className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={addBlock} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/10 hover:bg-white/20 rounded-md text-white transition-colors sm:ml-1" title="Add Caption">
                            <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
                        </button>
                    </div>
                </div>
            </div>

            {effectiveYoutubeUrl && youtubeAssetReport && (
                <div className="mx-2 mb-2 shrink-0 rounded-xl border border-white/10 bg-black/35 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 text-xs font-semibold text-white/85 truncate">{youtubeAssetReport.title}</div>
                        <button type="button" onClick={() => setYoutubeAssetReport(null)} className="shrink-0 rounded-md p-1 text-white/45 hover:bg-white/10 hover:text-white" title="Dismiss manifest report">
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                    <div className="text-[11px] leading-relaxed text-white/60">{youtubeAssetReport.message}</div>
                    {youtubeAssetReport.hlsUrl && (
                        <div className="rounded-lg border border-white/10 bg-black/35 p-2 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-300">HLS Manifest (.m3u8)</span>
                                <button type="button" onClick={() => void copyYouTubeManifestUrl(youtubeAssetReport.hlsUrl!, 'HLS')} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10 hover:text-white">
                                    <Copy className="h-3 w-3" /> Copy URL
                                </button>
                            </div>
                            <a href={youtubeAssetReport.hlsUrl} target="_blank" rel="noreferrer" className="block max-h-16 overflow-y-auto break-all text-[10px] leading-relaxed text-white/50 hover:text-white/80">{youtubeAssetReport.hlsUrl}</a>
                        </div>
                    )}
                    {youtubeAssetReport.dashUrl && (
                        <div className="rounded-lg border border-white/10 bg-black/35 p-2 space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-[10px] font-bold uppercase tracking-wide text-sky-300">DASH Manifest (.mpd)</span>
                                <button type="button" onClick={() => void copyYouTubeManifestUrl(youtubeAssetReport.dashUrl!, 'DASH')} className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] text-white/70 hover:bg-white/10 hover:text-white">
                                    <Copy className="h-3 w-3" /> Copy URL
                                </button>
                            </div>
                            <a href={youtubeAssetReport.dashUrl} target="_blank" rel="noreferrer" className="block max-h-16 overflow-y-auto break-all text-[10px] leading-relaxed text-white/50 hover:text-white/80">{youtubeAssetReport.dashUrl}</a>
                        </div>
                    )}
                </div>
            )}

            {/* Selected Block Action Bar */}
            {selectedBlock && (
                <div className="relative w-full shrink-0 z-40 bg-[#1a1a1a] border-t border-white/10 group/actionbar">
                    {actionBarCanScrollLeft && (
                        <button 
                            type="button"
                            onClick={() => scrollActionBar('left')}
                            className="absolute left-0 top-0 bottom-0 z-50 px-1 sm:px-1.5 bg-gradient-to-r from-[#1a1a1a] via-[#1a1a1a]/90 to-transparent text-white/80 hover:text-white flex items-center justify-center transition-all cursor-pointer shadow-md"
                        >
                            <ChevronLeft className="w-4 h-4 drop-shadow" />
                        </button>
                    )}

                    {actionBarCanScrollRight && (
                        <button 
                            type="button"
                            onClick={() => scrollActionBar('right')}
                            className="absolute right-0 top-0 bottom-0 z-50 px-1 sm:px-1.5 bg-gradient-to-l from-[#1a1a1a] via-[#1a1a1a]/90 to-transparent text-white/80 hover:text-white flex items-center justify-center transition-all cursor-pointer shadow-md"
                        >
                            <ChevronRight className="w-4 h-4 drop-shadow" />
                        </button>
                    )}

                    <div 
                        ref={actionBarRef}
                        onMouseDown={handleActionBarMouseDown}
                        onMouseMove={handleActionBarMouseMove}
                        onMouseUp={handleActionBarMouseUpOrLeave}
                        onMouseLeave={handleActionBarMouseUpOrLeave}
                        className="flex items-center justify-start sm:justify-between px-2 py-1 sm:py-1.5 w-full gap-1.5 sm:gap-2 shrink-0 overflow-x-auto select-none touch-pan-x custom-scrollbar flex-nowrap"
                    >
                        <div className="flex items-center gap-1 shrink-0">
                            <button 
                                onClick={toggleLockBlock} 
                                className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg transition-colors border ${selectedBlock.isLocked ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-[0_0_10px_rgba(245,158,11,0.5)] border-amber-400' : 'bg-white/5 hover:bg-white/10 text-white/70 border-white/10'}`} 
                                title={selectedBlock.isLocked ? "Unlock" : "Lock"}
                            >
                                {selectedBlock.isLocked ? <Lock className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Unlock className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
                                <span className="hidden sm:inline font-bold text-xs">{selectedBlock.isLocked ? 'Locked' : 'Lock'}</span>
                            </button>

                            <div className="inline-flex items-stretch rounded-lg bg-black/50 border border-white/20 p-0.5 shadow-sm shrink-0 divide-x divide-white/10">
                                <button 
                                    type="button"
                                    onClick={handleSelectPrevSubtitle}
                                    disabled={isFirstSub}
                                    className="flex items-center gap-0.5 px-1.5 sm:px-2 py-1 bg-white/5 hover:bg-white/20 active:bg-white/30 disabled:opacity-30 text-white/90 rounded-l-md text-[10px] font-medium transition-all shrink-0 cursor-pointer"
                                    title="Previous Subtitle"
                                >
                                    <ChevronLeft className="w-3.5 h-3.5 -ml-0.5 text-red-400" />
                                    <span className="font-mono text-[10px] font-semibold">Sub</span>
                                </button>
                                <button 
                                    type="button"
                                    onClick={() => handleSetMarkIn(selectedBlock.id)}
                                    className="flex items-center gap-0.5 px-2 py-1 bg-white/5 hover:bg-amber-500/25 active:bg-amber-500/40 text-amber-300 font-mono text-[10px] font-bold transition-all shrink-0 cursor-pointer"
                                    title="Mark In [in]: Align subtitle start to current YouTube position ([)"
                                >
                                    <span>[In</span>
                                </button>
                                <button 
                                    type="button"
                                    onClick={() => handleSetMarkOut(selectedBlock.id)}
                                    className="flex items-center gap-0.5 px-2 py-1 bg-white/5 hover:bg-amber-500/25 active:bg-amber-500/40 text-amber-300 font-mono text-[10px] font-bold transition-all shrink-0 cursor-pointer"
                                    title="Mark Out [out]: Align subtitle end to current YouTube position (])"
                                >
                                    <span>Out]</span>
                                </button>
                                <button 
                                    type="button"
                                    onClick={handleSelectNextSubtitle}
                                    disabled={isLastSub}
                                    className="flex items-center gap-0.5 px-1.5 sm:px-2 py-1 bg-white/5 hover:bg-white/20 active:bg-white/30 disabled:opacity-30 text-white/90 rounded-r-md text-[10px] font-medium transition-all shrink-0 cursor-pointer"
                                    title="Next Subtitle"
                                >
                                    <span className="font-mono text-[10px] font-semibold">Sub</span>
                                    <ChevronRight className="w-3.5 h-3.5 -mr-0.5 text-red-400" />
                                </button>
                            </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-1 min-w-[70px] max-w-[200px] sm:max-w-none overflow-hidden shrink-0 sm:shrink">
                            <button 
                                onClick={() => seekTo(selectedBlock.start, false)} 
                                className="text-[10px] font-mono text-red-300 hover:text-white bg-red-950/70 hover:bg-red-900 px-1.5 py-0.5 sm:px-2 sm:py-1 rounded border border-red-500/30 flex items-center gap-1 shrink-0 transition-colors cursor-pointer" 
                                title="Jump YouTube video to subtitle start"
                            >
                                <Play className="w-2.5 h-2.5 fill-current" /> {formatTimeWithMs(selectedBlock.start)}
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsEditingText(true)}
                                className="flex items-center gap-1 px-2.5 py-1 bg-red-600 hover:bg-red-500 active:scale-95 text-white rounded-lg text-xs font-bold shrink-0 transition-all cursor-pointer shadow-sm border border-red-400/30"
                                title="Edit Subtitle Text"
                            >
                                <Edit3 className="w-3.5 h-3.5" />
                                <span>Edit</span>
                            </button>
                            <div 
                                onClick={() => setIsEditingText(true)}
                                className="flex-1 overflow-hidden bg-black/40 hover:bg-black/60 border border-white/10 hover:border-red-500/40 rounded-lg px-2.5 py-1 cursor-pointer transition-colors"
                                title="Click to edit subtitle text"
                            >
                                {selectedBlock.text && selectedBlock.text.includes('\n') ? (
                                    <div className="flex items-center gap-1.5 text-[11px] truncate">
                                        <span className="text-white/90 truncate"><span className="text-red-400 font-bold text-[9px] mr-0.5">L1:</span>{selectedBlock.text.split('\n')[0]}</span>
                                        <span className="text-white/30">•</span>
                                        <span className="text-emerald-300 truncate"><span className="text-emerald-400 font-bold text-[9px] mr-0.5">L2:</span>{selectedBlock.text.split('\n').slice(1).join(' ')}</span>
                                    </div>
                                ) : (
                                    <p className="text-[11px] sm:text-xs text-white/80 truncate font-medium">{selectedBlock.text || "Empty subtitle (click to edit)"}</p>
                                )}
                            </div>
                        </div>

                        <div className="flex items-center gap-1 shrink-0">
                            {/* Nudge Controls */}
                            <div className="inline-flex items-center rounded-lg bg-black/50 border border-white/20 p-0.5 shadow-sm divide-x divide-white/10 shrink-0">
                                <button type="button" onClick={() => handleNudge(-500)} disabled={selectedBlock.isLocked} className="px-1.5 py-1 text-[10px] font-mono text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 rounded-l-md transition-colors" title="Nudge -0.5s">-0.5s</button>
                                <button type="button" onClick={() => handleNudge(-100)} disabled={selectedBlock.isLocked} className="px-1.5 py-1 text-[10px] font-mono text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors" title="Nudge -100ms">-100ms</button>
                                <button type="button" onClick={() => handleNudge(100)} disabled={selectedBlock.isLocked} className="px-1.5 py-1 text-[10px] font-mono text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-colors" title="Nudge +100ms">+100ms</button>
                                <button type="button" onClick={() => handleNudge(500)} disabled={selectedBlock.isLocked} className="px-1.5 py-1 text-[10px] font-mono text-white/80 hover:text-white hover:bg-white/10 disabled:opacity-30 rounded-r-md transition-colors" title="Nudge +0.5s">+0.5s</button>
                            </div>

                            {(() => {
                                const l1 = (selectedBlock.text || '').split('\n')[0] || '';
                                const l2 = (selectedBlock.text || '').split('\n').slice(1).join(' ') || '';
                                const sCount = Math.max(splitSentences(l1).length, splitSentences(l2).length);
                                if (sCount >= 2 || (selectedBlock.text || '').length > 60) {
                                    return (
                                        <button
                                            type="button"
                                            onClick={splitBlockSentences}
                                            className="px-2 py-1 bg-red-600/30 hover:bg-red-600/50 text-red-200 hover:text-white rounded-lg transition-colors flex items-center gap-1 text-[10px] sm:text-[11px] font-bold border border-red-500/40 shrink-0 cursor-pointer shadow-sm animate-in fade-in"
                                            title={`Split this long cue into ${sCount >= 2 ? sCount : 2} concise sentence boxes`}
                                        >
                                            <Scissors className="w-3.5 h-3.5 text-red-400" />
                                            <span>Split {sCount >= 2 ? `${sCount} Sentences` : 'Long Text'}</span>
                                        </button>
                                    );
                                }
                                return null;
                            })()}

                            <button onClick={splitBlock} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 transition-colors" title="Split"><Split className="w-3.5 h-3.5" /></button>
                            <button onClick={duplicateBlock} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 transition-colors" title="Duplicate"><Copy className="w-3.5 h-3.5" /></button>
                            <button onClick={deleteBlock} className="p-1.5 bg-white/5 hover:bg-red-500/20 text-red-400 rounded-lg transition-colors" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                            <button onClick={() => { setSelectedId(null); setMoveModeId(null); }} className="p-1.5 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white rounded-lg transition-colors" title="Deselect"><X className="w-3.5 h-3.5" /></button>
                        </div>
                    </div>
                </div>
            )}

            {/* Timeline Bottom Section (FIXED PLAYHEAD & LIVE TRACK) */}
            <div className="h-36 sm:h-44 md:h-52 bg-[#1a1a1a] border-t border-white/10 flex flex-col shrink-0 relative overflow-hidden select-none" ref={timelineRef} style={{ touchAction: 'none' }}>
                
                {snapNotification && (
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3.5 py-1.5 bg-red-950/95 border border-red-500/50 text-red-100 rounded-full shadow-2xl text-xs font-semibold backdrop-blur-md transition-all">
                        <Youtube className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        <span>{snapNotification}</span>
                        <button onClick={() => setSnapNotification(null)} className="ml-1 text-red-300/60 hover:text-white">
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                )}

                {/* Live Floating Pinch Zoom Indicator */}
                {pinchZoomFeedback !== null && (
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-3 py-1 bg-red-950/95 border border-red-400 text-red-300 rounded-full shadow-2xl text-xs font-mono font-bold backdrop-blur-md pointer-events-none animate-in fade-in duration-100">
                        <ZoomIn className="w-3.5 h-3.5 text-red-400 animate-pulse" />
                        <span>Pinch Zoom: {Math.round(pinchZoomFeedback)} px/s</span>
                    </div>
                )}

                {/* Static Center Mark (Playhead Timeframe Center) */}
                <div className="absolute top-0 bottom-0 w-px bg-red-500/80 z-20 pointer-events-none left-1/2 -translate-x-1/2">
                    <div ref={currentTimeTextRef} className="absolute top-0 left-1/2 -translate-x-1/2 bg-red-500 text-white text-[10px] font-mono px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap z-50">
                        {formatTimeWithMs(currentTime)}
                    </div>
                </div>
                <div className="absolute top-0 w-3 h-3 border-t-[6px] border-t-red-500/80 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent z-20 pointer-events-none left-1/2 -translate-x-1/2 mt-4"></div>

                {/* Dynamic Playhead */}
                <div 
                    className="absolute top-0 bottom-0 w-px bg-white z-30 pointer-events-none -translate-x-1/2 transition-opacity duration-200"
                    style={{ 
                        left: `${(containerWidth / 2) + ((currentTime - effectiveTimeForTrack) / 1000) * activeZoom}px`,
                        opacity: currentTime === effectiveTimeForTrack ? 1 : 0.5
                    }}
                >
                    <div className="absolute -top-0 -translate-x-1/2 w-3 h-3 bg-white rounded-sm drop-shadow-md"></div>
                </div>

                <div 
                    ref={trackContainerRef}
                    className="absolute top-0 left-0 h-full will-change-transform cursor-grab active:cursor-grabbing touch-none select-none"
                    style={{ 
                        width: `${timelineWidth}px`, 
                        transform: `translateX(${trackOffset}px)`,
                        touchAction: 'none'
                    }}
                    onPointerDown={(e) => handlePointerDown(e, 'scrub')}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                >
                    {/* Ruler Ticks */}
                    <div className="absolute top-0 left-0 w-full h-7 sm:h-8 border-b border-white/5 bg-[#222]">
                        {visibleTicks.map(i => {
                            const timeInSeconds = i * tickInterval;
                            return (
                                <div key={i} className="absolute top-0 h-full border-l border-white/10 flex items-end pb-1" style={{ left: `${timeInSeconds * activeZoom}px` }}>
                                    <span className="text-[10px] text-white/40 font-mono pointer-events-none whitespace-nowrap -translate-x-1/2 ml-px absolute bottom-0.5 sm:bottom-1">
                                        {formatTimeWithMs(timeInSeconds * 1000)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>

                    {/* Subtitle Track */}
                    <div className="absolute top-8 sm:top-11 left-0 w-full h-14 sm:h-16 bg-black/20 border-y border-white/5 flex items-center">
                        {dragHUD && (dragHUD.type === 'move' || dragHUD.type === 'sync_move') && (
                            <div 
                                className="absolute h-11 sm:h-12 rounded-md border-2 border-dashed border-white/40 bg-white/5 pointer-events-none z-10 flex items-center justify-center transition-opacity"
                                style={{ 
                                    left: `${(dragHUD.initStart / 1000) * activeZoom}px`, 
                                    width: `${Math.max(((dragHUD.initEnd - dragHUD.initStart) / 1000) * activeZoom, 2)}px` 
                                }}
                            >
                                <span className="text-[9px] font-mono font-bold text-white/70 bg-black/80 px-1.5 py-0.5 rounded shadow whitespace-nowrap border border-white/10">
                                    Origin: {formatTimeWithMs(dragHUD.initStart)}
                                </span>
                            </div>
                        )}

                        {blocks.map(block => {
                            const isSelected = block.id === selectedId;
                            const isDragging = block.id === draggingId;
                            const isMoveMode = block.id === moveModeId && !block.isLocked;
                            const left = (block.start / 1000) * activeZoom;
                            const width = ((block.end - block.start) / 1000) * activeZoom;
                            const isCompact = width < 68;
                            
                            const bgClass = block.isLocked 
                                ? (isSelected ? 'bg-amber-900/60 border-y-2 border-amber-500 z-20' : 'bg-zinc-800/80 border border-zinc-600 hover:bg-zinc-700/80')
                                : (isDragging ? 'bg-emerald-500/40 border-2 border-emerald-400 ring-2 ring-emerald-400/40 shadow-[0_0_20px_rgba(16,185,129,0.4)] z-40'
                                    : isMoveMode ? 'bg-red-500/40 border-y-2 border-red-400 z-30 hover:bg-red-500/50'
                                    : isSelected ? 'bg-amber-500/25 border-y-2 border-amber-400 z-20'
                                    : 'bg-red-600/80 border border-red-500/50 hover:bg-red-500');

                            const cursorClass = block.isLocked ? 'cursor-pointer' : (isDragging ? 'cursor-grabbing' : (isMoveMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'));
                            
                            return (
                                <div 
                                    key={block.id}
                                    className={`absolute h-11 sm:h-12 rounded-md shadow-md flex items-center overflow-visible transition-colors select-none box-border touch-none ${bgClass} ${cursorClass}`}
                                    style={{ left: `${left}px`, width: `${Math.max(width, 1)}px`, touchAction: 'none' }}
                                    onPointerDown={(e) => handlePointerDown(e, (block.isLocked || !isMoveMode) ? 'select_only' : (dragMode === 'sync' ? 'sync_move' : 'move'), block.id, block)}
                                    onDoubleClick={(e) => { e.stopPropagation(); setSelectedId(block.id); setIsEditingText(true); }}
                                    onDragStart={(e) => e.preventDefault()}
                                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                >
                                    {/* Live Timing HUD Tooltip */}
                                    {isDragging && dragHUD && dragHUD.id === block.id && (
                                        <div className="absolute -top-14 left-1/2 -translate-x-1/2 pointer-events-none z-50 flex flex-col items-center whitespace-nowrap drop-shadow-2xl select-none">
                                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold shadow-2xl border backdrop-blur-md bg-zinc-900/95 text-white border-white/40">
                                                <span className="text-xs font-black tracking-wide">
                                                    {dragHUD.deltaMs > 0 ? `+${(dragHUD.deltaMs / 1000).toFixed(2)}s` : dragHUD.deltaMs < 0 ? `${(dragHUD.deltaMs / 1000).toFixed(2)}s` : '0.00s'}
                                                </span>
                                                <span className="text-white/40 font-normal">|</span>
                                                <span className="text-[10px] font-semibold text-white/90">
                                                    {formatTimeWithMs(dragHUD.newStart)} → {formatTimeWithMs(dragHUD.newEnd)}
                                                </span>
                                            </div>
                                        </div>
                                    )}

                                    {/* Left Trim Handle */}
                                    {isSelected && (
                                        <div 
                                            className={`absolute left-0 top-0 bottom-0 ${isCompact ? 'w-4 sm:w-3' : 'w-8 sm:w-5'} ${isDragging ? 'bg-emerald-400' : 'bg-amber-400'} cursor-ew-resize flex items-center justify-center z-10 touch-none select-none shadow-[2px_0_4px_rgba(0,0,0,0.3)] rounded-l-md`}
                                            style={{ touchAction: 'none' }}
                                            onPointerDown={(e) => handlePointerDown(e, dragMode === 'sync' ? 'sync_start' : 'start', block.id, block)}
                                        >
                                            <div className="w-1 h-5 sm:h-4 bg-white/80 rounded-full pointer-events-none" />
                                            <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-black text-white text-[10px] px-1.5 py-0.5 rounded font-mono shadow-md pointer-events-none whitespace-nowrap">
                                                {formatTimeWithMs(block.start)}
                                            </div>
                                        </div>
                                    )}
                                    
                                    <p className={`text-[11px] font-bold text-white truncate pointer-events-none select-none w-full flex items-center justify-center gap-1 drop-shadow-md ${isSelected ? (isCompact ? 'px-4 sm:px-3' : 'px-10 sm:px-8') : 'px-2'}`}>
                                        {block.isLocked && <Lock className="w-3 h-3 text-white/50 shrink-0" />}
                                        <span className="truncate">{block.text || '...'}</span>
                                    </p>

                                    {/* Direct Edit Button on Selected Subtitle Box */}
                                    {isSelected && width >= 72 && (
                                        <button
                                            type="button"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setSelectedId(block.id);
                                                setIsEditingText(true);
                                            }}
                                            className="absolute -top-7 right-0 bg-red-600 hover:bg-red-500 active:scale-95 text-white text-[10px] px-2 py-0.5 rounded font-sans font-bold shadow-md flex items-center gap-1 z-30 cursor-pointer border border-red-400/40"
                                            title="Edit Subtitle Text"
                                        >
                                            <Edit3 className="w-3 h-3" />
                                            <span>Edit</span>
                                        </button>
                                    )}

                                    {/* Right Trim Handle */}
                                    {isSelected && (
                                        <div 
                                            className={`absolute right-0 top-0 bottom-0 ${isCompact ? 'w-4 sm:w-3' : 'w-8 sm:w-5'} ${isDragging ? 'bg-emerald-400' : 'bg-amber-400'} cursor-ew-resize flex items-center justify-center z-10 touch-none select-none shadow-[-2px_0_4px_rgba(0,0,0,0.3)] rounded-r-md`}
                                            style={{ touchAction: 'none' }}
                                            onPointerDown={(e) => handlePointerDown(e, dragMode === 'sync' ? 'sync_end' : 'end', block.id, block)}
                                        >
                                            <div className="w-1 h-5 sm:h-4 bg-white/80 rounded-full pointer-events-none" />
                                            <div className="absolute -top-7 left-1/2 -translate-x-1/2 bg-black text-white text-[10px] px-1.5 py-0.5 rounded font-mono shadow-md pointer-events-none whitespace-nowrap">
                                                {formatTimeWithMs(block.end)}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {/* YouTube URL Modal */}
            {showYoutubeInputModal && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={() => setShowYoutubeInputModal(false)}>
                    <div className="bg-[#1a1a1a] border border-white/20 p-6 rounded-2xl shadow-2xl max-w-md w-full flex flex-col gap-4" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-bold text-white flex items-center gap-2">
                                <Youtube className="w-5 h-5 text-red-500" />
                                <span>Load YouTube Video</span>
                            </h4>
                            <button onClick={() => setShowYoutubeInputModal(false)} className="text-white/40 hover:text-white"><X className="w-5 h-5" /></button>
                        </div>
                        <input
                            type="text"
                            value={youtubeInputVal}
                            onChange={(e) => setYoutubeInputVal(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleApplyYoutubeUrl(youtubeInputVal);
                            }}
                            placeholder="Paste YouTube link (e.g. https://youtu.be/...)"
                            className="w-full bg-black/60 border border-white/10 rounded-xl px-4 py-3 text-xs text-white outline-none focus:border-red-500 font-mono"
                            autoFocus
                        />
                        <div className="flex items-center justify-end gap-2">
                            <button onClick={() => setShowYoutubeInputModal(false)} className="px-4 py-2 bg-white/5 hover:bg-white/10 text-white/70 rounded-xl text-xs font-semibold">Cancel</button>
                            <button onClick={() => handleApplyYoutubeUrl(youtubeInputVal)} className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded-xl text-xs font-bold shadow">Load & Sync</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Text Edit Modal */}
            {isEditingText && selectedBlock && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4" onClick={() => setIsEditingText(false)}>
                    <div className="bg-[#1a1a1a] border border-white/20 p-4 sm:p-6 rounded-2xl shadow-2xl max-w-lg w-full flex flex-col gap-3 sm:gap-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <Edit2 className="w-4 h-4 text-red-400" />
                                <h4 className="text-sm font-bold text-white">Edit Subtitle Text</h4>
                            </div>
                            <span className="text-xs text-white/50 font-mono">
                                {formatTimeWithMs(selectedBlock.start)} → {formatTimeWithMs(selectedBlock.end)}
                            </span>
                            <button onClick={() => setIsEditingText(false)} className="text-white/40 hover:text-white p-1">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* In-Modal Notification Banner */}
                        {editorNotification && (
                            <div className="px-3 py-2 bg-indigo-500/20 border border-indigo-500/40 rounded-xl text-xs text-indigo-300 font-medium animate-in fade-in flex items-center gap-2">
                                <Sparkles className="w-3.5 h-3.5 shrink-0 text-indigo-400" />
                                <span className="truncate">{editorNotification}</span>
                            </div>
                        )}

                        {/* Multi-sentence / Long Text Warning & 1-Click Split Action */}
                        {(() => {
                            const l1 = (selectedBlock.text || '').split('\n')[0] || '';
                            const l2 = (selectedBlock.text || '').split('\n').slice(1).join(' ') || '';
                            const s1Count = splitSentences(l1).length;
                            const s2Count = splitSentences(l2).length;
                            const sCount = Math.max(s1Count, s2Count);
                            const isLong = sCount >= 2 || (selectedBlock.text || '').length > 60;
                            if (!isLong) return null;

                            return (
                                <div className="p-2.5 bg-amber-500/15 border border-amber-500/40 rounded-xl flex items-center justify-between gap-2 animate-in fade-in">
                                    <div className="flex items-center gap-2 min-w-0">
                                        <Scissors className="w-4 h-4 text-amber-400 shrink-0" />
                                        <div className="text-[11px] leading-tight text-amber-200">
                                            <p className="font-bold">{sCount >= 2 ? `${sCount} sentences in this cue` : 'Long text in this cue'}</p>
                                            <p className="text-[10px] text-amber-300/70">Split into concise individual boxes for clean mobile display</p>
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            splitBlockSentences();
                                            setIsEditingText(false);
                                        }}
                                        className="shrink-0 px-2.5 py-1.5 bg-amber-500 hover:bg-amber-400 text-black font-extrabold text-[11px] rounded-lg transition-all flex items-center gap-1 shadow cursor-pointer active:scale-95"
                                    >
                                        <Scissors className="w-3 h-3" />
                                        <span>Split into {sCount >= 2 ? `${sCount} Boxes` : '2 Boxes'}</span>
                                    </button>
                                </div>
                            );
                        })()}

                        {/* Mode Selector & Format Info */}
                        <div className="flex items-center justify-between pb-0.5">
                            <div className="flex items-center gap-1 bg-black/40 p-0.5 rounded-lg border border-white/10 text-[10px]">
                                <button
                                    type="button"
                                    onClick={() => setEditBoxMode('split')}
                                    className={`px-2.5 py-1 rounded-md font-bold transition-all cursor-pointer ${
                                        editBoxMode === 'split' 
                                            ? 'bg-red-600 text-white shadow' 
                                            : 'text-white/50 hover:text-white'
                                    }`}
                                >
                                    Dual Lines (L1/L2)
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setEditBoxMode('raw')}
                                    className={`px-2.5 py-1 rounded-md font-bold transition-all cursor-pointer ${
                                        editBoxMode === 'raw' 
                                            ? 'bg-red-600 text-white shadow' 
                                            : 'text-white/50 hover:text-white'
                                    }`}
                                >
                                    Raw Text
                                </button>
                            </div>
                            <span className="text-[10px] text-white/50 font-mono">
                                Target: <strong className="text-emerald-400 font-sans">{localStorage.getItem('ai_sub_tgt_lang') || 'English'}</strong>
                            </span>
                        </div>

                        {/* Text Editor Area */}
                        {editBoxMode === 'split' ? (
                            (() => {
                                const lines = (selectedBlock.text || '').split('\n');
                                const line1 = lines[0] || '';
                                const line2 = lines.slice(1).join('\n') || '';
                                const targetLang = localStorage.getItem('ai_sub_tgt_lang') || 'English';

                                return (
                                    <div className="flex flex-col gap-2">
                                        {/* Line 1 - Original / Native */}
                                        <div className="flex flex-col gap-1 bg-black/50 p-2.5 rounded-xl border border-white/10 focus-within:border-red-500/50 transition-colors">
                                            <div className="flex items-center justify-between">
                                                <label className="text-[10px] font-bold text-red-400 uppercase tracking-wide flex items-center gap-1.5">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                                                    Line 1 • Original (Native)
                                                </label>
                                                <button
                                                    type="button"
                                                    disabled={!line1.trim() || quickTranslatingLine !== null}
                                                    onClick={() => handleQuickTranslate('l1')}
                                                    className="flex items-center gap-1 px-2 py-0.5 bg-red-600/20 hover:bg-red-600/40 text-red-300 hover:text-white rounded-md text-[10px] font-bold border border-red-500/30 transition-all disabled:opacity-40 cursor-pointer"
                                                    title="Translate Line 1 to Line 2 instantly (⚡ <1s)"
                                                >
                                                    {quickTranslatingLine === 'l1' ? (
                                                        <div className="w-2.5 h-2.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                    ) : (
                                                        <Sparkles className="w-2.5 h-2.5 text-yellow-300" />
                                                    )}
                                                    <span>⚡ Sync to Line 2</span>
                                                </button>
                                            </div>
                                            <textarea
                                                value={line1}
                                                onChange={(e) => {
                                                    const newL1 = e.target.value;
                                                    updateSelectedText(newL1 + (line2 ? '\n' + line2 : ''));
                                                }}
                                                placeholder="Type original dialogue/lyrics here..."
                                                className="w-full bg-transparent text-sm text-white font-medium outline-none resize-none h-14 custom-scrollbar leading-relaxed placeholder:text-white/20"
                                                autoFocus
                                            />
                                        </div>

                                        {/* Line 2 - Translation */}
                                        <div className="flex flex-col gap-1 bg-black/50 p-2.5 rounded-xl border border-white/10 focus-within:border-emerald-500/50 transition-colors">
                                            <div className="flex items-center justify-between">
                                                <label className="text-[10px] font-bold text-emerald-400 uppercase tracking-wide flex items-center gap-1.5">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                                    Line 2 • Translation ({targetLang})
                                                </label>
                                                <button
                                                    type="button"
                                                    disabled={!line2.trim() || quickTranslatingLine !== null}
                                                    onClick={() => handleQuickTranslate('l2')}
                                                    className="flex items-center gap-1 px-2 py-0.5 bg-emerald-600/20 hover:bg-emerald-600/40 text-emerald-300 hover:text-white rounded-md text-[10px] font-bold border border-emerald-500/30 transition-all disabled:opacity-40 cursor-pointer"
                                                    title="Derive native Line 1 from Line 2 translation"
                                                >
                                                    {quickTranslatingLine === 'l2' ? (
                                                        <div className="w-2.5 h-2.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                                    ) : (
                                                        <Sparkles className="w-2.5 h-2.5 text-yellow-300" />
                                                    )}
                                                    <span>⚡ Sync to Line 1</span>
                                                </button>
                                            </div>
                                            <textarea
                                                value={line2}
                                                onChange={(e) => {
                                                    const newL2 = e.target.value;
                                                    updateSelectedText((line1 || '') + '\n' + newL2);
                                                }}
                                                placeholder="Type or adjust translation directly here (instant sync)..."
                                                className="w-full bg-transparent text-sm text-emerald-200 font-medium outline-none resize-none h-14 custom-scrollbar leading-relaxed placeholder:text-white/20"
                                            />
                                        </div>

                                        <div className="flex items-center justify-between text-[11px] text-white/40 px-1">
                                            <div className="flex items-center gap-2">
                                                <span>{selectedBlock.text.length} chars</span>
                                                <span>•</span>
                                                <button 
                                                    type="button" 
                                                    onClick={() => seekTo(selectedBlock.start, false)} 
                                                    className="text-red-400 hover:text-red-300 flex items-center gap-1 font-mono hover:underline"
                                                >
                                                    <Play className="w-2.5 h-2.5 fill-current" /> Play
                                                </button>
                                            </div>
                                            {selectedBlock.text && (
                                                <button 
                                                    type="button" 
                                                    onClick={() => updateSelectedText("")}
                                                    className="text-white/40 hover:text-red-400 transition-colors"
                                                >
                                                    Clear text
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                );
                            })()
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                <textarea
                                    value={selectedBlock.text}
                                    onChange={(e) => updateSelectedText(e.target.value)}
                                    className="w-full h-32 bg-black/60 border border-white/10 rounded-xl p-3 sm:p-4 text-sm text-white outline-none focus:border-red-500 resize-none font-sans"
                                    placeholder="Type subtitle text here..."
                                    autoFocus
                                />
                                <div className="flex items-center justify-between text-[11px] text-white/40 px-1">
                                    <div className="flex items-center gap-2">
                                        <span>{selectedBlock.text.length} chars</span>
                                        <span>•</span>
                                        <button 
                                            type="button" 
                                            onClick={() => seekTo(selectedBlock.start, false)} 
                                            className="text-red-400 hover:text-red-300 flex items-center gap-1 font-mono hover:underline"
                                        >
                                            <Play className="w-2.5 h-2.5 fill-current" /> Play
                                        </button>
                                    </div>
                                    {selectedBlock.text && (
                                        <button 
                                            type="button" 
                                            onClick={() => updateSelectedText("")}
                                            className="text-white/40 hover:text-red-400 transition-colors"
                                        >
                                            Clear text
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Subtitle AI Correction & Tools */}
                        <div className="flex flex-col gap-2 pt-2 border-t border-white/10">
                            {/* Multimodal AI Fix Suite */}
                            <div className="grid grid-cols-3 gap-1.5 w-full">
                                <button
                                    type="button"
                                    onClick={() => setShowFrameTranslate(true)}
                                    disabled={isVisionFixing || isAudioFixing || !!isSyncingTranslation || isUploadingMedia}
                                    className="py-2 px-2 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-fuchsia-300 hover:text-white border border-fuchsia-500/30 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm cursor-pointer"
                                    title="Capture screen frame or video player, detect on-screen text, and translate into subtitles"
                                >
                                    <Camera className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />
                                    <span className="truncate">Vision</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={() => handleVisionFix('frame')}
                                    disabled={!selectedBlock.text || isVisionFixing || isAudioFixing || !!isSyncingTranslation || isUploadingMedia}
                                    className="py-2 px-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 hover:text-white border border-indigo-500/30 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm cursor-pointer"
                                    title="Capture video frame at timestamp and analyze on-screen text to fix dialogue"
                                >
                                    {isVisionFixing && !isUploadingMedia ? (
                                        <div className="w-3.5 h-3.5 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin shrink-0" />
                                    ) : (
                                        <Scan className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                    )}
                                    <span className="truncate">Vision Fix</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={handleHearFix}
                                    disabled={!selectedBlock.text || isVisionFixing || isAudioFixing || !!isSyncingTranslation || isUploadingMedia}
                                    className="py-2 px-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 hover:text-white border border-emerald-500/30 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm cursor-pointer"
                                    title="Listen to audio at this timestamp with Agentic Audio to correct misheard words"
                                >
                                    {isAudioFixing || isUploadingMedia ? (
                                        <div className="w-3.5 h-3.5 border-2 border-emerald-400/30 border-t-emerald-400 rounded-full animate-spin shrink-0" />
                                    ) : (
                                        <AudioWaveform className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                    )}
                                    <span className="truncate">{isAudioFixing ? 'Listening...' : 'Hear Fix'}</span>
                                </button>
                            </div>

                            {/* Translation Sync Tools */}
                            {selectedBlock.text && (
                                selectedBlock.text.includes('\n') ? (
                                    <div className="grid grid-cols-3 gap-1.5 w-full">
                                        <button
                                            type="button"
                                            onClick={() => handleSyncTranslation('line1')}
                                            disabled={!!isSyncingTranslation || isVisionFixing || isAudioFixing}
                                            className="py-1.5 px-2 bg-white/5 hover:bg-white/10 text-white/80 hover:text-white rounded-lg text-[11px] font-medium transition-colors flex items-center justify-center gap-1 border border-white/10 disabled:opacity-40 cursor-pointer"
                                            title="Sync translation using Line 1 as source of truth"
                                        >
                                            {isSyncingTranslation === 'line1' ? (
                                                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin shrink-0" />
                                            ) : (
                                                <Languages className="w-3 h-3 text-red-400 shrink-0" />
                                            )}
                                            <span className="truncate">Sync L1➔L2</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleSyncTranslation('line2')}
                                            disabled={!!isSyncingTranslation || isVisionFixing || isAudioFixing}
                                            className="py-1.5 px-2 bg-white/5 hover:bg-white/10 text-white/80 hover:text-white rounded-lg text-[11px] font-medium transition-colors flex items-center justify-center gap-1 border border-white/10 disabled:opacity-40 cursor-pointer"
                                            title="Derive native text using Line 2 as source of truth"
                                        >
                                            {isSyncingTranslation === 'line2' ? (
                                                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin shrink-0" />
                                            ) : (
                                                <Languages className="w-3 h-3 text-red-400 shrink-0" />
                                            )}
                                            <span className="truncate">Sync L2➔L1</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleSyncTranslation()}
                                            disabled={!!isSyncingTranslation || isVisionFixing || isAudioFixing}
                                            className="py-1.5 px-2 bg-white/5 hover:bg-white/10 text-white/80 hover:text-white rounded-lg text-[11px] font-medium transition-colors flex items-center justify-center gap-1 border border-white/10 disabled:opacity-40 cursor-pointer"
                                            title="Auto-translate and match configured subtitle format"
                                        >
                                            {isSyncingTranslation === 'all' ? (
                                                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin shrink-0" />
                                            ) : (
                                                <Sparkles className="w-3 h-3 text-yellow-300 shrink-0" />
                                            )}
                                            <span className="truncate">Sync All</span>
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => handleSyncTranslation()}
                                        disabled={!!isSyncingTranslation || isVisionFixing || isAudioFixing}
                                        className="w-full py-1.5 px-3 bg-white/5 hover:bg-white/10 text-white/80 hover:text-white rounded-lg text-[11px] font-medium transition-colors flex items-center justify-center gap-1.5 border border-white/10 disabled:opacity-40 cursor-pointer"
                                        title="Auto-translate and expand into project subtitle format"
                                    >
                                        {isSyncingTranslation === 'all' ? (
                                            <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin shrink-0" />
                                        ) : (
                                            <Languages className="w-3 h-3 text-red-400 shrink-0" />
                                        )}
                                        <span>Sync Translation</span>
                                    </button>
                                )
                            )}

                            {/* Done Button */}
                            <button 
                                type="button" 
                                onClick={() => setIsEditingText(false)}
                                className="w-full py-2.5 px-4 bg-red-600 hover:bg-red-500 active:scale-98 text-white rounded-xl text-xs sm:text-sm font-bold shadow-lg shadow-red-600/30 flex items-center justify-center gap-1.5 transition-all mt-1 cursor-pointer"
                            >
                                <Check className="w-4 h-4" />
                                <span>Done</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Frame Translation Modal */}
            {showFrameTranslate && selectedBlock && (
                <FrameTranslateModal
                    isOpen={showFrameTranslate}
                    onClose={() => setShowFrameTranslate(false)}
                    currentText={selectedBlock.text}
                    onApplyText={(newText) => {
                        setBlocksAndNotify(prev => prev.map(b => b.id === selectedBlock.id ? { ...b, text: newText } : b));
                    }}
                    apiKey={apiKey}
                    currentTimeFormatted={`${formatTimeWithMs(selectedBlock.start)} → ${formatTimeWithMs(selectedBlock.end)}`}
                />
            )}

            {/* Export Modal */}
            {showExportModal && (
                <ExportModal
                    onClose={() => setShowExportModal(false)}
                    onExport={executeExport}
                    defaultName="youtube_subtitles.srt"
                />
            )}

            {/* Bulk Text Tools Modal */}
            {showTextTools && (
                <BulkTextToolsModal
                    onClose={() => setShowTextTools(false)}
                    blocks={blocks as any}
                    onApply={setBlocksAndNotify as any}
                    apiKey={apiKey}
                />
            )}
        </div>
    );
};
