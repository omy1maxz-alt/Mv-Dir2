import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Upload, Download, Split, Copy, Trash2, Plus, Play, Pause, RotateCcw, RotateCw, ZoomIn, ZoomOut, Type, X, Edit2, Edit3, GripHorizontal, Camera, Settings, Maximize, Clock, ListTree, Scan, Move, Scissors, FilePlus, Undo, Redo, Lock, Unlock, AudioWaveform, Magnet, Wand2, Sparkles, Sliders, Tv, Check, ChevronLeft, ChevronRight, Languages, FileText, RefreshCw, ClipboardPaste, AlertTriangle, FastForward, Rewind, ArrowRight, Youtube, Link, ExternalLink, Film, Image as ImageIcon, Volume2, VolumeX } from 'lucide-react';
import { BulkTextToolsModal } from "./BulkTextToolsModal";
import { ExportModal } from "./ExportModal";
import { FrameTranslateModal } from "./FrameTranslateModal";
import { captureScreenFrame } from "../utils/frameCapture";
import { AudioEnergyProfile, analyzeAudioFile, snapBlockToAudio, snapAllBlocksToAudio } from '../utils/audioSnap';
import { alignSingleBlockWithGemini, alignAllSubtitlesWithGemini, generateYouTubeSRT } from '../services/gemini_srt';
import { syncSubtitleTranslations, translateSingleLine, fixSubtitleWithAgenticVideo, fixSubtitleWithAudio, uploadVideoToGemini, fixSubtitleWithFrame, getEffectiveGeminiApiKey } from '../services/gemini';
import { normalizeYoutubeUrl, downloadYouTubeMediaStream } from '../services/youtube';
import { smartSplitCueText, splitSingleBlockBySentences, splitSentences } from '../utils/subtitleParser';
import { isVideoFile, isAudioFile, isMediaFile } from '../utils/mediaUtils';

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
    
    // Minute shortcut e.g. "-10m", "-10min", "5m"
    const minMatch = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*m(?:in)?$/i);
    if (minMatch) {
        return Math.round(parseFloat(minMatch[1]) * 60 * 1000);
    }

    // Second shortcut e.g. "-10s", "5s"
    const secMatch = trimmed.match(/^([+-]?\d+(?:\.\d+)?)\s*s(?:ec)?$/i);
    if (secMatch) {
        return Math.round(parseFloat(secMatch[1]) * 1000);
    }

    // Timecode e.g. "-10:00" or "+01:30" or "00:10:00,000" or "-00:10:00"
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

    // Raw seconds fallback e.g. "-600", "9.6"
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

interface SubtitleTimelineEditorProps {
    initialContent: string;
    audioFile: File | null;
    visualMediaFile?: File | null;
    onVisualMediaChange?: (file: File | null) => void;
    youtubeUrl?: string | null;
    autoPlayTrigger?: number;
    onContentChange?: (content: string) => void;
    onYoutubeUrlChange?: (url: string) => void;
    apiKey?: string;
    onMediaSwap?: (file: File) => void;
}

// Resilient SRT parser and generator
const parseSrt = (srt: string): SubtitleBlock[] => {
    if (!srt || srt.trim() === '') return [];
    
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

        // Support both HH:MM:SS,mmm and HH:MM:SS.mmm, with 1-3 digit hours and missing hours fallback
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
            // MM:SS,mmm fallback
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

export const SubtitleTimelineEditor: React.FC<SubtitleTimelineEditorProps> = ({ 
    initialContent, 
    audioFile, 
    visualMediaFile: visualMediaFileProp,
    onVisualMediaChange,
    youtubeUrl, 
    autoPlayTrigger, 
    onContentChange, 
    onYoutubeUrlChange, 
    apiKey, 
    onMediaSwap 
}) => {
    const [blocksState, setBlocksState] = useState<SubtitleBlock[]>([]);
    const blocks = blocksState;
    const [showExportModal, setShowExportModal] = useState(false);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draggingId, setDraggingId] = useState<string | null>(null);

    const [localYoutubeUrl, setLocalYoutubeUrl] = useState<string | null>(youtubeUrl || null);
    const [youtubeQuality, setYoutubeQuality] = useState<string>('auto');
    const [showQualityMenu, setShowQualityMenu] = useState(false);
    const [showYoutubeInputModal, setShowYoutubeInputModal] = useState(false);
    const [youtubeInputVal, setYoutubeInputVal] = useState(youtubeUrl || '');
    const [youtubeError, setYoutubeError] = useState(false);
    const lastAutoPlayTriggerRef = useRef<number>(0);

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
            setYoutubeError(false);
            
            // Allow DOM transition from hidden/display:none to layout flush
            const timer = setTimeout(() => {
                const startPlayback = () => {
                    if (mediaRef.current) {
                        const el = mediaRef.current as HTMLMediaElement;
                        if (el.ended || (el.duration && el.duration > 0 && el.currentTime >= el.duration - 0.2)) {
                            el.currentTime = 0;
                            setCurrentTime(0);
                        }
                        const p = el.play();
                        if (p !== undefined) {
                            p.then(() => {
                                setIsPlaying(true);
                            }).catch(e => {
                                console.warn('[Timeline Player] Auto-play unmuted rejected, retrying muted fallback:', e);
                                if (el instanceof HTMLVideoElement) {
                                    el.muted = true;
                                    setPrimaryMediaMuted(true);
                                    el.play().then(() => setIsPlaying(true)).catch(() => {});
                                }
                            });
                        } else {
                            setIsPlaying(true);
                        }
                    } else {
                        setIsPlaying(true);
                    }
                    if (visualVideoRef.current && visualVideoRef.current !== mediaRef.current) {
                        visualVideoRef.current.play().catch(() => {});
                    }
                };

                if (mediaRef.current) {
                    const el = mediaRef.current as HTMLMediaElement;
                    if (el.readyState >= 2) {
                        startPlayback();
                    } else {
                        el.addEventListener('canplay', () => startPlayback(), { once: true });
                        setTimeout(startPlayback, 250);
                    }
                } else {
                    startPlayback();
                }
            }, 120);

            return () => clearTimeout(timer);
        }
    }, [autoPlayTrigger]);

    const effectiveYoutubeUrl = localYoutubeUrl || youtubeUrl;
    const [useDirectEmbed, setUseDirectEmbed] = useState<boolean>(false);
    const youtubeVideoId = useMemo(() => {
        if (!effectiveYoutubeUrl) return null;
        const { videoId } = normalizeYoutubeUrl(effectiveYoutubeUrl);
        return videoId;
    }, [effectiveYoutubeUrl]);

    useEffect(() => {
        setYoutubeError(false);
    }, [effectiveYoutubeUrl]);

    const [isGeneratingYtSubtitles, setIsGeneratingYtSubtitles] = useState(false);

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
        console.info(`[YouTube Load] User pressed Load Video with input: "${raw}"`);
        const { url: clean, videoId, isValid } = normalizeYoutubeUrl(raw);
        console.info(`[YouTube Load] Parsed: clean="${clean}", videoId="${videoId}", isValid=${isValid}`);

        if (!isValid || !clean) {
            setSnapNotification("Invalid YouTube link: " + (raw || 'empty'));
            return;
        }

        setLocalYoutubeUrl(clean);
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
    const [isEditingText, setIsEditingText] = useState(false);
    const [showFrameTranslate, setShowFrameTranslate] = useState(false);
    const [isSyncingTranslation, setIsSyncingTranslation] = useState<false | 'line1' | 'line2' | 'all'>(false);
    const [isVisionFixing, setIsVisionFixing] = useState(false);
    const [isAudioFixing, setIsAudioFixing] = useState(false);
    const [uploadedFileUri, setUploadedFileUri] = useState<string | null>(null);
    const [isUploadingVideo, setIsUploadingVideo] = useState(false);
    const [showClearConfirm, setShowClearConfirm] = useState(false);
    
    useEffect(() => {
        setMoveModeId(null);
        if (!selectedId) {
            setIsEditingText(false);
        }
    }, [selectedId]);

    const [zoom, setZoom] = useState(100);
    const [pinchZoomFeedback, setPinchZoomFeedback] = useState<number | null>(null);
    const [dragMode, setDragMode] = useState<'normal' | 'sync'>('normal');
    const [moveModeId, setMoveModeId] = useState<string | null>(null);
    const [editBoxMode, setEditBoxMode] = useState<'split' | 'raw'>('split');
    const [quickTranslatingLine, setQuickTranslatingLine] = useState<'l1' | 'l2' | null>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [duration, setDuration] = useState(0);
    const [mediaUrl, setMediaUrl] = useState<string | null>(null);
    // Primary Audio/Video Media State (From AI Generator tab or manual file upload)
    const [localAudioFile, setLocalAudioFile] = useState<File | null>(audioFile || null);

    useEffect(() => {
        if (audioFile) {
            setLocalAudioFile(audioFile);
            setLocalYoutubeUrl(null);
            if (isVideoFile(audioFile)) {
                // If primary media from AI Generator is a video, clear companion visual view
                setLocalVisualMediaFile(null);
                if (onVisualMediaChange) onVisualMediaChange(null);
            }
        }
    }, [audioFile, onVisualMediaChange]);

    const effectiveAudioFile = audioFile || localAudioFile;
    const isPrimaryVideo = Boolean(effectiveAudioFile && isVideoFile(effectiveAudioFile));

    // Primary media audio/volume state (for when effectiveAudioFile is a Video containing both video + audio)
    const [primaryMediaMuted, setPrimaryMediaMuted] = useState<boolean>(false);
    const [primaryMediaVolume, setPrimaryMediaVolume] = useState<number>(1);

    useEffect(() => {
        if (mediaRef.current instanceof HTMLMediaElement && isPrimaryVideo) {
            mediaRef.current.muted = primaryMediaMuted;
            mediaRef.current.volume = primaryMediaMuted ? 0 : primaryMediaVolume;
        }
    }, [primaryMediaMuted, primaryMediaVolume, isPrimaryVideo]);

    // Visual Reference Media (Companion Video/Image used ONLY when primary media is Audio-only so user can match the view)
    const [localVisualMediaFile, setLocalVisualMediaFile] = useState<File | null>(visualMediaFileProp || null);

    useEffect(() => {
        if (visualMediaFileProp !== undefined) {
            setLocalVisualMediaFile(visualMediaFileProp);
        }
    }, [visualMediaFileProp]);

    // When primary media is already a video, companion visual media is completely bypassed
    const activeVisualMediaFile = isPrimaryVideo ? null : (visualMediaFileProp !== undefined ? visualMediaFileProp : localVisualMediaFile);
    const visualMediaFile = activeVisualMediaFile;
    const [visualMediaUrl, setVisualMediaUrl] = useState<string | null>(null);
    const visualVideoRef = useRef<HTMLVideoElement>(null);
    const visualMediaInputRef = useRef<HTMLInputElement>(null);
    const [playbackRate, setPlaybackRate] = useState<number>(1);

    // Audio/volume adjustment state for companion visual video view (when pairing a companion video with an audio track)
    const [visualVideoMuted, setVisualVideoMuted] = useState<boolean>(true);
    const [visualVideoVolume, setVisualVideoVolume] = useState<number>(0.5);
    
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
    const [syncOffset, setSyncOffset] = useState<number>(0);
    const [syncScope, setSyncScope] = useState<ShiftScope>('all');
    const [syncCustomInput, setSyncCustomInput] = useState<string>('');
    const [syncFromTimeInput, setSyncFromTimeInput] = useState<string>('');
    const [showExtractSettings, setShowExtractSettings] = useState(false);
    const [extractStart, setExtractStart] = useState<number>(0);
    const [extractEnd, setExtractEnd] = useState<number>(0);

    const [audioProfile, setAudioProfile] = useState<AudioEnergyProfile | null>(null);
    const [isAnalyzingAudio, setIsAnalyzingAudio] = useState(false);
    const [audioAnalysisError, setAudioAnalysisError] = useState<string | null>(null);
    const [snapNotification, setSnapNotification] = useState<string | null>(null);
    const [snappedBlockId, setSnappedBlockId] = useState<string | null>(null);

    // Detected large jumps / timing gaps (e.g. 10min jump)
    const detectedJumps = useMemo(() => findTimingJumps(blocks, 20000), [blocks]);
    const [showSnapSettings, setShowSnapSettings] = useState(false);
    const [showTextTools, setShowTextTools] = useState(false);

    // Gemini AI Semantic Alignment (Alt C) States
    const [isAiAligning, setIsAiAligning] = useState(false);
    const [aiAlignMode, setAiAlignMode] = useState<'single' | 'all' | null>(null);
    const [aiAlignProgress, setAiAlignProgress] = useState(0);
    const [aiAlignStatusText, setAiAlignStatusText] = useState<string>('');
    const [alignmentModalTab, setAlignmentModalTab] = useState<'ai' | 'amplitude'>('ai');

    const [showWaveform, setShowWaveform] = useState<boolean>(() => {
        const saved = localStorage.getItem('vlog_showWaveform');
        return saved !== null ? saved === 'true' : true;
    });
    const [snapSensitivity, setSnapSensitivity] = useState<number>(() => {
        const saved = localStorage.getItem('vlog_snapSensitivity');
        return saved ? Number(saved) : 0.22;
    });
    const [snapLeadIn, setSnapLeadIn] = useState<number>(() => {
        const saved = localStorage.getItem('vlog_snapLeadIn');
        return saved ? Number(saved) : 60;
    });
    const [snapTailPadding, setSnapTailPadding] = useState<number>(() => {
        const saved = localStorage.getItem('vlog_snapTailPadding');
        return saved ? Number(saved) : 100;
    });

    useEffect(() => {
        localStorage.setItem('vlog_showWaveform', showWaveform.toString());
    }, [showWaveform]);
    useEffect(() => {
        localStorage.setItem('vlog_snapSensitivity', snapSensitivity.toString());
    }, [snapSensitivity]);
    useEffect(() => {
        localStorage.setItem('vlog_snapLeadIn', snapLeadIn.toString());
    }, [snapLeadIn]);
    useEffect(() => {
        localStorage.setItem('vlog_snapTailPadding', snapTailPadding.toString());
    }, [snapTailPadding]);

    const waveformCanvasRef = useRef<HTMLCanvasElement>(null);
    const audioFileInputRef = useRef<HTMLInputElement>(null);

    // Selected Subtitle Action Bar (In/Out Bar) Horizontal Scroll State & Handlers
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

    // Auto-analyze audio whenever effectiveAudioFile changes
    useEffect(() => {
        if (!effectiveAudioFile) {
            setAudioProfile(null);
            setAudioAnalysisError(null);
            return;
        }

        let isCancelled = false;
        setIsAnalyzingAudio(true);
        setAudioAnalysisError(null);
        analyzeAudioFile(effectiveAudioFile)
            .then(profile => {
                if (!isCancelled) {
                    setAudioProfile(profile);
                    setIsAnalyzingAudio(false);
                }
            })
            .catch(err => {
                console.warn('[Timeline] Audio profile analysis skipped or failed:', err);
                if (!isCancelled) {
                    setIsAnalyzingAudio(false);
                    setAudioAnalysisError(err?.message || 'Audio profile analysis skipped');
                }
            });

        return () => {
            isCancelled = true;
        };
    }, [effectiveAudioFile]);

    // Auto-dismiss notification
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

    const fixTimingJump = (jump: DetectedTimingJump, mode: 'collapse' | 'offset', customOffsetMs?: number) => {
        let offsetMs: number;
        if (mode === 'collapse') {
            const desiredStart = jump.fromBlock.end + 800;
            offsetMs = desiredStart - jump.toBlock.start;
        } else {
            offsetMs = customOffsetMs !== undefined ? customOffsetMs : -jump.gapMs;
        }

        shiftSubtitles(offsetMs, 'from_selected', jump.toBlock.id);
        setSelectedId(jump.toBlock.id);
        seekTo(Math.max(0, jump.fromBlock.end - 1000), false);
    };
    
    const [containerWidth, setContainerWidth] = useState(0);
    
    const timelineRef = useRef<HTMLDivElement>(null);
    const trackContainerRef = useRef<HTMLDivElement>(null);
    const currentTimeTextRef = useRef<HTMLDivElement>(null);
    const lastVideoSeekRef = useRef<number>(0);
    const lastVideoSyncSeekRef = useRef<number>(0);
    const lastUserSeekTimeRef = useRef<number>(0);
    const lastSavedSessionTimeRef = useRef<number>(0);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const appendInputRef = useRef<HTMLInputElement>(null);
    const mediaRef = useRef<HTMLMediaElement>(null);
    const youtubeIframeRef = useRef<HTMLIFrameElement>(null);
    const playerContainerRef = useRef<HTMLDivElement>(null);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [videoHeightMode, setVideoHeightMode] = useState<'normal' | 'large'>('normal');

    const sendCommandToYouTube = useCallback((func: string, args: any[] = []) => {
        if (youtubeIframeRef.current && youtubeIframeRef.current.contentWindow) {
            try {
                youtubeIframeRef.current.contentWindow.postMessage(
                    JSON.stringify({
                        event: 'command',
                        func: func,
                        args: args
                    }),
                    '*'
                );
            } catch (e) {
                console.warn('[YouTube Default Player PostMessage]', e);
            }
        }
    }, []);

    const isSeekingOrDragging = useCallback(() => {
        return dragState.current.type !== null || (performance.now() - lastUserSeekTimeRef.current < 350);
    }, []);

    const seekTo = useCallback((ms: number, throttleVideo: boolean = false) => {
        lastUserSeekTimeRef.current = performance.now();
        const clampedMs = Math.max(0, ms);
        const now = performance.now();
        if (!throttleVideo || now - lastVideoSeekRef.current > 50) {
            if (effectiveYoutubeUrl) {
                const sec = clampedMs / 1000;
                sendCommandToYouTube('seekTo', [sec, true]);
            } else {
                if (mediaRef.current) {
                    (mediaRef.current as HTMLMediaElement).currentTime = clampedMs / 1000;
                }
                if (visualVideoRef.current) {
                    try {
                        const vid = visualVideoRef.current;
                        const vidDur = vid.duration;
                        const audioSec = clampedMs / 1000;
                        const targetSec = (vidDur && vidDur > 0 && !isNaN(vidDur) && audioSec >= vidDur)
                            ? (audioSec % vidDur)
                            : audioSec;
                        vid.currentTime = targetSec;
                    } catch (_) {}
                }
            }
            lastVideoSeekRef.current = now;
        }
        setCurrentTime(clampedMs);
        
        // Save to session storage on seek
        const mediaId = effectiveAudioFile?.name || effectiveYoutubeUrl || 'default';
        sessionStorage.setItem(`media_time_${mediaId}`, clampedMs.toString());
    }, [effectiveYoutubeUrl, effectiveAudioFile, sendCommandToYouTube]);
    
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

    const requestRef = useRef<number>(0);
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
    const maxZoom = containerWidth > 0 ? containerWidth / 0.2 : 5000; // 0.2s view (6 frames @ 30fps)
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
        if (effectiveYoutubeUrl) {
            setMediaUrl(effectiveYoutubeUrl);
        } else if (effectiveAudioFile) {
            const url = URL.createObjectURL(effectiveAudioFile);
            setMediaUrl(url);
            return () => URL.revokeObjectURL(url);
        } else {
            setMediaUrl(null);
        }
    }, [effectiveAudioFile, effectiveYoutubeUrl]);

    // Maintain visual media object URL lifecycle: automatically creates URL when file is set or restored, and cleans up
    useEffect(() => {
        if (activeVisualMediaFile) {
            const url = URL.createObjectURL(activeVisualMediaFile);
            setVisualMediaUrl(url);
            return () => {
                URL.revokeObjectURL(url);
            };
        } else {
            setVisualMediaUrl(null);
        }
    }, [activeVisualMediaFile]);

    // Synchronize volume and mute states to companion visual video element
    useEffect(() => {
        if (visualVideoRef.current) {
            visualVideoRef.current.muted = visualVideoMuted;
            visualVideoRef.current.volume = visualVideoMuted ? 0 : visualVideoVolume;
        }
    }, [visualVideoMuted, visualVideoVolume, visualMediaUrl]);

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

    // Sync playback speed to YouTube Default Player or local video/audio element
    useEffect(() => {
        if (effectiveYoutubeUrl) {
            sendCommandToYouTube('setPlaybackRate', [playbackRate]);
        } else {
            if (mediaRef.current && (mediaRef.current as HTMLMediaElement).playbackRate !== undefined) {
                try {
                    (mediaRef.current as HTMLMediaElement).playbackRate = playbackRate;
                } catch (e) {}
            }
            if (visualVideoRef.current && visualVideoRef.current.playbackRate !== undefined) {
                try {
                    visualVideoRef.current.playbackRate = playbackRate;
                } catch (e) {}
            }
        }
    }, [playbackRate, effectiveYoutubeUrl, sendCommandToYouTube]);

    // Continuous YouTube Default Player postMessage listener & sync handler
    useEffect(() => {
        if (!effectiveYoutubeUrl) return;

        // Periodic subscription ping to ensure YouTube iframe delivers info events
        const subscribeTimer = setInterval(() => {
            if (youtubeIframeRef.current && youtubeIframeRef.current.contentWindow) {
                try {
                    youtubeIframeRef.current.contentWindow.postMessage(
                        JSON.stringify({ event: 'listening' }),
                        '*'
                    );
                } catch (e) {}
            }
        }, 1000);

        const handleMessage = (event: MessageEvent) => {
            try {
                let data = event.data;
                if (typeof data === 'string') {
                    try { data = JSON.parse(data); } catch (_) { return; }
                }
                if (!data || typeof data !== 'object') return;

                // YouTube Default Player infoDelivery message containing currentTime, duration, playerState
                if (data.event === 'infoDelivery' && data.info) {
                    const info = data.info;
                    if (typeof info.currentTime === 'number' && !isSeekingOrDragging()) {
                        const ms = Math.round(info.currentTime * 1000);
                        setCurrentTime(ms);

                        // Throttle session storage save
                        const now = performance.now();
                        if (now - lastSavedSessionTimeRef.current > 1000) {
                            sessionStorage.setItem(`media_time_${effectiveYoutubeUrl}`, ms.toString());
                            lastSavedSessionTimeRef.current = now;
                        }
                    }
                    if (typeof info.duration === 'number' && info.duration > 0) {
                        setDuration(Math.round(info.duration * 1000));
                    }
                    if (typeof info.playerState === 'number') {
                        // 1 = PLAYING, 2 = PAUSED, 0 = ENDED, 3 = BUFFERING
                        if (info.playerState === 1 && !isPlaying) {
                            setIsPlaying(true);
                        } else if ((info.playerState === 2 || info.playerState === 0) && isPlaying) {
                            setIsPlaying(false);
                        }
                    }
                }

                // onStateChange message
                if (data.event === 'onStateChange' || (data.channel === 'widget' && data.info)) {
                    const state = typeof data.info === 'number' ? data.info : data.info?.playerState;
                    if (state === 1 && !isPlaying) setIsPlaying(true);
                    else if ((state === 2 || state === 0) && isPlaying) setIsPlaying(false);
                }
            } catch (e) {}
        };

        window.addEventListener('message', handleMessage);

        return () => {
            clearInterval(subscribeTimer);
            window.removeEventListener('message', handleMessage);
        };
    }, [effectiveYoutubeUrl, isPlaying, isSeekingOrDragging]);

    const updateTime = useCallback(() => {
        if (isSeekingOrDragging()) {
            if (isPlaying) {
                requestRef.current = requestAnimationFrame(updateTime);
            }
            return;
        }

        if (mediaRef.current) {
            const el = mediaRef.current as HTMLMediaElement;
            const newTimeMs = el.currentTime * 1000;
            setCurrentTime(newTimeMs);

            if (visualVideoRef.current && visualVideoRef.current !== mediaRef.current) {
                const vid = visualVideoRef.current;
                const vidDur = vid.duration;
                const audioSec = newTimeMs / 1000;

                // Loop or wrap target time so video keeps moving smoothly when audio is longer than video
                const targetSec = (vidDur && vidDur > 0 && !isNaN(vidDur))
                    ? (audioSec >= vidDur ? (audioSec % vidDur) : audioSec)
                    : audioSec;

                const diff = Math.abs(vid.currentTime - targetSec);
                const now = performance.now();
                // Avoid seek thrashing when video is actively seeking (prevents browser video decoder stall/freeze)
                if (diff > 0.35 && !vid.seeking && (now - lastVideoSyncSeekRef.current > 300)) {
                    try {
                        vid.currentTime = targetSec;
                        lastVideoSyncSeekRef.current = now;
                    } catch (_) {}
                }
                if (vid.paused && !el.paused) {
                    vid.play().catch(() => {});
                }
            }

            if (isPlaying && !el.ended) {
                requestRef.current = requestAnimationFrame(updateTime);
            }
            
            // Throttle session storage saves
            const now = performance.now();
            if (now - lastSavedSessionTimeRef.current > 1000) {
                const mediaId = effectiveAudioFile?.name || 'default';
                sessionStorage.setItem(`media_time_${mediaId}`, newTimeMs.toString());
                lastSavedSessionTimeRef.current = now;
            }
        } else if (visualVideoRef.current) {
            const newTimeMs = visualVideoRef.current.currentTime * 1000;
            setCurrentTime(newTimeMs);
            if (isPlaying && !visualVideoRef.current.ended) {
                requestRef.current = requestAnimationFrame(updateTime);
            }
        }
    }, [isPlaying, effectiveAudioFile, isSeekingOrDragging]);

    useEffect(() => {
        if (!effectiveYoutubeUrl && isPlaying) {
            requestRef.current = requestAnimationFrame(updateTime);
        }
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [effectiveYoutubeUrl, isPlaying, updateTime]);

    const handleMediaLoadedMetadata = () => {
        if (mediaRef.current) {
            setDuration(mediaRef.current.duration * 1000);
            
            // Restore playback position
            const mediaId = effectiveAudioFile?.name || effectiveYoutubeUrl || 'default';
            const savedTimeStr = sessionStorage.getItem(`media_time_${mediaId}`);
            if (savedTimeStr) {
                const timeMs = parseFloat(savedTimeStr);
                if (!isNaN(timeMs) && timeMs > 0 && timeMs < (mediaRef.current.duration * 1000)) {
                    (mediaRef.current as HTMLMediaElement).currentTime = timeMs / 1000;
                    setCurrentTime(timeMs);
                }
            }
        }
    };

    const handleVisualVideoLoadedMetadata = () => {
        if (visualVideoRef.current) {
            const vidDur = visualVideoRef.current.duration * 1000;
            if (!effectiveAudioFile || duration === 0) {
                setDuration(vidDur);
            }
        }
    };

    const handleVisualMediaSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setLocalVisualMediaFile(file);
        if (onVisualMediaChange) {
            onVisualMediaChange(file);
        }

        const isVideo = file.type?.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(file.name);
        setSnapNotification(`Loaded ${isVideo ? 'video' : 'image'} preview "${file.name}" for visual sync. Audio track preserved.`);
        e.target.value = '';
    };

    const handleClearVisualMedia = () => {
        setLocalVisualMediaFile(null);
        if (onVisualMediaChange) {
            onVisualMediaChange(null);
        }
        setSnapNotification("Visual view cleared. Showing audio track view.");
    };

    const saveCurrentFrame = async () => {
        if (effectiveYoutubeUrl) {
            setSnapNotification("Frame capture is only available for local video files (YouTube iframe embeds restrict canvas pixel access)");
            return;
        }
        const video = visualVideoRef.current || (mediaRef.current instanceof HTMLVideoElement ? mediaRef.current : null);
        if (!video) {
            if (visualMediaFile && (visualMediaFile.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name))) {
                setSnapNotification("Static image reference is currently displayed.");
            } else {
                setSnapNotification("Upload a video or select a video view to capture frames.");
            }
            return;
        }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 360;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', 0.95));
            if (blob) {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                const timeStr = video.currentTime.toFixed(2).replace('.', '_');
                a.download = `frame_${timeStr}s.jpg`;
                a.click();
                URL.revokeObjectURL(url);
            }
        } catch (err) {
            console.warn('Failed to capture frame:', err);
        }
    };

    const togglePlay = () => {
        if (effectiveYoutubeUrl) {
            if (isPlaying) {
                sendCommandToYouTube('pauseVideo');
                setIsPlaying(false);
            } else {
                sendCommandToYouTube('playVideo');
                setIsPlaying(true);
            }
            return;
        }

        // If at the end of media, restart from beginning
        if ((duration > 0 && currentTime >= duration - 100) || (mediaRef.current && (mediaRef.current.ended || (mediaRef.current.duration && mediaRef.current.duration > 0 && mediaRef.current.currentTime >= mediaRef.current.duration - 0.2)))) {
            seekTo(0);
        }

        if (isPlaying) {
            if (mediaRef.current) {
                try { (mediaRef.current as HTMLMediaElement).pause(); } catch (_) {}
            }
            if (visualVideoRef.current && visualVideoRef.current !== mediaRef.current) {
                try { visualVideoRef.current.pause(); } catch (_) {}
            }
            setIsPlaying(false);
        } else {
            if (mediaRef.current) {
                const el = mediaRef.current as HTMLMediaElement;
                if (el.ended || (el.duration && el.duration > 0 && el.currentTime >= el.duration - 0.2)) {
                    el.currentTime = 0;
                    setCurrentTime(0);
                }
                const playPromise = el.play();
                if (playPromise !== undefined) {
                    playPromise.then(() => {
                        setIsPlaying(true);
                    }).catch(error => {
                        console.warn('[Timeline] Playback notice, retrying muted fallback:', error);
                        // If browser blocks unmuted video playback in iframe/webview, mute and retry
                        if (el instanceof HTMLVideoElement) {
                            el.muted = true;
                            setPrimaryMediaMuted(true);
                            el.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false));
                        } else {
                            setIsPlaying(false);
                        }
                    });
                } else {
                    setIsPlaying(true);
                }
            } else {
                setIsPlaying(true);
            }
            if (visualVideoRef.current && visualVideoRef.current !== mediaRef.current) {
                visualVideoRef.current.play().catch(() => {});
            }
        }
    };

    const handlePointerMove = useCallback((e: PointerEvent) => {
        const { type, id, startX, initStart, initEnd, initialBlocks, pointerId } = dragState.current;
        if (!type || e.pointerId !== pointerId) return;
        
        pointerClientXRef.current = e.clientX;
        pointerEventRef.current = e;
        
        // Crucial for mobile: prevent native scrolling gesture interference
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
        
        // Track the exact timestamp to seek the video preview in real time while adjusting subtitle blocks
        let targetSeekTime: number | null = null;
        
        setBlocksState(prev => {
            // Ripple Sync Drag (Moves this block and all following blocks)
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

        // Seek video preview live to the exact millisecond of the subtitle box being adjusted
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
            
            // Calculate marker X if available
            let markerX = px; 
            if (dragState.current.targetSeekTime !== undefined) {
                const cw = rect.width;
                markerX = (cw / 2) + ((dragState.current.targetSeekTime - dragState.current.dragTimelineStart) / 1000) * activeZoomRef.current;
                markerX += rect.left; // Adjust to absolute screen coordinates
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
        
        // Handle clicks vs drags for subtitle boxes
        if (type) {
            const absDeltaX = Math.abs(e.clientX - startX);
            if (absDeltaX < 4 && id && (type === 'move' || type === 'sync_move' || type === 'select_only')) {
                // Clicked without dragging: select only, DO NOT jump playhead
                const block = initialBlocks.find(b => b.id === id);
                if (block) {
                    console.log(`[Timeline] Clicked block ${block.id}. (Playhead jump disabled)`);
                }
            } else if (absDeltaX >= 4) {
                // Drag ended: seek video precisely to final adjusted position unthrottled
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
                    // Crucial: keep timeline track camera stable at dragTimelineStart!
                    // This prevents the entire timeline view from violently snapping/jumping under user's cursor.
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
            // Allow selection, but prevent moving/trimming locked blocks
            type = 'select_only';
        }
        
        e.stopPropagation();
        const target = e.currentTarget;
        if (target.setPointerCapture) {
            try { target.setPointerCapture(e.pointerId); } catch (err) {}
        }
        
        if (effectiveYoutubeUrl) {
            setIsPlaying(false);
        } else {
            if (mediaRef.current && !(mediaRef.current as HTMLMediaElement).paused) {
                (mediaRef.current as HTMLMediaElement).pause();
            }
            if (visualVideoRef.current && !visualVideoRef.current.paused) {
                try { visualVideoRef.current.pause(); } catch (_) {}
            }
            setIsPlaying(false);
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
            // Mobile NLE style scrubbing: do NOT jump the playhead to the finger position.
            // Just record the current time so the user can drag to pan the timeline smoothly.
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

    // Draw viewport-aligned audio waveform onto canvas behind the subtitle track
    useEffect(() => {
        const canvas = waveformCanvasRef.current;
        if (!canvas || !audioProfile || !showWaveform || containerWidth <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        const width = containerWidth;
        const isMobile = window.innerWidth < 640;
        const height = isMobile ? 56 : 64; // height of track (56px mobile, 64px desktop)

        if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
            canvas.width = Math.floor(width * dpr);
            canvas.height = Math.floor(height * dpr);
        }

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const { duration: audioDur, frameDurationMs, framesCount, rmsEnvelope, peakEnvelope, defaultThreshold } = audioProfile;
        const midY = height / 2;
        const centerSec = effectiveTimeForTrack / 1000;

        // Subtle baseline
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        const stepPx = Math.max(2, Math.min(4, Math.floor(activeZoom / 80) || 2));

        for (let x = 0; x < width; x += stepPx) {
            const timeSec = centerSec + (x - width / 2) / activeZoom;
            if (timeSec < 0 || timeSec > audioDur) continue;

            const frameIdx = Math.floor((timeSec * 1000) / frameDurationMs);
            if (frameIdx < 0 || frameIdx >= framesCount) continue;

            const peak = peakEnvelope[frameIdx] || 0;
            const rms = rmsEnvelope[frameIdx] || 0;
            const isSpeech = rms >= defaultThreshold * 0.85;

            const barHalfHeight = Math.max(1.5, Math.min(midY - 4, peak * (midY - 4)));

            if (isSpeech) {
                // Indigo for active speech peaks
                ctx.fillStyle = 'rgba(129, 140, 248, 0.45)';
            } else {
                // Subtle zinc for quiet pauses / background
                ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
            }

            ctx.fillRect(x, midY - barHalfHeight, stepPx - 1, barHalfHeight * 2);
        }

        ctx.restore();
    }, [audioProfile, showWaveform, containerWidth, activeZoom, effectiveTimeForTrack]);

    const handleSnapSelectedToAudio = async () => {
        if (!selectedBlock) return;
        if (selectedBlock.isLocked) {
            setSnapNotification("This subtitle block is locked. Unlock it to adjust timing.");
            return;
        }
        if (!effectiveAudioFile) {
            setSnapNotification("Upload an audio or video file to use Snap to Audio.");
            setShowSnapSettings(true);
            return;
        }

        let profile = audioProfile;
        if (!profile) {
            setIsAnalyzingAudio(true);
            try {
                profile = await analyzeAudioFile(effectiveAudioFile);
                setAudioProfile(profile);
            } catch (err: any) {
                setIsAnalyzingAudio(false);
                setSnapNotification(`Could not analyze audio: ${err.message || 'Unknown error'}`);
                return;
            }
            setIsAnalyzingAudio(false);
        }

        if (!profile) return;

        const sortedBlocks = [...blocksState].sort((a, b) => a.start - b.start);
        const blockIndex = sortedBlocks.findIndex(b => b.id === selectedBlock.id);
        const prevBlock = blockIndex > 0 ? sortedBlocks[blockIndex - 1] : null;
        const nextBlock = blockIndex < sortedBlocks.length - 1 ? sortedBlocks[blockIndex + 1] : null;

        const result = snapBlockToAudio(selectedBlock, profile, prevBlock, nextBlock, {
            leadInMs: snapLeadIn,
            tailPaddingMs: snapTailPadding,
            sensitivity: snapSensitivity,
        });

        if (result.startShiftMs === 0 && result.endShiftMs === 0) {
            setSnapNotification(result.message);
        } else {
            setBlocksAndNotify(prev => prev.map(b => b.id === selectedBlock.id ? {
                ...b,
                start: result.newStart,
                end: result.newEnd,
            } : b).sort((a, b) => a.start - b.start));

            setSnappedBlockId(selectedBlock.id);
            setSnapNotification(result.message);
            setTimeout(() => setSnappedBlockId(null), 1800);
        }
    };

    const handleSnapAllToAudio = async () => {
        if (blocksState.length === 0) {
            setSnapNotification("No subtitle blocks to snap.");
            return;
        }
        if (!effectiveAudioFile) {
            setSnapNotification("Upload an audio or video file to use Snap to Audio.");
            setShowSnapSettings(true);
            return;
        }

        let profile = audioProfile;
        if (!profile) {
            setIsAnalyzingAudio(true);
            try {
                profile = await analyzeAudioFile(effectiveAudioFile);
                setAudioProfile(profile);
            } catch (err: any) {
                setIsAnalyzingAudio(false);
                setSnapNotification(`Could not analyze audio: ${err.message || 'Unknown error'}`);
                return;
            }
            setIsAnalyzingAudio(false);
        }

        if (!profile) return;

        const { updatedBlocks, changedCount } = snapAllBlocksToAudio(blocksState, profile, {
            leadInMs: snapLeadIn,
            tailPaddingMs: snapTailPadding,
            sensitivity: snapSensitivity,
        });

        if (changedCount > 0) {
            setBlocksAndNotify(updatedBlocks);
            setSnapNotification(`Snapped ${changedCount} subtitle block${changedCount > 1 ? 's' : ''} to audio speech boundaries.`);
        } else {
            setSnapNotification("All subtitle blocks are already aligned with speech boundaries.");
        }
    };

    // --- Gemini AI Semantic Alignment (Alt C) Handlers ---

    const handleAiAlignSelected = async () => {
        if (!selectedBlock) {
            setSnapNotification("Please select a subtitle block on the timeline first.");
            return;
        }
        if (!effectiveAudioFile) {
            setSnapNotification("Upload an audio or video file to use AI Semantic Alignment.");
            setShowSnapSettings(true);
            return;
        }
        if (selectedBlock.isLocked) {
            setSnapNotification("This block is locked. Unlock it first to align.");
            return;
        }

        setIsAiAligning(true);
        setAiAlignMode('single');
        setSnapNotification("Gemini AI is analyzing vocals for this line...");

        try {
            const sortedBlocks = [...blocksState].sort((a, b) => a.start - b.start);
            const idx = sortedBlocks.findIndex(b => b.id === selectedBlock.id);
            const prevBlock = idx > 0 ? sortedBlocks[idx - 1] : null;
            const nextBlock = idx < sortedBlocks.length - 1 ? sortedBlocks[idx + 1] : null;

            const result = await alignSingleBlockWithGemini(
                effectiveAudioFile,
                selectedBlock,
                {
                    prevText: prevBlock?.text,
                    nextText: nextBlock?.text
                },
                apiKey
            );

            setBlocksAndNotify(prev => prev.map(b => b.id === selectedBlock.id ? {
                ...b,
                start: result.newStart,
                end: result.newEnd,
            } : b).sort((a, b) => a.start - b.start));

            setSnappedBlockId(selectedBlock.id);
            setSnapNotification(result.message);
            setTimeout(() => setSnappedBlockId(null), 3000);
        } catch (err: any) {
            console.error("AI Alignment failed", err);
            setSnapNotification(`AI Alignment error: ${err.message || 'Failed to align'}`);
        } finally {
            setIsAiAligning(false);
            setAiAlignMode(null);
        }
    };

    const handleAiAlignAll = async () => {
        if (blocksState.length === 0) {
            setSnapNotification("No subtitle blocks to align.");
            return;
        }
        if (!effectiveAudioFile) {
            setSnapNotification("Upload an audio or video file to use AI Semantic Alignment.");
            setShowSnapSettings(true);
            return;
        }

        setIsAiAligning(true);
        setAiAlignMode('all');
        setAiAlignProgress(10);
        setAiAlignStatusText("Initializing Gemini vocal recognition engine...");
        setSnapNotification("Starting Gemini AI Vocal Alignment for all subtitles...");

        try {
            const result = await alignAllSubtitlesWithGemini(
                effectiveAudioFile,
                blocksState,
                apiKey,
                (p, text) => {
                    setAiAlignProgress(p);
                    if (text) {
                        setAiAlignStatusText(text);
                        setSnapNotification(text);
                    }
                }
            );

            if (result.alignedCount > 0) {
                setBlocksAndNotify(result.updatedBlocks);
                setSnapNotification(result.message);
            } else {
                setSnapNotification("AI completed analysis. Timings were already optimal.");
            }
        } catch (err: any) {
            console.error("AI Batch Alignment failed", err);
            setSnapNotification(`AI Batch Alignment failed: ${err.message || 'Error communicating with Gemini'}`);
        } finally {
            setIsAiAligning(false);
            setAiAlignMode(null);
            setAiAlignProgress(0);
            setAiAlignStatusText('');
        }
    };

    // Mark In / Mark Out fast playhead trimming
    const handleSetMarkIn = (blockId: string) => {
        const targetStart = Math.round(currentTime);
        setBlocksAndNotify(prev => prev.map(b => {
            if (b.id === blockId) {
                const newEnd = b.end <= targetStart ? targetStart + 1500 : b.end;
                return { ...b, start: Math.max(0, targetStart), end: newEnd };
            }
            // Auto-cut: If the mark falls inside another block, trim its end
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
            // Auto-cut: If the mark falls inside another block, trim its start
            if (b.start < targetEnd && b.end > targetEnd) {
                return { ...b, start: targetEnd };
            }
            return b;
        }).sort((a, b) => a.start - b.start));
        seekTo(targetEnd, false);
        setSnapNotification(`Set Mark Out: ${formatTimeWithMs(targetEnd)}`);
    };

    // Sub Left (Previous Subtitle) & Sub Right (Next Subtitle) Navigation
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
        } else if (idx === 0) {
            setSnapNotification(`First subtitle (1/${sorted.length})`);
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
        } else if (idx === sorted.length - 1) {
            setSnapNotification(`Last subtitle (${sorted.length}/${sorted.length})`);
        }
    }, [blocksState, selectedId]);

    // Keyboard shortcuts for [subleft][in][out][subright]
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }

            if (e.code === 'Space' || e.key === ' ') {
                e.preventDefault();
                togglePlay();
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
    }, [selectedId, currentTime, handleSelectPrevSubtitle, handleSelectNextSubtitle, handleNudge, togglePlay]);

    const handleMediaFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setLocalAudioFile(file);
        if (onMediaSwap) onMediaSwap(file);
    };

    const updateSelectedText = (text: string) => {
        if (selectedId) {
            setBlocksAndNotify(prev => prev.map(b => b.id === selectedId ? { ...b, text } : b));
        }
    };

    const handleSyncTranslation = async (direction?: 'line1' | 'line2') => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !selectedBlock.text || !effectiveKey) {
            if (!effectiveKey) setSnapNotification("Gemini API Key required for translation sync. Check Settings -> API Vault");
            return;
        }
        
        setIsSyncingTranslation(direction || 'all');
        try {
            const updatedText = await syncSubtitleTranslations(selectedBlock.text, effectiveKey, direction);
            if (updatedText) {
                updateSelectedText(updatedText);
                setSnapNotification(direction ? `Translation synced from ${direction === 'line1' ? 'Line 1' : 'Line 2'}` : "Translation synced & formatted");
            }
        } catch (e: any) {
            console.error("Translation sync failed:", e);
            setSnapNotification(`Translation sync failed: ${e?.message || 'Error'}`);
        } finally {
            setIsSyncingTranslation(false);
        }
    };

    const handleQuickTranslate = async (sourceLine: 'l1' | 'l2') => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !effectiveKey) {
            setSnapNotification("Gemini API Key required for quick translation");
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
                    setSnapNotification(`Translation synced to Line 2 ⚡ (${targetLang})`);
                }
            } else {
                if (!l2.trim()) return;
                const sourceLang = localStorage.getItem('ai_sub_src_lang') || 'Auto-detect';
                const nativeLang = (sourceLang !== 'Auto-detect' && sourceLang) ? sourceLang : 'native';
                const translated = await translateSingleLine(l2, nativeLang, effectiveKey);
                if (translated) {
                    updateSelectedText(`${translated}\n${l2.trim()}`);
                    setSnapNotification(`Native text synced to Line 1 ⚡`);
                }
            }
        } catch (err: any) {
            console.error("Quick translate failed:", err);
            setSnapNotification(`Quick translate error: ${err?.message || 'Failed'}`);
        } finally {
            setQuickTranslatingLine(null);
        }
    };

    const captureVideoFrame = (): string | null => {
        const video = visualVideoRef.current || (mediaRef.current instanceof HTMLVideoElement ? mediaRef.current : null);
        if (!video) return null;
        
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth || 640;
            canvas.height = video.videoHeight || 360;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
            return dataUrl.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
        } catch (e) {
            console.error("Frame capture failed:", e);
            return null;
        }
    };

    const handleVisionFix = async (mode: 'video' | 'frame' = 'frame') => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !effectiveKey) {
            if (!effectiveKey) setSnapNotification("Gemini API Key required for vision fix. Check Settings -> API Vault");
            return;
        }

        setIsVisionFixing(true);
        try {
            let updatedText = '';

            if (mode === 'frame') {
                let base64 = captureVideoFrame();
                if (!base64) {
                    setSnapNotification("Requesting screen frame for Vision analysis...");
                    try {
                        const screenCapture = await captureScreenFrame();
                        base64 = typeof screenCapture === 'string' ? screenCapture : (screenCapture as any)?.base64;
                    } catch (screenErr) {
                        console.warn("Direct screen capture cancelled or unavailable:", screenErr);
                        setShowFrameTranslate(true);
                        setIsVisionFixing(false);
                        return;
                    }
                }

                if (!base64) {
                    setSnapNotification("Could not capture frame. Opening Vision...");
                    setShowFrameTranslate(true);
                    setIsVisionFixing(false);
                    return;
                }

                setSnapNotification("Analyzing frame with Gemini Vision...");
                updatedText = await fixSubtitleWithFrame(selectedBlock.text, base64, effectiveKey);
            } else {
                let fileUriToUse = '';
                
                if (effectiveAudioFile && isVideoFile(effectiveAudioFile)) {
                    if (uploadedFileUri) {
                        fileUriToUse = uploadedFileUri;
                    } else {
                        setSnapNotification("Uploading video to Gemini (once per session)...");
                        setIsUploadingVideo(true);
                        fileUriToUse = await uploadVideoToGemini(effectiveAudioFile, effectiveKey);
                        setUploadedFileUri(fileUriToUse);
                        setIsUploadingVideo(false);
                    }
                } else if (effectiveYoutubeUrl) {
                    if (uploadedFileUri) {
                        fileUriToUse = uploadedFileUri;
                    } else {
                        setSnapNotification("Acquiring YouTube video stream for Gemini analysis...");
                        setIsUploadingVideo(true);
                        try {
                            const downloadedVid = await downloadYouTubeMediaStream(effectiveYoutubeUrl, '360');
                            fileUriToUse = await uploadVideoToGemini(downloadedVid, effectiveKey);
                            setUploadedFileUri(fileUriToUse);
                        } catch (streamErr: any) {
                            console.warn("YouTube video stream download error:", streamErr);
                            setSnapNotification("YouTube stream unavailable. Opening Vision...");
                            setShowFrameTranslate(true);
                            setIsVisionFixing(false);
                            setIsUploadingVideo(false);
                            return;
                        } finally {
                            setIsUploadingVideo(false);
                        }
                    }
                } else {
                    setSnapNotification("Video required for vision fix");
                    setIsVisionFixing(false);
                    return;
                }
                
                setSnapNotification("Agentic Video analyzing... (scrubbing timestamp)");
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
                setSnapNotification(`Text adjusted by Agentic ${mode === 'frame' ? 'Vision (Frame)' : 'Video'}`);
            } else {
                setSnapNotification("No adjustments deemed necessary");
            }
        } catch (e: any) {
            console.error("Vision fix failed:", e);
            setSnapNotification(`Agentic Vision failed: ${e.message}`);
        } finally {
            setIsVisionFixing(false);
            setIsUploadingVideo(false);
        }
    };

    const handleHearFix = async () => {
        const effectiveKey = getEffectiveGeminiApiKey(apiKey);
        if (!selectedBlock || !effectiveKey) {
            if (!effectiveKey) setSnapNotification("Gemini API Key required for audio fix. Check Settings -> API Vault");
            return;
        }
        
        setIsAudioFixing(true);
        try {
            let fileUriToUse = '';
            
            if (effectiveAudioFile) {
                if (uploadedFileUri) {
                    fileUriToUse = uploadedFileUri;
                } else {
                    setSnapNotification("Uploading media to Gemini (once per session)...");
                    setIsUploadingVideo(true);
                    fileUriToUse = await uploadVideoToGemini(effectiveAudioFile, effectiveKey);
                    setUploadedFileUri(fileUriToUse);
                    setIsUploadingVideo(false);
                }
            } else if (effectiveYoutubeUrl) {
                if (uploadedFileUri) {
                    fileUriToUse = uploadedFileUri;
                } else {
                    setSnapNotification("Acquiring YouTube audio stream for Agentic Audio...");
                    setIsUploadingVideo(true);
                    try {
                        const downloadedAud = await downloadYouTubeMediaStream(effectiveYoutubeUrl, 'audio');
                        fileUriToUse = await uploadVideoToGemini(downloadedAud, effectiveKey);
                        setUploadedFileUri(fileUriToUse);
                    } catch (streamErr: any) {
                        console.warn("YouTube audio stream download error:", streamErr);
                        setSnapNotification("YouTube audio stream unavailable for Agentic Audio");
                        setIsAudioFixing(false);
                        setIsUploadingVideo(false);
                        return;
                    } finally {
                        setIsUploadingVideo(false);
                    }
                }
            } else {
                setSnapNotification("Media required for audio fix");
                setIsAudioFixing(false);
                return;
            }
            
            setSnapNotification("Agentic Audio analyzing... (listening closely)");
            const updatedText = await fixSubtitleWithAudio(
                selectedBlock.text, 
                fileUriToUse,
                selectedBlock.start / 1000,
                selectedBlock.end / 1000,
                effectiveKey
            );
            
            if (updatedText && updatedText !== selectedBlock.text) {
                updateSelectedText(updatedText);
                setSnapNotification("Text adjusted by Agentic Audio");
            } else {
                setSnapNotification("No adjustments deemed necessary");
            }
        } catch (e: any) {
            console.error("Audio fix failed:", e);
            setSnapNotification(`Agentic Audio failed: ${e.message}`);
        } finally {
            setIsAudioFixing(false);
            setIsUploadingVideo(false);
        }
    };

    const splitBlock = () => {
        if (!selectedBlock) return;
        const totalDur = selectedBlock.end - selectedBlock.start;
        const midTime = (currentTime > selectedBlock.start + 150 && currentTime < selectedBlock.end - 150) 
            ? currentTime 
            : selectedBlock.start + totalDur / 2;
        const ratio = Math.max(0.1, Math.min(0.9, (midTime - selectedBlock.start) / totalDur));
        const { part1, part2 } = smartSplitCueText(selectedBlock.text, ratio);

        const newBlock: SubtitleBlock = {
            id: Math.random().toString(36).substring(7),
            start: midTime,
            end: selectedBlock.end,
            text: part2 || 'Part 2'
        };
        setBlocksAndNotify(prev => prev.map(b => b.id === selectedId ? { ...b, end: midTime, text: part1 || b.text } : b).concat(newBlock).sort((a,b) => a.start - b.start));
        setSnapNotification("Subtitle split into 2 parts");
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
        setSnapNotification(`Split into ${subBlocks.length} sentence blocks ✂️`);
    };

    const duplicateBlock = () => {
        if (!selectedBlock) return;
        const duration = selectedBlock.end - selectedBlock.start;
        const newBlock: SubtitleBlock = {
            id: Math.random().toString(36).substring(7),
            start: selectedBlock.end + 100,
            end: selectedBlock.end + 100 + duration,
            text: selectedBlock.text
        };
        setBlocksAndNotify(prev => prev.concat(newBlock).sort((a,b) => a.start - b.start));
    };

    const toggleLockBlock = () => {
        if (selectedId) {
            setBlocksAndNotify(prev => prev.map(b => b.id === selectedId ? { ...b, isLocked: !b.isLocked } : b));
        }
    };

    const deleteBlock = () => {
        if (selectedId) {
            setBlocksAndNotify(prev => prev.filter(b => b.id !== selectedId));
            setSelectedId(null);
        }
    };

    const addBlock = () => {
        const time = currentTime;
        const newBlock: SubtitleBlock = {
            id: Math.random().toString(36).substring(7),
            start: time,
            end: time + 3000,
            text: 'New Caption'
        };
        setBlocksAndNotify(prev => prev.concat(newBlock).sort((a,b) => a.start - b.start));
    };

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
        
        // Reset input so the same file can be selected again
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
        if (captionStyle === 'standard') {
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
        }
        
        const words = block.text.split(/(\s+)/);
        const actualWordsCount = words.filter(w => w.trim().length > 0).length || 1;
        const durationMs = block.end - block.start;
        const timePerWord = durationMs / actualWordsCount;
        
        let wordIndex = 0;
        
        return (
            <p 
                key={block.id} 
                className="flex flex-wrap justify-center font-black mx-auto leading-snug"
                style={{ fontSize: `${previewSize}px` }}
            >
                {words.map((chunk, i) => {
                    if (chunk.trim().length === 0) {
                        return <span key={i}>{chunk}</span>;
                    }
                    
                    const currentWordIndex = wordIndex++;
                    const wordStart = block.start + (currentWordIndex * timePerWord);
                    const wordEnd = wordStart + timePerWord;
                    const isPast = currentTime > wordStart;
                    const isActive = currentTime >= wordStart && currentTime <= wordEnd;
                    
                    if (captionStyle === 'pop') {
                         return (
                             <span key={i} className="inline-block mx-1" style={{
                                 textShadow: '3px 3px 0 #000, -3px -3px 0 #000, 3px -3px 0 #000, -3px 3px 0 #000, 0 3px 0 #000, 3px 0 0 #000, 0 -3px 0 #000, -3px 0 0 #000',
                                 color: 'white',
                                 opacity: isPast ? 1 : 0,
                                 transform: isPast ? 'scale(1)' : 'scale(0.5)',
                                 animation: isPast && isActive ? 'popIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards' : 'none'
                             }}>
                                 {chunk}
                             </span>
                         );
                    } else if (captionStyle === 'karaoke') {
                        return (
                             <span key={i} className="inline-block mx-1 transition-colors duration-150" style={{
                                 textShadow: '2px 2px 0 #000, -2px -2px 0 #000, 2px -2px 0 #000, -2px 2px 0 #000, 0 2px 0 #000, 2px 0 0 #000, 0 -2px 0 #000, -2px 0 0 #000',
                                 color: isPast ? (isActive ? '#fbbf24' : '#ffffff') : '#888888',
                                 transform: isActive ? 'scale(1.1) translateY(-2px)' : 'scale(1) translateY(0)',
                                 transition: 'all 0.15s ease-out'
                             }}>
                                 {chunk}
                             </span>
                         );
                    } else if (captionStyle === 'neon') {
                        return (
                             <span key={i} className="inline-block mx-1" style={{
                                 color: isActive ? '#fff' : '#fbcfe8',
                                 textShadow: isActive 
                                    ? '0 0 5px #ec4899, 0 0 10px #ec4899, 0 0 20px #ec4899'
                                    : '0 0 2px #ec4899',
                                 transform: isActive ? 'scale(1.15)' : 'scale(1)',
                                 transition: 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
                             }}>
                                 {chunk}
                             </span>
                         );
                    }
                    return <span key={i}>{chunk}</span>;
                })}
            </p>
        );
    };

    return (
        <div className="flex flex-col h-full bg-[#0a0a0a] text-white rounded-xl overflow-hidden relative">
            <style>{`
                @keyframes popIn {
                    0% { transform: scale(0.5); opacity: 0; }
                    50% { transform: scale(1.2); opacity: 1; }
                    100% { transform: scale(1); opacity: 1; }
                }
            `}</style>
            {/* Editor Top Section (Media) */}
            <div 
                ref={playerContainerRef} 
                onDoubleClick={toggleFullscreen} 
                className={`bg-black relative flex flex-col items-center justify-center overflow-hidden group transition-all duration-200 ${
                    videoHeightMode === 'large' 
                        ? 'h-[40vh] min-h-[180px] shrink-0' 
                        : 'flex-1 min-h-0'
                }`}
            >
                {effectiveYoutubeUrl && youtubeVideoId ? (
                    <div className="w-full h-full flex items-center justify-center relative bg-black">
                        <iframe
                            ref={youtubeIframeRef}
                            id="youtube-default-player"
                            key={youtubeVideoId}
                            src={`https://www.youtube-nocookie.com/embed/${youtubeVideoId}?enablejsapi=1&autoplay=0&rel=0&playsinline=1`}
                            title="YouTube Default Player"
                            className="w-full h-full border-0 bg-black"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
                            allowFullScreen
                        />
                    </div>
                ) : !isPrimaryVideo && visualMediaFile && visualMediaUrl ? (
                    <div className="w-full h-full relative flex items-center justify-center bg-black overflow-hidden">
                        {visualMediaFile.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name) ? (
                            <img 
                                src={visualMediaUrl} 
                                alt={visualMediaFile.name} 
                                className="w-full h-full object-contain select-none"
                            />
                        ) : (
                            <video 
                                ref={visualVideoRef} 
                                src={visualMediaUrl} 
                                className="w-full h-full object-contain cursor-pointer"
                                loop
                                playsInline
                                preload="auto"
                                muted={visualVideoMuted}
                                onLoadedMetadata={handleVisualVideoLoadedMetadata}
                                onClick={togglePlay}
                                onPause={() => {
                                    if (!effectiveAudioFile) setIsPlaying(false);
                                }}
                                onPlay={() => {
                                    if (!effectiveAudioFile) setIsPlaying(true);
                                }}
                                onEnded={() => {
                                    if (effectiveAudioFile) {
                                        if (visualVideoRef.current) {
                                            visualVideoRef.current.currentTime = 0;
                                            visualVideoRef.current.play().catch(() => {});
                                        }
                                    } else {
                                        setIsPlaying(false);
                                    }
                                }}
                            />
                        )}
                        
                        {/* Audio track element from AI generator tab runs to play soundtrack */}
                        {effectiveAudioFile && effectiveAudioFile.name !== visualMediaFile.name && (
                            <audio 
                                ref={mediaRef as React.RefObject<HTMLAudioElement>} 
                                src={mediaUrl || undefined} 
                                onLoadedMetadata={handleMediaLoadedMetadata}
                                onPause={() => setIsPlaying(false)}
                                onPlay={() => setIsPlaying(true)}
                                onEnded={() => setIsPlaying(false)}
                            />
                        )}

                        {/* Visual overlay indicator pill with sound adjustment */}
                        <div className="absolute top-2 left-2 z-20 flex items-center gap-1.5 px-2.5 py-1 bg-black/80 backdrop-blur-md border border-white/20 rounded-lg text-[11px] text-white/90 shadow-xl pointer-events-auto flex-wrap max-w-[95%]">
                            {visualMediaFile.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name) ? (
                                <ImageIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                            ) : (
                                <Film className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                            )}
                            <span className="font-semibold max-w-[110px] sm:max-w-[160px] truncate">{visualMediaFile.name}</span>
                            
                            {/* Video Sound Adjustment (Muted or Adjusted Volume) */}
                            {!(visualMediaFile.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name)) && (
                                <div className="flex items-center gap-1.5 pl-1.5 border-l border-white/20">
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            const nextMuted = !visualVideoMuted;
                                            setVisualVideoMuted(nextMuted);
                                            if (!nextMuted && visualVideoVolume === 0) {
                                                setVisualVideoVolume(0.5);
                                            }
                                        }}
                                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                                            visualVideoMuted 
                                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30' 
                                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30'
                                        }`}
                                        title={visualVideoMuted ? "Companion Video Sound is Muted (Click to enable video sound)" : "Companion Video Sound is On (Click to mute)"}
                                    >
                                        {visualVideoMuted ? <VolumeX className="w-3 h-3 text-amber-300" /> : <Volume2 className="w-3 h-3 text-emerald-300" />}
                                        <span>{visualVideoMuted ? 'Muted' : `${Math.round(visualVideoVolume * 100)}%`}</span>
                                    </button>
                                    
                                    {!visualVideoMuted && (
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.05"
                                            value={visualVideoVolume}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                setVisualVideoVolume(val);
                                                if (val === 0) setVisualVideoMuted(true);
                                            }}
                                            className="w-14 sm:w-20 h-1.5 accent-emerald-400 bg-white/20 rounded-lg cursor-pointer"
                                            title={`Adjust Video Sound Volume: ${Math.round(visualVideoVolume * 100)}%`}
                                        />
                                    )}
                                    <span className="text-[9px] text-white/40 hidden md:inline" title="Audio from AI Generator remains the primary track">(AI Audio Primary)</span>
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    handleClearVisualMedia();
                                }}
                                className="ml-1 p-0.5 hover:bg-white/20 rounded text-white/60 hover:text-white transition-colors cursor-pointer"
                                title="Remove visual view"
                            >
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    </div>
                ) : effectiveAudioFile ? (
                    isPrimaryVideo ? (
                        <div className="w-full h-full relative flex items-center justify-center bg-black overflow-hidden">
                            <video 
                                ref={mediaRef as React.RefObject<HTMLVideoElement>} 
                                src={mediaUrl || undefined} 
                                className="w-full h-full object-contain cursor-pointer"
                                playsInline
                                preload="auto"
                                muted={primaryMediaMuted}
                                onLoadedMetadata={handleMediaLoadedMetadata}
                                onCanPlay={() => {
                                    if (mediaRef.current) {
                                        const durMs = mediaRef.current.duration * 1000;
                                        if (!isNaN(durMs) && durMs > 0 && duration === 0) {
                                            setDuration(durMs);
                                        }
                                    }
                                }}
                                onClick={togglePlay}
                                onPause={() => setIsPlaying(false)}
                                onPlay={() => setIsPlaying(true)}
                                onEnded={() => setIsPlaying(false)}
                            />
                            {/* Video overlay indicator pill with sound adjustment */}
                            <div className="absolute top-2 left-2 z-20 flex items-center gap-1.5 px-2.5 py-1 bg-black/80 backdrop-blur-md border border-white/20 rounded-lg text-[11px] text-white/90 shadow-xl pointer-events-auto flex-wrap max-w-[95%]">
                                <Film className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                                <span className="font-semibold max-w-[140px] sm:max-w-[200px] truncate">{effectiveAudioFile.name}</span>
                                <span className="text-[10px] bg-purple-500/25 text-purple-300 px-1.5 py-0.5 rounded font-bold">Video + Audio</span>
                                <div className="flex items-center gap-1.5 pl-1.5 border-l border-white/20">
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            const nextMuted = !primaryMediaMuted;
                                            if (mediaRef.current instanceof HTMLMediaElement) {
                                                mediaRef.current.muted = nextMuted;
                                            }
                                            setPrimaryMediaMuted(nextMuted);
                                        }}
                                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-all cursor-pointer ${
                                            primaryMediaMuted 
                                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30' 
                                                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30'
                                        }`}
                                        title={primaryMediaMuted ? "Video Sound is Muted (Click to enable sound)" : "Video Sound is On (Click to mute)"}
                                    >
                                        {primaryMediaMuted ? <VolumeX className="w-3 h-3 text-amber-300" /> : <Volume2 className="w-3 h-3 text-emerald-300" />}
                                        <span>{primaryMediaMuted ? 'Muted' : 'Sound On'}</span>
                                    </button>
                                    {!primaryMediaMuted && (
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.05"
                                            value={primaryMediaVolume}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                setPrimaryMediaVolume(val);
                                                if (val === 0) setPrimaryMediaMuted(true);
                                            }}
                                            className="w-14 sm:w-20 h-1.5 accent-emerald-400 bg-white/20 rounded-lg cursor-pointer"
                                            title={`Adjust Video Audio Volume: ${Math.round(primaryMediaVolume * 100)}%`}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    ) : (
                        <>
                            <audio 
                                ref={mediaRef as React.RefObject<HTMLAudioElement>} 
                                src={mediaUrl || undefined} 
                                onLoadedMetadata={handleMediaLoadedMetadata}
                                onPause={() => setIsPlaying(false)}
                                onPlay={() => setIsPlaying(true)}
                                onEnded={() => setIsPlaying(false)}
                            />
                            <div className="text-white/40 flex flex-col items-center gap-3 py-6 px-4">
                                <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center border border-white/10 shadow-lg">
                                    <FileAudio className="w-9 h-9 text-indigo-400 animate-pulse" />
                                </div>
                                <div className="text-center">
                                    <p className="font-semibold text-sm text-white/90 max-w-[220px] sm:max-w-xs truncate">{effectiveAudioFile.name}</p>
                                    <p className="text-xs text-white/50 mt-0.5">Audio Track Active (AI Generator)</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => visualMediaInputRef.current?.click()}
                                    className="mt-1 flex items-center gap-2 px-3.5 py-1.5 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 border border-indigo-500/40 rounded-lg text-xs font-semibold cursor-pointer transition-all shadow-md active:scale-95"
                                    title="Upload a video or image to match this audio track"
                                >
                                    <Film className="w-3.5 h-3.5 text-indigo-300" />
                                    <span>Match View: Add Video/Image Preview</span>
                                </button>
                            </div>
                        </>
                    )
                ) : (
                    <div className="text-white/20 text-sm font-medium border-2 border-dashed border-white/10 p-12 rounded-2xl text-center mx-4 flex flex-col items-center gap-3">
                        <span>Upload media or paste YouTube link first to sync playback</span>
                        <button
                            type="button"
                            onClick={() => setShowYoutubeInputModal(true)}
                            className="px-4 py-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 rounded-xl text-xs font-bold transition-colors flex items-center gap-2"
                        >
                            <Youtube className="w-4 h-4 text-red-500" />
                            <span>Load YouTube Video</span>
                        </button>
                    </div>
                )}
                
                {/* Fixed Captions overlay here */}
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
                <div className="w-full px-2 sm:px-6 pt-1.5 pb-0.5 sm:pt-2.5 flex items-center group cursor-pointer relative" title="Video Position">
                    <input 
                        type="range" 
                        min={0} 
                        max={Math.max(duration, blocksDuration, 100)} 
                        value={currentTime} 
                        onChange={(e) => seekTo(Number(e.target.value))}
                        className="w-full h-1.5 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-indigo-500 hover:[&::-webkit-slider-thumb]:w-4 hover:[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:transition-all"
                        style={{
                           background: `linear-gradient(to right, #6366f1 ${(currentTime / Math.max(duration, blocksDuration, 1)) * 100}%, rgba(255,255,255,0.2) ${(currentTime / Math.max(duration, blocksDuration, 1)) * 100}%)`
                        }}
                    />
                </div>
                {/* Zoom Scrubber (Mobile Friendly) */}
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
                {/* CapCut Style Controls */}
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
                    <button onClick={togglePlay} className="w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center bg-white text-black rounded-full hover:scale-105 transition-transform shadow-md" title={isPlaying ? "Pause" : "Play"}>
                        {isPlaying ? <Pause className="w-4 h-4 sm:w-5 sm:h-5 fill-black" /> : <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-black ml-0.5 sm:ml-1" />}
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
                            setSnapNotification(`Playback Speed: ${nextSpeed}x`);
                        }}
                        className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-white/5 hover:bg-white/10 active:bg-white/20 text-white/80 hover:text-white rounded-md text-[10px] sm:text-xs font-mono font-bold transition-all border border-white/10 cursor-pointer"
                        title="Playback Speed (Click to cycle 0.5x, 0.75x, 1x, 1.25x, 1.5x, 2x)"
                    >
                        {playbackRate}x
                    </button>
                </div>
                
                <div className="flex justify-start sm:justify-end items-center gap-1 sm:gap-1.5 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] flex-nowrap shrink-0">
                    {isPrimaryVideo ? (
                        <div 
                            className="shrink-0 px-2.5 h-7 sm:h-8 flex items-center gap-1.5 rounded-md bg-purple-600/25 border border-purple-500/40 text-purple-200 text-xs font-semibold shadow-sm"
                            title={`Primary Video Active: ${effectiveAudioFile?.name || 'Video'} provides both video view and audio track from AI Generator.`}
                        >
                            <Film className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                            <span className="truncate max-w-[120px] sm:max-w-[180px]">{effectiveAudioFile?.name || 'Video Active'}</span>
                            <span className="text-[10px] bg-purple-500/30 text-purple-200 px-1.5 py-0.5 rounded font-bold">Video+Audio</span>
                        </div>
                    ) : (
                        <>
                            <button 
                                type="button"
                                onClick={() => visualMediaInputRef.current?.click()} 
                                className={`shrink-0 px-2 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all border shadow-sm cursor-pointer ${
                                    visualMediaFile 
                                        ? visualMediaFile.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name)
                                            ? 'bg-blue-600/30 hover:bg-blue-600/40 text-blue-200 border-blue-400/40'
                                            : 'bg-emerald-600/30 hover:bg-emerald-600/40 text-emerald-200 border-emerald-400/40'
                                        : 'bg-indigo-600/20 hover:bg-indigo-600/35 text-indigo-200 border-indigo-500/30'
                                }`} 
                                title={visualMediaFile ? `Matched View: ${visualMediaFile.name} (Click to change visual preview)` : "Match View: Select Video or Image to display with your audio track from AI Generator"}
                            >
                                {visualMediaFile?.type?.startsWith('image/') || (visualMediaFile && /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name)) ? (
                                    <ImageIcon className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                                ) : (
                                    <Film className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                )}
                                <span className="text-xs font-semibold">
                                    {visualMediaFile ? (
                                        visualMediaFile.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name)
                                            ? 'Matched Image'
                                            : 'Matched Video'
                                    ) : (
                                        <>
                                            <span className="hidden md:inline">Match View (Video/Image)</span>
                                            <span className="md:hidden">Match View</span>
                                        </>
                                    )}
                                </span>
                                {visualMediaFile && (
                                    <span
                                        role="button"
                                        tabIndex={0}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleClearVisualMedia();
                                        }}
                                        className="p-0.5 hover:bg-white/20 rounded text-white/60 hover:text-white transition-colors cursor-pointer"
                                        title="Clear visual view"
                                    >
                                        <X className="w-3 h-3" />
                                    </span>
                                )}
                            </button>

                            {/* Quick Sound Toggle for Visual Video View */}
                            {visualMediaFile && !(visualMediaFile.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif|bmp)$/i.test(visualMediaFile.name)) && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        const nextMuted = !visualVideoMuted;
                                        setVisualVideoMuted(nextMuted);
                                        if (!nextMuted && visualVideoVolume === 0) {
                                            setVisualVideoVolume(0.5);
                                        }
                                        setSnapNotification(nextMuted ? "Companion video sound muted (AI audio track active)" : `Companion video sound active (${Math.round((visualVideoVolume || 0.5) * 100)}%)`);
                                    }}
                                    className={`shrink-0 px-2 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all border shadow-sm cursor-pointer ${
                                        visualVideoMuted
                                            ? 'bg-amber-600/20 hover:bg-amber-600/35 text-amber-300 border-amber-500/30'
                                            : 'bg-emerald-600/20 hover:bg-emerald-600/35 text-emerald-300 border-emerald-500/30'
                                    }`}
                                    title={visualVideoMuted ? "Companion video audio is muted. Click to enable video audio." : `Companion video audio active (${Math.round(visualVideoVolume * 100)}%). Click to mute.`}
                                >
                                    {visualVideoMuted ? <VolumeX className="w-3.5 h-3.5 text-amber-400 shrink-0" /> : <Volume2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                                    <span className="text-xs font-semibold">{visualVideoMuted ? 'Muted' : `${Math.round(visualVideoVolume * 100)}%`}</span>
                                </button>
                            )}
                        </>
                    )}

                    <button 
                        type="button"
                        onClick={() => setShowYoutubeInputModal(true)} 
                        className="shrink-0 px-2 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all border shadow-sm bg-red-600/20 hover:bg-red-600/40 text-red-300 border-red-500/30" 
                        title={effectiveYoutubeUrl ? "Change YouTube Video URL" : "Load YouTube Video URL"}
                    >
                        <Youtube className="w-3.5 h-3.5 text-red-400 shrink-0" />
                        <span className="text-xs font-semibold hidden md:inline">{effectiveYoutubeUrl ? "YouTube Video" : "YouTube Link"}</span>
                    </button>

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
                    {detectedJumps.length > 0 && (
                        <button 
                            onClick={() => {
                                setSyncScope('from_selected');
                                setSelectedId(detectedJumps[0].toBlock.id);
                                setShowSyncSettings(true);
                            }}
                            className="shrink-0 h-7 sm:h-8 px-2 sm:px-2.5 flex items-center gap-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-md text-xs font-semibold animate-pulse transition-all cursor-pointer"
                            title={`${detectedJumps.length} timing jump(s) detected! Click to inspect and repair.`}
                        >
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            <span className="hidden md:inline">{detectedJumps.length} Jump{detectedJumps.length > 1 ? 's' : ''} ({detectedJumps[0].gapFormatted})</span>
                            <span className="md:hidden">{detectedJumps.length} Jump{detectedJumps.length > 1 ? 's' : ''}</span>
                        </button>
                    )}
                    <button 
                        onClick={() => setShowSnapSettings(true)} 
                        className={`shrink-0 px-2 h-7 sm:h-8 flex items-center gap-1.5 rounded-md transition-all ${
                            effectiveAudioFile 
                                ? 'bg-gradient-to-r from-purple-900/60 to-indigo-900/60 hover:from-purple-800 hover:to-indigo-800 text-purple-200 border border-purple-500/40 shadow-sm' 
                                : 'bg-white/5 hover:bg-white/10 text-white'
                        }`} 
                        title="Vocal & Speech Audio Alignment (Gemini AI Alt C)"
                    >
                        <Sparkles className="w-3.5 h-3.5 text-yellow-300 shrink-0" />
                        <span className="text-xs font-semibold hidden md:inline">Audio Align</span>
                    </button>
                    <button onClick={() => setShowTextTools(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Bulk Text Tools">
                        <FileText className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    </button>
                    <button onClick={() => setShowPreviewSettings(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Caption Style">
                        <Settings className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    </button>
                    <button onClick={saveCurrentFrame} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Save Frame">
                        <Camera className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    </button>
                    <button onClick={() => setVideoHeightMode(prev => prev === 'large' ? 'normal' : 'large')} className={`shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center rounded-md transition-colors ${videoHeightMode === 'large' ? 'bg-indigo-600 text-white' : 'bg-white/5 hover:bg-white/10 text-white'}`} title={videoHeightMode === 'large' ? "Standard Video Size" : "Enlarge Video View"}>
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
                    <input type="file" accept="audio/*,video/*" ref={audioFileInputRef} className="hidden" onChange={handleMediaFileUpload} />
                    <input type="file" accept="video/*,image/*" ref={visualMediaInputRef} className="hidden" onChange={handleVisualMediaSelect} />
                    <button onClick={() => fileInputRef.current?.click()} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Import/Overwrite Subtitles">
                        <Upload className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    </button>
                    <button onClick={() => appendInputRef.current?.click()} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 rounded-md text-white transition-colors" title="Append Subtitles">
                        <FilePlus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    </button>
                    <button onClick={() => setShowExportModal(true)} className="shrink-0 w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center bg-indigo-600 hover:bg-indigo-500 rounded-md text-white transition-colors" title="Export SRT">
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

            {selectedBlock && (
                <div className="relative w-full shrink-0 z-40 bg-[#1a1a1a] border-t border-white/10 group/actionbar">
                    {/* Left Scroll Chevron for quick navigation */}
                    {actionBarCanScrollLeft && (
                        <button 
                            type="button"
                            onClick={() => scrollActionBar('left')}
                            className="absolute left-0 top-0 bottom-0 z-50 px-1 sm:px-1.5 bg-gradient-to-r from-[#1a1a1a] via-[#1a1a1a]/90 to-transparent text-white/80 hover:text-white flex items-center justify-center transition-all cursor-pointer shadow-md"
                            title="Scroll bar left"
                        >
                            <ChevronLeft className="w-4 h-4 drop-shadow" />
                        </button>
                    )}

                    {/* Right Scroll Chevron for quick navigation */}
                    {actionBarCanScrollRight && (
                        <button 
                            type="button"
                            onClick={() => scrollActionBar('right')}
                            className="absolute right-0 top-0 bottom-0 z-50 px-1 sm:px-1.5 bg-gradient-to-l from-[#1a1a1a] via-[#1a1a1a]/90 to-transparent text-white/80 hover:text-white flex items-center justify-center transition-all cursor-pointer shadow-md"
                            title="Scroll bar right"
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
                        onWheel={(e) => {
                            if (e.deltaY !== 0 && !e.deltaX) {
                                e.currentTarget.scrollLeft += e.deltaY;
                            }
                        }}
                        className="flex items-center justify-start sm:justify-between px-2 py-1 sm:py-1.5 w-full gap-1.5 sm:gap-2 shrink-0 overflow-x-auto select-none touch-pan-x [-webkit-overflow-scrolling:touch] custom-scrollbar flex-nowrap"
                        style={{ touchAction: 'pan-x' }}
                    >
                     <div className="flex items-center gap-1 shrink-0">
                         {/* Gemini AI Semantic Alignment Button (Alt C) */}
                         <button 
                             onClick={handleAiAlignSelected}
                             disabled={isAiAligning || !effectiveAudioFile || selectedBlock.isLocked}
                             className="flex items-center gap-1 px-2 sm:px-2.5 py-1 bg-gradient-to-r from-purple-600 via-indigo-600 to-indigo-700 hover:from-purple-500 hover:to-indigo-600 active:scale-95 disabled:bg-white/5 disabled:text-white/20 text-white rounded-lg text-xs font-bold transition-all shrink-0 shadow-md border border-purple-400/30"
                             title={
                                 !effectiveAudioFile ? "Upload an audio or video file to use AI Alignment" :
                                 selectedBlock.isLocked ? "Unlock block to align" :
                                 "Gemini AI Semantic Alignment (Alt C): Listens strictly to human vocals and dialogue syllables, ignoring drums, 808 bass, and instruments."
                             }
                         >
                             {isAiAligning && aiAlignMode === 'single' ? (
                                 <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                             ) : (
                                 <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                             )}
                             <span>AI Align</span>
                         </button>

                         <button 
                             onClick={() => setMoveModeId(prev => prev === selectedId ? null : selectedId)} 
                             className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg transition-colors border ${moveModeId === selectedId ? 'bg-red-500 hover:bg-red-600 text-white shadow-[0_0_10px_rgba(239,68,68,0.5)] border-red-400' : 'bg-white/5 hover:bg-white/10 text-white/70 border-white/10'}`} 
                             title="Move Block (Click and drag timeline to shift subtitle)"
                         >
                             <Move className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                             <span className="hidden sm:inline font-bold text-xs">{moveModeId === selectedId ? 'Moving' : 'Move'}</span>
                         </button>

                         <button 
                             onClick={toggleLockBlock} 
                             className={`flex items-center gap-1 px-2 sm:px-2.5 py-1 rounded-lg transition-colors border ${selectedBlock.isLocked ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-[0_0_10px_rgba(245,158,11,0.5)] border-amber-400' : 'bg-white/5 hover:bg-white/10 text-white/70 border-white/10'}`} 
                             title={selectedBlock.isLocked ? "Unlock (Allow Sync Ripple)" : "Lock (Act as Wall)"}
                         >
                             {selectedBlock.isLocked ? <Lock className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Unlock className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
                             <span className="hidden sm:inline font-bold text-xs">{selectedBlock.isLocked ? 'Locked' : 'Lock'}</span>
                         </button>

                         {/* Unified [subleft][in][out][subright] Trimming & Navigation Group */}
                         <div className="inline-flex items-stretch rounded-lg bg-black/50 border border-white/20 p-0.5 shadow-sm shrink-0 divide-x divide-white/10" title="Trimming & Navigation: [subleft][in][out][subright]">
                             {/* [subleft] */}
                             <button 
                                 type="button"
                                 onClick={handleSelectPrevSubtitle}
                                 disabled={isFirstSub}
                                 className="flex items-center gap-0.5 px-1.5 sm:px-2 py-1 bg-white/5 hover:bg-white/20 active:bg-white/30 disabled:opacity-30 disabled:hover:bg-white/5 text-white/90 hover:text-white rounded-l-md text-[10px] sm:text-[11px] font-medium transition-all shrink-0 cursor-pointer disabled:cursor-not-allowed"
                                 title="Previous Subtitle [subleft] (Alt+Left or ,)"
                             >
                                 <ChevronLeft className="w-3.5 h-3.5 -ml-0.5 text-indigo-400" />
                                 <span className="font-mono text-[10px] font-semibold">Sub</span>
                             </button>

                             {/* [in] */}
                             <button 
                                 type="button"
                                 onClick={() => handleSetMarkIn(selectedBlock.id)}
                                 className="flex items-center gap-0.5 px-2 py-1 bg-white/5 hover:bg-amber-500/25 active:bg-amber-500/40 text-amber-300 hover:text-amber-200 font-mono text-[10px] sm:text-[11px] font-bold transition-all shrink-0 cursor-pointer"
                                 title="Mark In [in]: Align subtitle start to current playhead position ([)"
                             >
                                 <span className="text-amber-400/80 font-black">[</span>
                                 <span>In</span>
                             </button>

                             {/* [out] */}
                             <button 
                                 type="button"
                                 onClick={() => handleSetMarkOut(selectedBlock.id)}
                                 className="flex items-center gap-0.5 px-2 py-1 bg-white/5 hover:bg-amber-500/25 active:bg-amber-500/40 text-amber-300 hover:text-amber-200 font-mono text-[10px] sm:text-[11px] font-bold transition-all shrink-0 cursor-pointer"
                                 title="Mark Out [out]: Align subtitle end to current playhead position (])"
                             >
                                 <span>Out</span>
                                 <span className="text-amber-400/80 font-black">]</span>
                             </button>

                             {/* [subright] */}
                             <button 
                                 type="button"
                                 onClick={handleSelectNextSubtitle}
                                 disabled={isLastSub}
                                 className="flex items-center gap-0.5 px-1.5 sm:px-2 py-1 bg-white/5 hover:bg-white/20 active:bg-white/30 disabled:opacity-30 disabled:hover:bg-white/5 text-white/90 hover:text-white rounded-r-md text-[10px] sm:text-[11px] font-medium transition-all shrink-0 cursor-pointer disabled:cursor-not-allowed"
                                 title="Next Subtitle [subright] (Alt+Right or .)"
                             >
                                 <span className="font-mono text-[10px] font-semibold">Sub</span>
                                 <ChevronRight className="w-3.5 h-3.5 -mr-0.5 text-indigo-400" />
                             </button>
                         </div>

                         {/* Fallback Amplitude Peak Snap */}
                         <button 
                             onClick={handleSnapSelectedToAudio}
                             disabled={isAnalyzingAudio || !effectiveAudioFile || selectedBlock.isLocked}
                             className="flex items-center gap-1 px-1.5 sm:px-2 py-1 bg-white/5 hover:bg-white/10 active:scale-95 disabled:bg-white/5 disabled:text-white/20 text-white/70 hover:text-white rounded-lg text-xs font-medium transition-all shrink-0"
                             title="Peak Snap: Mathematical volume threshold detector (fallback)"
                         >
                             {isAnalyzingAudio ? (
                                 <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                             ) : (
                                 <AudioWaveform className="w-3.5 h-3.5 text-white/60" />
                             )}
                             <span className="hidden md:inline">Peak</span>
                         </button>
                     </div>
                     <div className="flex items-center gap-1.5 flex-1 min-w-[70px] max-w-[200px] sm:max-w-none overflow-hidden shrink-0 sm:shrink">
                         <button 
                             onClick={() => seekTo(selectedBlock.start, false)} 
                             className="text-[10px] font-mono text-indigo-300 hover:text-white bg-indigo-950/70 hover:bg-indigo-900 px-1.5 py-0.5 sm:px-2 sm:py-1 rounded border border-indigo-500/30 flex items-center gap-1 shrink-0 transition-colors cursor-pointer" 
                             title="Jump video to subtitle start"
                         >
                             <Play className="w-2.5 h-2.5 fill-current" /> {formatTimeWithMs(selectedBlock.start)}
                         </button>
                         <button
                             type="button"
                             onClick={() => setIsEditingText(true)}
                             className="flex items-center gap-1 px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white rounded-lg text-xs font-bold shrink-0 transition-all cursor-pointer shadow-sm border border-indigo-400/30"
                             title="Edit Subtitle Text"
                         >
                             <Edit3 className="w-3.5 h-3.5" />
                             <span>Edit</span>
                         </button>
                         <div 
                             onClick={() => setIsEditingText(true)}
                             className="flex-1 overflow-hidden bg-black/40 hover:bg-black/60 border border-white/10 hover:border-indigo-500/40 rounded-lg px-2.5 py-1 cursor-pointer transition-colors"
                             title="Click to edit subtitle text"
                         >
                             {selectedBlock.text && selectedBlock.text.includes('\n') ? (
                                 <div className="flex items-center gap-1.5 text-[11px] truncate">
                                     <span className="text-white/90 truncate"><span className="text-indigo-400 font-bold text-[9px] mr-0.5">L1:</span>{selectedBlock.text.split('\n')[0]}</span>
                                     <span className="text-white/30">•</span>
                                     <span className="text-emerald-300 truncate"><span className="text-emerald-400 font-bold text-[9px] mr-0.5">L2:</span>{selectedBlock.text.split('\n').slice(1).join(' ')}</span>
                                 </div>
                             ) : (
                                 <p className="text-[11px] sm:text-xs text-white/80 truncate font-medium">{selectedBlock.text || "Empty subtitle (click to edit)"}</p>
                             )}
                         </div>
                     </div>
                     <div className="flex items-center gap-1 shrink-0">
                        {/* Exact Nudge / Shift Stepper */}
                        <div className="inline-flex items-center rounded-lg bg-black/50 border border-white/20 p-0.5 shadow-sm divide-x divide-white/10 shrink-0" title="Nudge Subtitle: Shift timing backward or forward with exact precision (Shift+Left/Right)">
                            <button 
                                type="button" 
                                onClick={() => handleNudge(-500)}
                                disabled={selectedBlock.isLocked}
                                className="px-1.5 py-1 text-[10px] font-mono font-medium text-white/80 hover:text-white hover:bg-white/10 active:bg-white/20 disabled:opacity-30 rounded-l-md transition-colors"
                                title="Nudge -500ms (Shift 0.5s earlier, Alt+Shift+Left)"
                            >
                                -0.5s
                            </button>
                            <button 
                                type="button" 
                                onClick={() => handleNudge(-100)}
                                disabled={selectedBlock.isLocked}
                                className="px-1.5 py-1 text-[10px] font-mono font-medium text-white/80 hover:text-white hover:bg-white/10 active:bg-white/20 disabled:opacity-30 transition-colors"
                                title="Nudge -100ms (Shift 100ms earlier, Shift+Left)"
                            >
                                -100ms
                            </button>
                            <button 
                                type="button" 
                                onClick={() => handleNudge(100)}
                                disabled={selectedBlock.isLocked}
                                className="px-1.5 py-1 text-[10px] font-mono font-medium text-white/80 hover:text-white hover:bg-white/10 active:bg-white/20 disabled:opacity-30 transition-colors"
                                title="Nudge +100ms (Shift 100ms later, Shift+Right)"
                            >
                                +100ms
                            </button>
                            <button 
                                type="button" 
                                onClick={() => handleNudge(500)}
                                disabled={selectedBlock.isLocked}
                                className="px-1.5 py-1 text-[10px] font-mono font-medium text-white/80 hover:text-white hover:bg-white/10 active:bg-white/20 disabled:opacity-30 rounded-r-md transition-colors"
                                title="Nudge +500ms (Shift 0.5s later, Alt+Shift+Right)"
                            >
                                +0.5s
                            </button>
                        </div>

                        <button 
                            type="button"
                            onClick={() => {
                                setSyncScope('from_selected');
                                setShowSyncSettings(true);
                            }}
                            className="px-2 py-1 bg-indigo-600/30 hover:bg-indigo-600/50 text-indigo-200 hover:text-white rounded-lg transition-colors flex items-center gap-1 text-[10px] sm:text-[11px] font-semibold border border-indigo-500/30 shrink-0 cursor-pointer"
                            title="Ripple Shift: Shift this and all following subtitles backward or forward in time"
                        >
                            <FastForward className="w-3.5 h-3.5 text-indigo-300" />
                            <span className="hidden sm:inline">Shift Following...</span>
                        </button>

                        {(() => {
                            const l1 = (selectedBlock.text || '').split('\n')[0] || '';
                            const l2 = (selectedBlock.text || '').split('\n')[1] || '';
                            const sCount = Math.max(splitSentences(l1).length, splitSentences(l2).length);
                            if (sCount >= 2) {
                                return (
                                    <button
                                        type="button"
                                        onClick={splitBlockSentences}
                                        className="px-2 py-1 bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-200 hover:text-white rounded-lg transition-colors flex items-center gap-1 text-[10px] sm:text-[11px] font-bold border border-emerald-500/40 shrink-0 cursor-pointer shadow-sm animate-in fade-in"
                                        title={`Split this long cue into ${sCount} individual sentence boxes`}
                                    >
                                        <Scissors className="w-3.5 h-3.5 text-emerald-400" />
                                        <span>Split {sCount} Sentences</span>
                                    </button>
                                );
                            }
                            return null;
                        })()}

                        <button onClick={splitBlock} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 transition-colors" title="Split">
                            <Split className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={duplicateBlock} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-white/70 transition-colors" title="Duplicate">
                            <Copy className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={deleteBlock} className="p-1.5 bg-white/5 hover:bg-red-500/20 text-red-400 rounded-lg transition-colors" title="Delete">
                            <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                        <button onClick={() => { setSelectedId(null); setMoveModeId(null); }} className="p-1.5 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white rounded-lg transition-colors" title="Deselect">
                            <X className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                        </button>
                     </div>
                  </div>
                </div>
            )}

            {/* Timeline Bottom Section (FIXED PLAYHEAD) */}
            <div className="h-36 sm:h-44 md:h-52 bg-[#1a1a1a] border-t border-white/10 flex flex-col shrink-0 relative overflow-hidden select-none" ref={timelineRef} style={{ touchAction: 'none' }}>
                
                {/* Floating Snap Notification Toast */}
                {snapNotification && (
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-3.5 py-1.5 bg-indigo-950/95 border border-indigo-500/50 text-indigo-100 rounded-full shadow-2xl text-xs font-semibold backdrop-blur-md transition-all">
                        <AudioWaveform className="w-3.5 h-3.5 text-indigo-400 shrink-0 animate-pulse" />
                        <span>{snapNotification}</span>
                        <button onClick={() => setSnapNotification(null)} className="ml-1 text-indigo-300/60 hover:text-white">
                            <X className="w-3 h-3" />
                        </button>
                    </div>
                )}

                {/* Live Floating Pinch Zoom Indicator */}
                {pinchZoomFeedback !== null && (
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-3 py-1 bg-amber-950/95 border border-amber-400 text-amber-300 rounded-full shadow-2xl text-xs font-mono font-bold backdrop-blur-md pointer-events-none animate-in fade-in duration-100">
                        <ZoomIn className="w-3.5 h-3.5 text-amber-400 animate-pulse" />
                        <span>Pinch Zoom: {Math.round(pinchZoomFeedback)} px/s</span>
                    </div>
                )}

                {/* Viewport-Fixed Waveform Canvas behind the scrolling track */}
                {showWaveform && audioProfile && (
                    <canvas 
                        ref={waveformCanvasRef}
                        className="absolute top-8 sm:top-11 left-0 pointer-events-none z-10"
                        style={{ width: `${containerWidth}px`, height: window.innerWidth < 640 ? '56px' : '64px' }}
                    />
                )}

                {/* Static Center Mark */}
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
                    className="absolute top-0 left-0 h-full will-change-transform cursor-grab active:cursor-grabbing touch-none select-none [-webkit-touch-callout:none]"
                    style={{ 
                        width: `${timelineWidth}px`, 
                        transform: `translateX(${trackOffset}px)`,
                        touchAction: 'none'
                    }}
                    onPointerDown={(e) => handlePointerDown(e, 'scrub')}
                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                >
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

                    <div className="absolute top-8 sm:top-11 left-0 w-full h-14 sm:h-16 bg-black/20 border-y border-white/5 flex items-center">
                        {/* Ghost Box for Original Position during drag */}
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
                            const isSnapped = block.id === snappedBlockId;
                            const left = (block.start / 1000) * activeZoom;
                            const width = ((block.end - block.start) / 1000) * activeZoom;
                            const isCompact = width < 68;
                            
                            const bgClass = isSnapped
                                ? 'bg-emerald-600/90 border-2 border-emerald-300 ring-2 ring-emerald-400 shadow-[0_0_15px_rgba(52,211,153,0.6)] z-30 animate-pulse'
                                : block.isLocked 
                                    ? (isSelected ? 'bg-amber-900/60 border-y-2 border-amber-500 z-20' : 'bg-zinc-800/80 border border-zinc-600 hover:bg-zinc-700/80')
                                    : (isDragging ? 'bg-emerald-500/40 border-2 border-emerald-400 ring-2 ring-emerald-400/40 shadow-[0_0_20px_rgba(16,185,129,0.4)] z-40'
                                        : isMoveMode ? 'bg-red-500/40 border-y-2 border-red-400 z-30 hover:bg-red-500/50'
                                        : isSelected ? 'bg-amber-500/25 border-y-2 border-amber-400 z-20'
                                        : 'bg-amber-600/80 border border-amber-500/50 hover:bg-amber-500');

                            const cursorClass = block.isLocked ? 'cursor-pointer' : (isDragging ? 'cursor-grabbing' : (isMoveMode ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'));
                            
                            return (
                                <div 
                                    key={block.id}
                                    className={`absolute h-11 sm:h-12 rounded-md shadow-md flex items-center overflow-visible transition-colors select-none [-webkit-touch-callout:none] box-border touch-none ${bgClass} ${cursorClass}`}
                                    style={{ left: `${left}px`, width: `${Math.max(width, 1)}px`, touchAction: 'none' }}
                                    onPointerDown={(e) => handlePointerDown(e, (block.isLocked || !isMoveMode) ? 'select_only' : (dragMode === 'sync' ? 'sync_move' : 'move'), block.id, block)}
                                    onDoubleClick={(e) => { e.stopPropagation(); setSelectedId(block.id); setIsEditingText(true); }}
                                    onDragStart={(e) => e.preventDefault()}
                                    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                >
                                    {/* Live Floating Movement & Timing Distance HUD Tooltip */}
                                    {isDragging && dragHUD && dragHUD.id === block.id && (
                                        <div className="absolute -top-14 left-1/2 -translate-x-1/2 pointer-events-none z-50 flex flex-col items-center whitespace-nowrap drop-shadow-2xl select-none">
                                            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono font-bold shadow-2xl border backdrop-blur-md transition-colors ${
                                                dragHUD.atMinBound || dragHUD.atMaxBound
                                                    ? 'bg-rose-950/95 text-rose-200 border-rose-500 shadow-rose-950/70'
                                                    : dragHUD.deltaMs > 0
                                                        ? 'bg-emerald-950/95 text-emerald-200 border-emerald-400/80 shadow-emerald-950/70'
                                                        : dragHUD.deltaMs < 0
                                                            ? 'bg-sky-950/95 text-sky-200 border-sky-400/80 shadow-sky-950/70'
                                                            : 'bg-zinc-900/95 text-white border-white/40 shadow-black/80'
                                            }`}>
                                                <span className="text-xs font-black tracking-wide">
                                                    {dragHUD.deltaMs > 0 ? `+${(dragHUD.deltaMs / 1000).toFixed(2)}s` : dragHUD.deltaMs < 0 ? `${(dragHUD.deltaMs / 1000).toFixed(2)}s` : '0.00s'}
                                                </span>
                                                <span className="text-white/40 font-normal">|</span>
                                                <span className="text-[10px] font-semibold text-white/90">
                                                    {formatTimeWithMs(dragHUD.newStart)} → {formatTimeWithMs(dragHUD.newEnd)}
                                                </span>
                                                {(dragHUD.atMinBound || dragHUD.atMaxBound) && (
                                                    <span className="bg-rose-500 text-white text-[9px] px-1.5 py-0.5 rounded font-sans uppercase font-black tracking-wider shadow">
                                                        {dragHUD.boundaryReason || 'Boundary'}
                                                    </span>
                                                )}
                                            </div>
                                            {(dragHUD.gapBefore !== null || dragHUD.gapAfter !== null) && (
                                                <div className="flex items-center gap-1.5 text-[9px] font-mono text-white/80 bg-black/90 px-2 py-0.5 rounded-full mt-1 border border-white/15 shadow">
                                                    {dragHUD.gapBefore !== null && (
                                                        <span>Prev gap: {(dragHUD.gapBefore / 1000).toFixed(2)}s</span>
                                                    )}
                                                    {dragHUD.gapBefore !== null && dragHUD.gapAfter !== null && <span className="text-white/30">•</span>}
                                                    {dragHUD.gapAfter !== null && (
                                                        <span>Next gap: {(dragHUD.gapAfter / 1000).toFixed(2)}s</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Left Trim Handle */}
                                    {isSelected && (
                                        <div 
                                            className={`absolute left-0 top-0 bottom-0 ${isCompact ? 'w-4 sm:w-3' : 'w-8 sm:w-5'} ${isDragging ? 'bg-emerald-400' : 'bg-amber-400'} cursor-ew-resize flex items-center justify-center z-10 touch-none select-none [-webkit-touch-callout:none] shadow-[2px_0_4px_rgba(0,0,0,0.3)] rounded-l-md before:content-[''] before:absolute before:inset-y-0 before:-left-6 before:w-6 before:bg-transparent`}
                                            style={{ touchAction: 'none' }}
                                            onPointerDown={(e) => handlePointerDown(e, dragMode === 'sync' ? 'sync_start' : 'start', block.id, block)}
                                            onDragStart={(e) => e.preventDefault()}
                                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
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
                                            className="absolute -top-7 right-0 bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-white text-[10px] px-2 py-0.5 rounded font-sans font-bold shadow-md flex items-center gap-1 z-30 cursor-pointer border border-indigo-400/40"
                                            title="Edit Subtitle Text"
                                        >
                                            <Edit3 className="w-3 h-3" />
                                            <span>Edit</span>
                                        </button>
                                    )}

                                    {/* Right Trim Handle */}
                                    {isSelected && (
                                        <div 
                                            className={`absolute right-0 top-0 bottom-0 ${isCompact ? 'w-4 sm:w-3' : 'w-8 sm:w-5'} ${isDragging ? 'bg-emerald-400' : 'bg-amber-400'} cursor-ew-resize flex items-center justify-center z-10 touch-none select-none [-webkit-touch-callout:none] shadow-[-2px_0_4px_rgba(0,0,0,0.3)] rounded-r-md before:content-[''] before:absolute before:inset-y-0 before:-right-6 before:w-6 before:bg-transparent`}
                                            style={{ touchAction: 'none' }}
                                            onPointerDown={(e) => handlePointerDown(e, dragMode === 'sync' ? 'sync_end' : 'end', block.id, block)}
                                            onDragStart={(e) => e.preventDefault()}
                                            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
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

            {/* Extract Settings Modal */}
            {showExtractSettings && (
                <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto" onClick={() => setShowExtractSettings(false)}>
                    <div className="bg-[#1a1a1a] border border-white/20 p-6 rounded-2xl shadow-2xl flex flex-col gap-6 min-w-[320px] max-w-[90%] my-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-bold text-white/70 uppercase tracking-wider flex items-center gap-2">
                                <Scissors className="w-4 h-4"/> Extract Subtitles
                            </h4>
                            <button onClick={() => setShowExtractSettings(false)} className="text-white/40 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="space-y-5 text-sm text-white/80">
                            <p>Extract a specific segment and automatically re-time the subtitles to start from 0.</p>
                            <div className="flex gap-4">
                                <div className="flex-1 space-y-2">
                                    <label className="text-xs font-bold text-white/50 uppercase">Start Time</label>
                                    <div className="relative w-full">
                                        <input 
                                            type="number" 
                                            step="0.1"
                                            min="0"
                                            value={extractStart === 0 ? '' : extractStart} 
                                            onChange={e => setExtractStart(Number(e.target.value))} 
                                            className="w-full bg-black/50 border border-white/10 focus:border-indigo-500/50 outline-none rounded-lg p-2.5 pr-8 text-white font-mono transition-colors" 
                                            placeholder="e.g. 60"
                                        />
                                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 font-mono text-sm pointer-events-none">s</span>
                                    </div>
                                </div>
                                <div className="flex-1 space-y-2">
                                    <label className="text-xs font-bold text-white/50 uppercase">End Time</label>
                                    <div className="relative w-full">
                                        <input 
                                            type="number" 
                                            step="0.1"
                                            min="0"
                                            value={extractEnd === 0 ? '' : extractEnd} 
                                            onChange={e => setExtractEnd(Number(e.target.value))} 
                                            className="w-full bg-black/50 border border-white/10 focus:border-indigo-500/50 outline-none rounded-lg p-2.5 pr-8 text-white font-mono transition-colors" 
                                            placeholder={`e.g. ${Math.round(duration / 1000)}`}
                                        />
                                        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-white/40 font-mono text-sm pointer-events-none">s</span>
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 mt-2">
                               <button onClick={extractSegment} className="w-full px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-bold transition-colors cursor-pointer">Apply Extraction</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Snap & Audio Alignment Modal */}
            {showSnapSettings && (
                <div 
                    className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center bg-black/85 backdrop-blur-sm p-2 sm:p-4 overflow-y-auto" 
                    onClick={() => setShowSnapSettings(false)}
                >
                    <div 
                        className="bg-[#161616] border border-white/20 rounded-2xl shadow-2xl flex flex-col w-full max-w-lg max-h-[92vh] sm:max-h-[88vh] my-auto overflow-hidden animate-in fade-in zoom-in-95 duration-150" 
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Sticky Modal Header */}
                        <div className="flex items-center justify-between border-b border-white/10 px-4 sm:px-6 py-3.5 sm:py-4 bg-[#1a1a1c] shrink-0">
                            <div className="flex items-center gap-2.5">
                                <div className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-500/30 flex items-center justify-center text-purple-300 shrink-0">
                                    <Sparkles className="w-4 h-4 text-yellow-300" />
                                </div>
                                <div>
                                    <h4 className="text-sm sm:text-base font-bold text-white flex items-center gap-2">
                                        Audio & Speech Alignment
                                    </h4>
                                    <p className="text-[11px] text-white/50">Align subtitle boundaries to vocals and speech</p>
                                </div>
                            </div>
                            <button 
                                onClick={() => setShowSnapSettings(false)} 
                                className="p-2 -mr-1 rounded-xl bg-white/10 hover:bg-white/20 active:bg-white/30 text-white transition-colors flex items-center justify-center cursor-pointer"
                                title="Close window"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Scrollable Content Body */}
                        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4 custom-scrollbar touch-pan-y">
                            {/* Audio Source Card */}
                            <div className="bg-white/5 border border-white/10 rounded-xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-9 h-9 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 shrink-0">
                                        <AudioWaveform className="w-4 h-4" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-[10px] text-white/50 uppercase tracking-wider font-semibold">Audio / Video Track</p>
                                        <p className="text-xs sm:text-sm font-semibold text-white truncate max-w-[200px] sm:max-w-xs">
                                            {effectiveAudioFile ? effectiveAudioFile.name : 'No track uploaded'}
                                        </p>
                                        {audioProfile ? (
                                            <p className="text-[10px] text-emerald-400 font-mono mt-0.5">
                                                Waveform indexed ({(audioProfile.duration).toFixed(1)}s)
                                            </p>
                                        ) : isAnalyzingAudio ? (
                                            <p className="text-[10px] text-indigo-300 font-mono mt-0.5 animate-pulse">
                                                Analyzing waveform...
                                            </p>
                                        ) : audioAnalysisError ? (
                                            <p className="text-[10px] text-amber-400 font-mono mt-0.5 truncate max-w-[280px]" title={audioAnalysisError}>
                                                ⚠️ {audioAnalysisError}
                                            </p>
                                        ) : null}
                                    </div>
                                </div>

                                <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                                    <button 
                                        onClick={() => audioFileInputRef.current?.click()}
                                        className="w-full sm:w-auto px-3 py-1.5 bg-white/10 hover:bg-white/20 text-white rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                                    >
                                        <Upload className="w-3.5 h-3.5" />
                                        <span>{effectiveAudioFile ? 'Change File' : 'Upload Track'}</span>
                                    </button>
                                </div>
                            </div>

                            {/* Alignment Method Switcher Tabs */}
                            <div className="flex items-center bg-black/50 p-1 rounded-xl border border-white/10">
                                <button
                                    onClick={() => setAlignmentModalTab('ai')}
                                    className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-2 transition-all cursor-pointer ${
                                        alignmentModalTab === 'ai'
                                            ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white shadow-lg'
                                            : 'text-white/60 hover:text-white'
                                    }`}
                                >
                                    <Sparkles className="w-3.5 h-3.5 text-yellow-300" />
                                    <span>Gemini AI Vocals</span>
                                    <span className="bg-yellow-400/20 text-yellow-300 text-[9px] px-1.5 py-0.2 rounded font-bold uppercase tracking-wider">Alt C</span>
                                </button>

                                <button
                                    onClick={() => setAlignmentModalTab('amplitude')}
                                    className={`flex-1 py-2 px-3 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer ${
                                        alignmentModalTab === 'amplitude'
                                            ? 'bg-white/15 text-white shadow-lg'
                                            : 'text-white/40 hover:text-white'
                                    }`}
                                >
                                    <Sliders className="w-3.5 h-3.5" />
                                    <span>Peak Volume</span>
                                </button>
                            </div>

                            {/* Tab 1: Gemini AI Semantic Alignment (Alt C) */}
                            {alignmentModalTab === 'ai' && (
                                <div className="space-y-4">
                                    <div className="bg-gradient-to-br from-purple-950/40 to-indigo-950/40 border border-purple-500/20 rounded-xl p-3.5 space-y-1.5">
                                        <div className="flex items-center gap-1.5 text-purple-300 text-xs font-bold">
                                            <Sparkles className="w-4 h-4 text-yellow-300" />
                                            <span>Semantic Speech & Vocal Recognition</span>
                                        </div>
                                        <p className="text-[11px] text-white/70 leading-relaxed">
                                            Listens strictly to human vocals and dialogue phonemes. 
                                            Unlike amplitude snapping, it completely disregards drum kicks, 808 bass, and synth beats so subtitle boxes remain orderly and match the spoken lyrics.
                                        </p>
                                    </div>

                                    {/* Active AI Progress Indicator */}
                                    {isAiAligning && (
                                        <div className="p-3.5 bg-indigo-950/80 border border-indigo-500/40 rounded-xl space-y-2">
                                            <div className="flex items-center justify-between text-xs font-semibold text-indigo-200">
                                                <div className="flex items-center gap-2">
                                                    <div className="w-3.5 h-3.5 border-2 border-indigo-400 border-t-white rounded-full animate-spin" />
                                                    <span>{aiAlignStatusText || "Gemini AI is analyzing vocals..."}</span>
                                                </div>
                                                {aiAlignMode === 'all' && (
                                                    <span className="font-mono text-yellow-300">{aiAlignProgress}%</span>
                                                )}
                                            </div>
                                            {aiAlignMode === 'all' && (
                                                <div className="w-full bg-white/10 h-1.5 rounded-full overflow-hidden">
                                                    <div 
                                                        className="bg-gradient-to-r from-purple-500 to-indigo-500 h-full transition-all duration-300"
                                                        style={{ width: `${Math.max(5, aiAlignProgress)}%` }}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Selected Block AI Align */}
                                    <div className="bg-black/30 border border-white/5 rounded-xl p-3 space-y-2.5">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-semibold text-white/80">Selected Block</span>
                                            {selectedBlock ? (
                                                <span className="text-[10px] font-mono text-purple-300 bg-purple-950/70 border border-purple-500/30 px-2 py-0.5 rounded">
                                                    {formatTimeWithMs(selectedBlock.start)}
                                                </span>
                                            ) : (
                                                <span className="text-[10px] text-white/40 italic">None selected</span>
                                            )}
                                        </div>

                                        {selectedBlock ? (
                                            <p className="text-xs text-white/90 bg-white/5 p-2 rounded-lg truncate border border-white/5 font-medium">
                                                "{selectedBlock.text || 'Empty text'}"
                                            </p>
                                        ) : (
                                            <p className="text-[11px] text-white/40">
                                                Click any subtitle block on the timeline to align its timing individually.
                                            </p>
                                        )}

                                        <button
                                            onClick={handleAiAlignSelected}
                                            disabled={!selectedBlock || selectedBlock.isLocked || !effectiveAudioFile || isAiAligning}
                                            className="w-full py-2.5 px-3 bg-gradient-to-r from-purple-600 via-indigo-600 to-indigo-700 hover:from-purple-500 hover:to-indigo-600 active:scale-98 disabled:bg-white/5 disabled:text-white/20 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-md border border-purple-400/30 cursor-pointer"
                                        >
                                            {isAiAligning && aiAlignMode === 'single' ? (
                                                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                                            ) : (
                                                <Sparkles className="w-4 h-4 text-yellow-300" />
                                            )}
                                            <span>AI Align Selected Block</span>
                                        </button>
                                    </div>

                                    {/* Batch All Blocks AI Align */}
                                    <div className="bg-black/30 border border-white/5 rounded-xl p-3 space-y-2">
                                        <div className="flex items-center justify-between">
                                            <span className="text-xs font-semibold text-white/80">Full Song Batch Alignment</span>
                                            <span className="text-[11px] font-mono text-indigo-300">{blocksState.length} blocks</span>
                                        </div>
                                        <button
                                            onClick={handleAiAlignAll}
                                            disabled={blocksState.length === 0 || !effectiveAudioFile || isAiAligning}
                                            className="w-full py-2.5 px-3 bg-white/10 hover:bg-white/15 active:scale-98 disabled:bg-white/5 disabled:text-white/20 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all border border-white/10 cursor-pointer"
                                        >
                                            {isAiAligning && aiAlignMode === 'all' ? (
                                                <div className="w-3.5 h-3.5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                                            ) : (
                                                <Wand2 className="w-4 h-4 text-indigo-300" />
                                            )}
                                            <span>AI Align All ({blocksState.length}) Subtitles</span>
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Tab 2: Amplitude Peak Snap (Legacy) */}
                            {alignmentModalTab === 'amplitude' && (
                                <div className="space-y-4">
                                    <div className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-1">
                                        <p className="text-xs font-semibold text-white/80 flex items-center gap-1.5">
                                            <Sliders className="w-3.5 h-3.5 text-indigo-400" /> Amplitude Decibel Detector
                                        </p>
                                        <p className="text-[11px] text-white/50 leading-relaxed">
                                            Snaps to sudden changes in audio energy. Best for podcasts or acoustic tracks without prominent drum beats.
                                        </p>
                                    </div>

                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                        <button
                                            onClick={handleSnapSelectedToAudio}
                                            disabled={!selectedBlock || selectedBlock.isLocked || !effectiveAudioFile || isAnalyzingAudio}
                                            className="p-3 bg-indigo-600/90 hover:bg-indigo-600 active:scale-95 disabled:bg-white/5 disabled:text-white/20 text-white rounded-xl font-bold text-xs flex flex-col items-center gap-1 transition-all shadow-md cursor-pointer"
                                        >
                                            <div className="flex items-center gap-1.5">
                                                <Magnet className="w-4 h-4" />
                                                <span>Snap Selected Block</span>
                                            </div>
                                            <span className="text-[10px] text-white/60 font-normal">
                                                {selectedBlock ? `Block #${selectedBlock.id.slice(0, 4)}` : 'No block selected'}
                                            </span>
                                        </button>

                                        <button
                                            onClick={handleSnapAllToAudio}
                                            disabled={blocksState.length === 0 || !effectiveAudioFile || isAnalyzingAudio}
                                            className="p-3 bg-white/10 hover:bg-white/15 active:scale-95 disabled:bg-white/5 disabled:text-white/20 text-white rounded-xl font-bold text-xs flex flex-col items-center gap-1 transition-all border border-white/10 cursor-pointer"
                                        >
                                            <div className="flex items-center gap-1.5">
                                                <Wand2 className="w-4 h-4 text-indigo-300" />
                                                <span>Snap All Blocks</span>
                                            </div>
                                            <span className="text-[10px] text-white/50 font-normal">
                                                Batch snap {blocksState.length} blocks
                                            </span>
                                        </button>
                                    </div>

                                    {/* Amplitude Sliders */}
                                    <div className="space-y-3.5 pt-2 border-t border-white/10">
                                        <div className="space-y-1.5">
                                            <div className="flex items-center justify-between">
                                                <label className="text-xs font-semibold text-white/80">
                                                    Volume Threshold Sensitivity
                                                </label>
                                                <span className="text-xs font-mono text-indigo-300">{Math.round(snapSensitivity * 100)}%</span>
                                            </div>
                                            <input 
                                                type="range"
                                                min="0.10"
                                                max="0.60"
                                                step="0.02"
                                                value={snapSensitivity}
                                                onChange={e => setSnapSensitivity(Number(e.target.value))}
                                                className="w-full accent-indigo-500 cursor-pointer h-2 bg-white/10 rounded-lg appearance-none"
                                            />
                                            <div className="flex justify-between text-[10px] text-white/40">
                                                <span>Sensitive (Catches whispers)</span>
                                                <span>Strict (Loud speech only)</span>
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="space-y-1.5">
                                                <div className="flex justify-between text-xs text-white/80">
                                                    <span>Lead-In Pre-roll</span>
                                                    <span className="font-mono text-indigo-300">{snapLeadIn}ms</span>
                                                </div>
                                                <input 
                                                    type="range"
                                                    min="0"
                                                    max="200"
                                                    step="10"
                                                    value={snapLeadIn}
                                                    onChange={e => setSnapLeadIn(Number(e.target.value))}
                                                    className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-white/10 rounded-lg appearance-none"
                                                />
                                            </div>

                                            <div className="space-y-1.5">
                                                <div className="flex justify-between text-xs text-white/80">
                                                    <span>Tail Lingering</span>
                                                    <span className="font-mono text-indigo-300">{snapTailPadding}ms</span>
                                                </div>
                                                <input 
                                                    type="range"
                                                    min="0"
                                                    max="300"
                                                    step="10"
                                                    value={snapTailPadding}
                                                    onChange={e => setSnapTailPadding(Number(e.target.value))}
                                                    className="w-full accent-indigo-500 cursor-pointer h-1.5 bg-white/10 rounded-lg appearance-none"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Sticky Modal Footer */}
                        <div className="border-t border-white/10 px-4 sm:px-6 py-3 bg-[#141416] shrink-0 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
                            <div className="flex items-center justify-between sm:justify-start gap-3">
                                <label className="text-xs font-semibold text-white/80 flex items-center gap-2 cursor-pointer select-none">
                                    <input 
                                        type="checkbox" 
                                        checked={showWaveform} 
                                        onChange={e => setShowWaveform(e.target.checked)}
                                        className="w-4 h-4 rounded accent-indigo-600 cursor-pointer"
                                    />
                                    <span>Show Waveform</span>
                                </label>
                                <span className="text-[10px] text-white/40 hidden sm:inline">Shortcuts: [in] [ | [out] ]</span>
                            </div>

                            <button
                                type="button"
                                onClick={() => setShowSnapSettings(false)}
                                className="w-full sm:w-auto px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white font-bold text-xs rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-lg cursor-pointer"
                            >
                                <Check className="w-4 h-4 text-emerald-300" />
                                <span>Done / Close Window</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Sync Settings & Timing Jump Repair Modal */}
            {showSyncSettings && (
                <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto" onClick={() => setShowSyncSettings(false)}>
                    <div className="bg-[#1a1a1a] border border-white/20 p-5 sm:p-6 rounded-2xl shadow-2xl flex flex-col gap-5 min-w-[320px] max-w-xl w-full my-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between border-b border-white/10 pb-3">
                            <h4 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                                <Clock className="w-4 h-4 text-indigo-400"/> Sync Subtitles & Timing Repair
                            </h4>
                            <button onClick={() => setShowSyncSettings(false)} className="text-white/40 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>

                        <div className="space-y-5 text-sm text-white/80 max-h-[75vh] overflow-y-auto pr-1">
                            {/* Detected Timing Jumps Warning / Quick-Fix Card */}
                            {detectedJumps.length > 0 && (
                                <div className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-xl space-y-3">
                                    <div className="flex items-center gap-2 text-amber-300 font-bold text-xs uppercase tracking-wider">
                                        <AlertTriangle className="w-4 h-4 shrink-0 animate-pulse text-amber-400" />
                                        <span>Detected Timing Jump{detectedJumps.length > 1 ? 's' : ''} ({detectedJumps.length})</span>
                                    </div>
                                    <p className="text-xs text-white/70">
                                        Large timecode gap detected. If the AI model or transcription drifted mid-file (e.g. jumped from 22min to 33min), repair it instantly:
                                    </p>
                                    <div className="space-y-2">
                                        {detectedJumps.slice(0, 3).map((jump) => (
                                            <div key={jump.toIndex} className="p-3 bg-black/50 border border-amber-500/20 rounded-lg space-y-2">
                                                <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                                                    <span className="font-bold text-amber-300">Jump before Subtitle #{jump.toIndex + 1}</span>
                                                    <span className="font-mono text-[11px] text-white/60">
                                                        Gap: <strong className="text-amber-200">{jump.gapFormatted}</strong> (#{jump.fromIndex + 1} @ {formatTimeWithMs(jump.fromBlock.end)} ➔ #{jump.toIndex + 1} @ {formatTimeWithMs(jump.toBlock.start)})
                                                    </span>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            fixTimingJump(jump, 'collapse');
                                                            setShowSyncSettings(false);
                                                        }}
                                                        className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-bold transition-all shadow cursor-pointer flex items-center gap-1.5"
                                                        title="Snap subtitle to start 0.8s after previous subtitle and ripple-shift all subsequent subtitles back"
                                                    >
                                                        <Rewind className="w-3.5 h-3.5" />
                                                        Close Gap & Ripple Shift
                                                    </button>
                                                    {jump.gapMs >= 500000 && jump.gapMs <= 700000 && (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                fixTimingJump(jump, 'offset', -600000);
                                                                setShowSyncSettings(false);
                                                            }}
                                                            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-bold transition-all shadow cursor-pointer flex items-center gap-1.5"
                                                        >
                                                            <Rewind className="w-3.5 h-3.5" />
                                                            Shift -10 Minutes (-600s)
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setSelectedId(jump.toBlock.id);
                                                            setSyncScope('from_selected');
                                                            seekTo(Math.max(0, jump.fromBlock.end - 1000), false);
                                                        }}
                                                        className="px-2.5 py-1.5 bg-white/10 hover:bg-white/20 text-white/80 hover:text-white rounded-lg text-xs font-medium transition-all cursor-pointer"
                                                    >
                                                        Select #{jump.toIndex + 1}
                                                    </button>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Target Scope Selector */}
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-white/70 uppercase tracking-wider block">
                                    Target Scope (Which subtitles to shift)
                                </label>
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                    <button
                                        type="button"
                                        disabled={!selectedBlock}
                                        onClick={() => setSyncScope('from_selected')}
                                        className={`py-2 px-2.5 rounded-lg text-xs font-medium border transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
                                            syncScope === 'from_selected'
                                                ? 'bg-indigo-600 text-white border-indigo-400 shadow-md font-bold'
                                                : 'bg-white/5 hover:bg-white/10 text-white/70 border-white/10 disabled:opacity-30 disabled:cursor-not-allowed'
                                        }`}
                                    >
                                        <span>From Selected</span>
                                        <span className="text-[10px] opacity-75 font-mono">
                                            {selectedBlock ? `#${blocks.findIndex(b => b.id === selectedId) + 1} ➔ End` : '(None selected)'}
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => setSyncScope('all')}
                                        className={`py-2 px-2.5 rounded-lg text-xs font-medium border transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
                                            syncScope === 'all'
                                                ? 'bg-indigo-600 text-white border-indigo-400 shadow-md font-bold'
                                                : 'bg-white/5 hover:bg-white/10 text-white/70 border-white/10'
                                        }`}
                                    >
                                        <span>All Subtitles</span>
                                        <span className="text-[10px] opacity-75 font-mono">Full timeline</span>
                                    </button>

                                    <button
                                        type="button"
                                        disabled={!selectedBlock}
                                        onClick={() => setSyncScope('selected_only')}
                                        className={`py-2 px-2.5 rounded-lg text-xs font-medium border transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
                                            syncScope === 'selected_only'
                                                ? 'bg-indigo-600 text-white border-indigo-400 shadow-md font-bold'
                                                : 'bg-white/5 hover:bg-white/10 text-white/70 border-white/10 disabled:opacity-30 disabled:cursor-not-allowed'
                                        }`}
                                    >
                                        <span>Single Subtitle</span>
                                        <span className="text-[10px] opacity-75 font-mono">
                                            {selectedBlock ? `#${blocks.findIndex(b => b.id === selectedId) + 1} only` : '(None selected)'}
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        onClick={() => setSyncScope('from_time')}
                                        className={`py-2 px-2.5 rounded-lg text-xs font-medium border transition-all cursor-pointer flex flex-col items-center justify-center gap-0.5 ${
                                            syncScope === 'from_time'
                                                ? 'bg-indigo-600 text-white border-indigo-400 shadow-md font-bold'
                                                : 'bg-white/5 hover:bg-white/10 text-white/70 border-white/10'
                                        }`}
                                    >
                                        <span>From Timecode</span>
                                        <span className="text-[10px] opacity-75 font-mono">Custom time</span>
                                    </button>
                                </div>

                                {syncScope === 'from_time' && (
                                    <div className="pt-2 flex items-center gap-2">
                                        <label className="text-xs text-white/60 shrink-0">Start Timecode:</label>
                                        <input
                                            type="text"
                                            value={syncFromTimeInput}
                                            onChange={e => setSyncFromTimeInput(e.target.value)}
                                            placeholder="e.g. 00:23:00 or 23:00"
                                            className="bg-black/50 border border-white/10 focus:border-indigo-500/50 rounded-lg px-2.5 py-1.5 text-xs text-white font-mono w-44"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setSyncFromTimeInput(formatTimeSrt(currentTime))}
                                            className="px-2 py-1 bg-white/10 hover:bg-white/20 text-white/80 rounded text-[11px]"
                                        >
                                            Use Playhead ({formatTimeWithMs(currentTime)})
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* Minute Scale Presets (For fixing 10min, 5min jumps) */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <label className="text-xs font-bold text-white/70 uppercase tracking-wider">
                                        Minute Shifts (Jump Repairs)
                                    </label>
                                    <span className="text-[11px] text-indigo-300 font-medium">Click to apply</span>
                                </div>
                                <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 font-mono text-xs">
                                    <button onClick={() => { shiftSubtitles(-600000); setShowSyncSettings(false); }} className="py-2 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 rounded-lg font-bold transition-all cursor-pointer" title="Shift -10 minutes (-600s)">-10m</button>
                                    <button onClick={() => { shiftSubtitles(-300000); setShowSyncSettings(false); }} className="py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-200 border border-amber-500/20 rounded-lg font-medium transition-all cursor-pointer" title="Shift -5 minutes (-300s)">-5m</button>
                                    <button onClick={() => { shiftSubtitles(-120000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer" title="Shift -2 minutes">-2m</button>
                                    <button onClick={() => { shiftSubtitles(-60000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer" title="Shift -1 minute">-1m</button>
                                    <button onClick={() => { shiftSubtitles(60000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer" title="Shift +1 minute">+1m</button>
                                    <button onClick={() => { shiftSubtitles(120000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer" title="Shift +2 minutes">+2m</button>
                                    <button onClick={() => { shiftSubtitles(300000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer" title="Shift +5 minutes">+5m</button>
                                    <button onClick={() => { shiftSubtitles(600000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer" title="Shift +10 minutes">+10m</button>
                                </div>
                            </div>

                            {/* Second Scale Presets (For fine synchronization) */}
                            <div className="space-y-2">
                                <label className="text-xs font-bold text-white/70 uppercase tracking-wider block">
                                    Second & Millisecond Shifts
                                </label>
                                <div className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 font-mono text-xs">
                                    <button onClick={() => { shiftSubtitles(-10000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">-10s</button>
                                    <button onClick={() => { shiftSubtitles(-5000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">-5s</button>
                                    <button onClick={() => { shiftSubtitles(-1000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">-1s</button>
                                    <button onClick={() => { shiftSubtitles(-500); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">-0.5s</button>
                                    <button onClick={() => { shiftSubtitles(500); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">+0.5s</button>
                                    <button onClick={() => { shiftSubtitles(1000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">+1s</button>
                                    <button onClick={() => { shiftSubtitles(5000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">+5s</button>
                                    <button onClick={() => { shiftSubtitles(10000); setShowSyncSettings(false); }} className="py-2 bg-white/5 hover:bg-white/10 rounded-lg transition-colors cursor-pointer">+10s</button>
                                </div>
                            </div>

                            {/* Custom Shift Input */}
                            <div className="space-y-2 pt-2 border-t border-white/10">
                                <label className="text-xs font-bold text-white/70 uppercase tracking-wider block">
                                    Custom Amount (Minutes, Seconds, or Timecode)
                                </label>
                                <div className="flex items-center gap-2">
                                    <div className="relative flex-1">
                                        <input 
                                            type="text" 
                                            value={syncCustomInput} 
                                            onChange={e => setSyncCustomInput(e.target.value)} 
                                            onKeyDown={e => {
                                                if (e.key === 'Enter') {
                                                    const ms = parseOffsetStringToMs(syncCustomInput);
                                                    if (ms !== 0) {
                                                        shiftSubtitles(ms);
                                                        setSyncCustomInput('');
                                                        setShowSyncSettings(false);
                                                    }
                                                }
                                            }}
                                            className="w-full bg-black/50 border border-white/10 focus:border-indigo-500/50 outline-none rounded-lg p-2.5 text-white font-mono text-xs sm:text-sm transition-colors" 
                                            placeholder="e.g. -10m, -600, -10:00, or 2.5s"
                                        />
                                    </div>
                                    <button 
                                        type="button"
                                        onClick={() => {
                                            const ms = parseOffsetStringToMs(syncCustomInput);
                                            if (ms !== 0) {
                                                shiftSubtitles(ms);
                                                setSyncCustomInput('');
                                                setShowSyncSettings(false);
                                            }
                                        }} 
                                        disabled={parseOffsetStringToMs(syncCustomInput) === 0}
                                        className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 text-white rounded-lg font-bold text-xs sm:text-sm transition-colors cursor-pointer shrink-0"
                                    >
                                        Apply Shift
                                    </button>
                                </div>
                                {syncCustomInput.trim() !== '' && (
                                    <p className="text-[11px] text-indigo-300 font-mono">
                                        Parsed offset: {parseOffsetStringToMs(syncCustomInput) / 1000}s ({Math.round(parseOffsetStringToMs(syncCustomInput) / 60000 * 10) / 10} min)
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Preview Settings Modal */}
            {showPreviewSettings && (
                <div className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto" onClick={() => setShowPreviewSettings(false)}>
                    <div className="bg-[#1a1a1a] border border-white/20 p-6 rounded-2xl shadow-2xl flex flex-col gap-6 min-w-[320px] max-w-[90%] my-auto" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between">
                            <h4 className="text-sm font-bold text-white/70 uppercase tracking-wider flex items-center gap-2">
                                <Settings className="w-4 h-4"/> Caption Style
                            </h4>
                            <button onClick={() => setShowPreviewSettings(false)} className="text-white/40 hover:text-white p-1 rounded-lg transition-colors cursor-pointer"><X className="w-5 h-5" /></button>
                        </div>
                        <div className="space-y-6">
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm text-white/60 font-medium">
                                    <span>Template Style</span>
                                </div>
                                <select 
                                    value={captionStyle} 
                                    onChange={e => setCaptionStyle(e.target.value as CaptionStyle)}
                                    className="w-full bg-black/50 border border-white/10 focus:border-indigo-500/50 outline-none rounded-lg p-2.5 text-white font-mono transition-colors"
                                >
                                    <option value="standard">Standard (Basic)</option>
                                    <option value="pop">Bouncy Pop (CapCut)</option>
                                    <option value="karaoke">Karaoke Highlight</option>
                                    <option value="neon">Neon Glow</option>
                                </select>
                            </div>
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm text-white/60 font-medium">
                                    <span>Size</span>
                                    <span>{previewSize}px</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="12" max="72" step="2"
                                    value={previewSize}
                                    onChange={(e) => setPreviewSize(Number(e.target.value))}
                                    className="w-full accent-indigo-500 cursor-pointer h-2 bg-white/10 rounded-lg appearance-none"
                                />
                            </div>
                            <div className="space-y-2">
                                <div className="flex justify-between text-sm text-white/60 font-medium">
                                    <span>Position (Y)</span>
                                    <span>{previewPosition}%</span>
                                </div>
                                <input 
                                    type="range" 
                                    min="0" max="90" step="1"
                                    value={previewPosition}
                                    onChange={(e) => setPreviewPosition(Number(e.target.value))}
                                    className="w-full accent-indigo-500 cursor-pointer h-2 bg-white/10 rounded-lg appearance-none"
                                />
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Clear All Confirmation Modal */}
            {showClearConfirm && (
                <div 
                    className="fixed inset-0 z-[110] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
                    onClick={() => setShowClearConfirm(false)}
                >
                    <div 
                        className="w-full max-w-sm bg-zinc-900 border border-red-500/30 rounded-2xl shadow-2xl p-6 flex flex-col gap-4 text-center relative overflow-hidden"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="absolute top-0 left-0 w-full h-1 bg-red-500"></div>
                        <div className="mx-auto w-12 h-12 bg-red-500/10 text-red-400 rounded-full flex items-center justify-center mb-2">
                            <Trash2 className="w-6 h-6" />
                        </div>
                        <h3 className="text-lg font-bold text-white">Clear All Subtitles?</h3>
                        <p className="text-sm text-white/60 leading-relaxed mb-4">
                            This action will remove all subtitle blocks from the timeline. You can undo this action later.
                        </p>
                        <div className="flex gap-3 mt-2">
                            <button 
                                onClick={() => setShowClearConfirm(false)}
                                className="flex-1 py-3 bg-white/5 hover:bg-white/10 text-white font-semibold rounded-xl transition-colors"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={() => {
                                    setBlocksAndNotify([]);
                                    setSelectedId(null);
                                    setMoveModeId(null);
                                    setShowClearConfirm(false);
                                }}
                                className="flex-1 py-3 bg-red-500 hover:bg-red-600 text-white font-semibold rounded-xl shadow-[0_0_15px_rgba(239,68,68,0.3)] transition-colors"
                            >
                                Clear All
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit Subtitle Text Modal - Positioned safely at the top on mobile so the virtual keyboard never hides or pushes it away */}
            {selectedBlock && isEditingText && (
                <div 
                    className="fixed inset-0 z-[100] flex items-start sm:items-center justify-center bg-black/80 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto"
                    onClick={() => setIsEditingText(false)}
                >
                    <div 
                        className="bg-[#1c1c1e] border border-white/20 rounded-2xl shadow-2xl w-full max-w-md p-4 sm:p-5 flex flex-col gap-3.5 mt-2 sm:mt-0 animate-in fade-in zoom-in-95 duration-150"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between border-b border-white/10 pb-3">
                            <div className="flex items-center gap-2">
                                <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                                    <Type className="w-4 h-4" />
                                </div>
                                <div>
                                    <h4 className="text-sm font-bold text-white leading-tight">Edit Subtitle Text</h4>
                                    <div className="flex items-center gap-1.5 text-[10px] font-mono text-white/50 mt-0.5">
                                        <span>{formatTimeWithMs(selectedBlock.start)}</span>
                                        <span>→</span>
                                        <span>{formatTimeWithMs(selectedBlock.end)}</span>
                                        <span className="text-indigo-400 font-semibold">({((selectedBlock.end - selectedBlock.start) / 1000).toFixed(2)}s)</span>
                                    </div>
                                </div>
                            </div>
                            <button 
                                onClick={() => setIsEditingText(false)} 
                                className="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
                                title="Close"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

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
                                            ? 'bg-indigo-600 text-white shadow' 
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
                                            ? 'bg-indigo-600 text-white shadow' 
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
                                        <div className="flex flex-col gap-1 bg-black/50 p-2.5 rounded-xl border border-white/10 focus-within:border-indigo-500/50 transition-colors">
                                            <div className="flex items-center justify-between">
                                                <label className="text-[10px] font-bold text-indigo-400 uppercase tracking-wide flex items-center gap-1.5">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>
                                                    Line 1 • Original (Native)
                                                </label>
                                                <button
                                                    type="button"
                                                    disabled={!line1.trim() || quickTranslatingLine !== null}
                                                    onClick={() => handleQuickTranslate('l1')}
                                                    className="flex items-center gap-1 px-2 py-0.5 bg-indigo-600/20 hover:bg-indigo-600/40 text-indigo-300 hover:text-white rounded-md text-[10px] font-bold border border-indigo-500/30 transition-all disabled:opacity-40 cursor-pointer"
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
                                                    className="text-indigo-300 hover:text-indigo-200 flex items-center gap-1 font-mono hover:underline cursor-pointer"
                                                >
                                                    <Play className="w-2.5 h-2.5 fill-current" /> Play
                                                </button>
                                            </div>
                                            {selectedBlock.text && (
                                                <button 
                                                    type="button" 
                                                    onClick={() => updateSelectedText("")}
                                                    className="text-white/40 hover:text-red-400 transition-colors cursor-pointer"
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
                                    className="w-full bg-black/60 text-sm sm:text-base text-white font-medium outline-none placeholder-white/30 p-3 sm:p-3.5 rounded-xl resize-none h-28 sm:h-32 custom-scrollbar border border-white/15 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-all leading-relaxed"
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
                                            className="text-indigo-300 hover:text-indigo-200 flex items-center gap-1 font-mono hover:underline cursor-pointer"
                                        >
                                            <Play className="w-2.5 h-2.5 fill-current" /> Play
                                        </button>
                                    </div>
                                    {selectedBlock.text && (
                                        <button 
                                            type="button" 
                                            onClick={() => updateSelectedText("")}
                                            className="text-white/40 hover:text-red-400 transition-colors cursor-pointer"
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
                                    disabled={isVisionFixing || isAudioFixing || !!isSyncingTranslation || isUploadingVideo}
                                    className="py-2 px-2 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-fuchsia-300 hover:text-white border border-fuchsia-500/30 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm cursor-pointer"
                                    title="Capture screen frame or video player, detect on-screen text, and translate into subtitles"
                                >
                                    <Camera className="w-3.5 h-3.5 text-fuchsia-400 shrink-0" />
                                    <span className="truncate">Vision</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={() => handleVisionFix('frame')}
                                    disabled={!selectedBlock.text || isVisionFixing || isAudioFixing || !!isSyncingTranslation || isUploadingVideo}
                                    className="py-2 px-2 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 hover:text-white border border-indigo-500/30 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm cursor-pointer"
                                    title="Capture video frame at timestamp and analyze on-screen text to fix dialogue"
                                >
                                    {isVisionFixing && !isUploadingVideo ? (
                                        <div className="w-3.5 h-3.5 border-2 border-indigo-400/30 border-t-indigo-400 rounded-full animate-spin shrink-0" />
                                    ) : (
                                        <Scan className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                                    )}
                                    <span className="truncate">Vision Fix</span>
                                </button>

                                <button
                                    type="button"
                                    onClick={handleHearFix}
                                    disabled={!selectedBlock.text || isVisionFixing || isAudioFixing || !!isSyncingTranslation || isUploadingVideo}
                                    className="py-2 px-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 hover:text-white border border-emerald-500/30 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shadow-sm cursor-pointer"
                                    title="Listen to audio at this timestamp with Agentic Audio to correct misheard words"
                                >
                                    {isAudioFixing || isUploadingVideo ? (
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
                                                <Languages className="w-3 h-3 text-indigo-400 shrink-0" />
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
                                                <Languages className="w-3 h-3 text-indigo-400 shrink-0" />
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
                                            <Languages className="w-3 h-3 text-indigo-400 shrink-0" />
                                        )}
                                        <span>Sync Translation</span>
                                    </button>
                                )
                            )}

                            {/* Done Button */}
                            <button 
                                type="button" 
                                onClick={() => setIsEditingText(false)}
                                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 active:scale-98 text-white rounded-xl text-xs sm:text-sm font-bold shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-1.5 transition-all mt-1 cursor-pointer"
                            >
                                <Check className="w-4 h-4" />
                                <span>Done</span>
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {showFrameTranslate && selectedBlock && (
                <FrameTranslateModal
                    isOpen={showFrameTranslate}
                    onClose={() => setShowFrameTranslate(false)}
                    currentText={selectedBlock.text}
                    onApplyText={updateSelectedText}
                    apiKey={apiKey}
                    videoElement={visualVideoRef.current || (mediaRef.current instanceof HTMLVideoElement ? mediaRef.current : (mediaRef.current && (mediaRef.current as any).videoWidth ? (mediaRef.current as HTMLVideoElement) : null))}
                    currentTimeFormatted={`${formatTimeWithMs(selectedBlock.start)} → ${formatTimeWithMs(selectedBlock.end)}`}
                />
            )}
            {showTextTools && (
                <BulkTextToolsModal
                    apiKey={apiKey}
                    blocks={blocksState}
                    onApply={setBlocksAndNotify}
                    onClose={() => setShowTextTools(false)}
                />
            )}
            
            {showExportModal && (
                <ExportModal 
                    defaultName="edited_subtitles.srt"
                    onExport={executeExport}
                    onClose={() => setShowExportModal(false)}
                />
            )}

            {showYoutubeInputModal && (
                <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
                    <div className="bg-[#181818] border border-white/10 rounded-2xl w-full max-w-md p-5 space-y-4 shadow-2xl animate-in fade-in zoom-in-95">
                        <div className="flex items-center justify-between border-b border-white/10 pb-3">
                            <div className="flex items-center gap-2">
                                <div className="p-1.5 bg-red-500/20 text-red-400 rounded-lg">
                                    <Youtube className="w-5 h-5" />
                                </div>
                                <h3 className="text-sm font-bold text-white">Load YouTube Video</h3>
                            </div>
                            <button
                                onClick={() => setShowYoutubeInputModal(false)}
                                className="p-1 text-white/40 hover:text-white rounded-lg hover:bg-white/5 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="space-y-2">
                            <label className="text-xs font-medium text-white/70">YouTube Video URL</label>
                            <input
                                type="text"
                                value={youtubeInputVal}
                                onChange={(e) => setYoutubeInputVal(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && youtubeInputVal.trim()) {
                                        handleApplyYoutubeUrl(youtubeInputVal);
                                    }
                                }}
                                placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
                                className="w-full bg-black/60 border border-white/10 text-white rounded-xl px-3 py-2.5 text-xs outline-none focus:border-red-500 placeholder:text-white/30 transition-colors"
                                autoFocus
                            />
                            <p className="text-[11px] text-white/40">
                                Enter any public YouTube video URL to synchronize playback, timeline navigation, and AI frame/hearing context directly in the Timeline Editor.
                            </p>
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-2">
                            {effectiveYoutubeUrl && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setLocalYoutubeUrl(null);
                                        setYoutubeInputVal('');
                                        if (onYoutubeUrlChange) onYoutubeUrlChange('');
                                        setShowYoutubeInputModal(false);
                                    }}
                                    className="px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-500/10 rounded-xl transition-colors"
                                >
                                    Remove
                                </button>
                            )}
                            <div className="flex items-center gap-2 ml-auto">
                                <button
                                    type="button"
                                    onClick={() => setShowYoutubeInputModal(false)}
                                    className="px-4 py-2 text-xs font-medium text-white/60 hover:text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => handleApplyYoutubeUrl(youtubeInputVal)}
                                    disabled={!youtubeInputVal.trim()}
                                    className="px-4 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-all shadow-md shadow-red-600/30"
                                >
                                    Load Video
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
