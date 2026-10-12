import React, { useState, useRef, useEffect } from 'react';
import { 
    Camera, 
    Monitor, 
    Upload, 
    X, 
    Sparkles, 
    Check, 
    Languages, 
    RefreshCw, 
    AlertCircle, 
    Image as ImageIcon,
    Clipboard,
    ChevronDown,
    SlidersHorizontal,
    FileText
} from 'lucide-react';
import { 
    captureScreenFrame, 
    captureVideoElementFrame, 
    readImageFileAsBase64, 
    isDisplayMediaSupported 
} from '../utils/frameCapture';
import { 
    translateSubtitleFromFrame, 
    FrameTranslationResult 
} from '../services/gemini';

interface FrameTranslateModalProps {
    isOpen: boolean;
    onClose: () => void;
    currentText: string;
    onApplyText: (newText: string) => void;
    apiKey?: string;
    videoElement?: HTMLVideoElement | null;
    currentTimeFormatted?: string;
}

const SUPPORTED_LANGUAGES = [
    { code: 'English', label: 'English' },
    { code: 'Korean', label: 'Korean (한국어)' },
    { code: 'Japanese', label: 'Japanese (日本語)' },
    { code: 'Chinese (Simplified)', label: 'Chinese (简体中文)' },
    { code: 'Chinese (Traditional)', label: 'Chinese (繁體中文)' },
    { code: 'Indonesian', label: 'Indonesian (Bahasa Indonesia)' },
    { code: 'Spanish', label: 'Spanish (Español)' },
    { code: 'French', label: 'French (Français)' },
    { code: 'German', label: 'German (Deutsch)' },
    { code: 'Vietnamese', label: 'Vietnamese (Tiếng Việt)' },
    { code: 'Thai', label: 'Thai (ไทย)' },
];

const SUBTITLE_FORMATS = [
    { id: 'standard', label: 'Standard (Single Line)' },
    { id: 'bilingual', label: 'Bilingual (Native + Target)' },
    { id: 'dual_trans', label: 'Dual Trans (English + Target)' },
    { id: 'triple', label: 'Triple (Native + Romanized + Target)' },
    { id: 'quad', label: 'Quad (Native + Roman + English + Target)' },
];

export const FrameTranslateModal: React.FC<FrameTranslateModalProps> = ({
    isOpen,
    onClose,
    currentText,
    onApplyText,
    apiKey,
    videoElement,
    currentTimeFormatted
}) => {
    const [frameBase64, setFrameBase64] = useState<string | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [targetLang, setTargetLang] = useState<string>(() => {
        try {
            return localStorage.getItem('ai_sub_tgt_lang') || 'English';
        } catch {
            return 'English';
        }
    });
    const [subtitleFormat, setSubtitleFormat] = useState<string>(() => {
        try {
            return localStorage.getItem('ai_sub_type') || 'standard';
        } catch {
            return 'standard';
        }
    });

    const [isCapturing, setIsCapturing] = useState(false);
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [analysisStep, setAnalysisStep] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<FrameTranslationResult | null>(null);
    const [editedOutput, setEditedOutput] = useState<string>('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Sync localStorage when options change
    const handleTargetLangChange = (lang: string) => {
        setTargetLang(lang);
        try {
            localStorage.setItem('ai_sub_tgt_lang', lang);
        } catch {}
    };

    const handleFormatChange = (fmt: string) => {
        setSubtitleFormat(fmt);
        try {
            localStorage.setItem('ai_sub_type', fmt);
        } catch {}
    };

    // Auto-capture from video element if available on open
    useEffect(() => {
        if (isOpen && videoElement && !frameBase64) {
            const captured = captureVideoElementFrame(videoElement);
            if (captured) {
                setFrameBase64(captured);
                setPreviewUrl(`data:image/jpeg;base64,${captured}`);
            }
        }
    }, [isOpen, videoElement]);

    // Global paste handler to paste screenshots directly
    useEffect(() => {
        if (!isOpen) return;

        const handlePaste = async (e: ClipboardEvent) => {
            const items = e.clipboardData?.items;
            if (!items) return;

            for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                    const file = items[i].getAsFile();
                    if (file) {
                        try {
                            const b64 = await readImageFileAsBase64(file);
                            setFrameBase64(b64);
                            setPreviewUrl(`data:image/jpeg;base64,${b64}`);
                            setError(null);
                            setResult(null);
                        } catch (err: any) {
                            setError(err.message || 'Failed to read pasted image');
                        }
                    }
                    break;
                }
            }
        };

        window.addEventListener('paste', handlePaste);
        return () => window.removeEventListener('paste', handlePaste);
    }, [isOpen]);

    if (!isOpen) return null;

    const handleCaptureScreen = async () => {
        setError(null);
        setIsCapturing(true);
        try {
            const b64 = await captureScreenFrame();
            setFrameBase64(b64);
            setPreviewUrl(`data:image/jpeg;base64,${b64}`);
            setResult(null);
        } catch (err: any) {
            if (err.name === 'NotAllowedError') {
                setError('Screen capture was cancelled or denied. You can paste or upload a screenshot instead.');
            } else {
                setError(err.message || 'Failed to capture screen.');
            }
        } finally {
            setIsCapturing(false);
        }
    };

    const handleCaptureVideoPlayer = () => {
        if (!videoElement) {
            setError('No active video player element detected.');
            return;
        }
        setError(null);
        const b64 = captureVideoElementFrame(videoElement);
        if (b64) {
            setFrameBase64(b64);
            setPreviewUrl(`data:image/jpeg;base64,${b64}`);
            setResult(null);
        } else {
            setError('Could not grab frame from video element.');
        }
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setError(null);
        try {
            const b64 = await readImageFileAsBase64(file);
            setFrameBase64(b64);
            setPreviewUrl(`data:image/jpeg;base64,${b64}`);
            setResult(null);
        } catch (err: any) {
            setError(err.message || 'Failed to read image file.');
        } finally {
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    };

    const handleAnalyzeAndTranslate = async () => {
        if (!frameBase64) {
            setError('Please capture or upload a frame first.');
            return;
        }

        setError(null);
        setIsAnalyzing(true);
        setAnalysisStep('Scanning frame for text and burned-in subtitles...');

        try {
            setAnalysisStep(`Translating detected text to ${targetLang}...`);
            const translation = await translateSubtitleFromFrame(frameBase64, currentText, {
                targetLanguage: targetLang,
                subtitleFormat: subtitleFormat,
                apiKey: apiKey
            });

            setResult(translation);
            setEditedOutput(translation.formattedSubtitle);
            setAnalysisStep('');
        } catch (err: any) {
            console.error('Frame translation failed:', err);
            setError(err.message || 'AI Vision analysis failed. Check your API key or network.');
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleApply = () => {
        const textToApply = editedOutput.trim() || result?.formattedSubtitle || '';
        if (textToApply) {
            onApplyText(textToApply);
            onClose();
        }
    };

    const handleAppend = () => {
        const textToAppend = editedOutput.trim() || result?.formattedSubtitle || '';
        if (textToAppend) {
            const combined = currentText ? `${currentText}\n${textToAppend}` : textToAppend;
            onApplyText(combined);
            onClose();
        }
    };

    return (
        <div 
            className="fixed inset-0 z-[150] flex items-end sm:items-center justify-center bg-black/85 backdrop-blur-md p-0 sm:p-4 animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div 
                className="bg-[#141416] border-t sm:border border-white/15 rounded-t-3xl sm:rounded-3xl shadow-2xl w-full max-w-lg max-h-[92dvh] sm:max-h-[88dvh] flex flex-col overflow-hidden text-white"
                onClick={e => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10 shrink-0 bg-white/[0.02]">
                    <div className="flex items-center gap-2.5">
                        <div className="p-2 rounded-xl bg-gradient-to-tr from-fuchsia-600/30 to-indigo-600/30 border border-fuchsia-500/30 text-fuchsia-400">
                            <Camera className="w-4 h-4" />
                        </div>
                        <div>
                            <h3 className="text-sm font-bold tracking-wide flex items-center gap-2 text-white">
                                <span>Vision & Translate</span>
                                {currentTimeFormatted && (
                                    <span className="text-[11px] font-mono font-medium px-2 py-0.5 rounded-full bg-white/10 text-white/70">
                                        {currentTimeFormatted}
                                    </span>
                                )}
                            </h3>
                            <p className="text-[11px] text-white/50">Capture screen/player frame, detect text, and auto-translate</p>
                        </div>
                    </div>
                    <button 
                        type="button"
                        onClick={onClose} 
                        className="p-2 text-white/50 hover:text-white rounded-full hover:bg-white/10 transition-colors"
                        aria-label="Close"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Scrollable Body */}
                <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
                    {/* Error Notice */}
                    {error && (
                        <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-2xl flex items-start gap-2.5 text-xs text-red-300">
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                            <div className="flex-1 leading-relaxed">{error}</div>
                        </div>
                    )}

                    {/* Frame Capture Section */}
                    <div>
                        <div className="flex items-center justify-between mb-2">
                            <label className="text-xs font-semibold text-white/80 uppercase tracking-wider flex items-center gap-1.5">
                                <ImageIcon className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Captured Frame</span>
                            </label>
                            {frameBase64 && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setFrameBase64(null);
                                        setPreviewUrl(null);
                                        setResult(null);
                                    }}
                                    className="text-[11px] text-red-400 hover:text-red-300 transition-colors"
                                >
                                    Clear frame
                                </button>
                            )}
                        </div>

                        {previewUrl ? (
                            <div className="relative group rounded-2xl overflow-hidden border border-white/15 bg-black/60 aspect-video flex items-center justify-center">
                                <img 
                                    src={previewUrl} 
                                    alt="Captured video frame" 
                                    className="w-full h-full object-contain"
                                />
                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2 p-3">
                                    <button
                                        type="button"
                                        onClick={handleCaptureScreen}
                                        disabled={isCapturing}
                                        className="px-3 py-1.5 bg-black/80 hover:bg-black text-white text-xs font-medium rounded-xl border border-white/20 backdrop-blur-sm shadow flex items-center gap-1.5"
                                    >
                                        <Monitor className="w-3.5 h-3.5 text-indigo-400" />
                                        Recapture Screen
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="border border-dashed border-white/20 rounded-2xl p-4 sm:p-5 bg-white/[0.02] flex flex-col items-center justify-center gap-3 text-center">
                                <div className="p-3 rounded-2xl bg-white/5 border border-white/10 text-white/60">
                                    <Camera className="w-6 h-6 text-fuchsia-400" />
                                </div>
                                <div>
                                    <p className="text-xs font-semibold text-white">No Frame Captured Yet</p>
                                    <p className="text-[11px] text-white/50 mt-0.5 max-w-xs">
                                        Capture from your screen/browser window, grab from the player, or paste a screenshot directly (Ctrl+V).
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full pt-1">
                                    {isDisplayMediaSupported() && (
                                        <button
                                            type="button"
                                            onClick={handleCaptureScreen}
                                            disabled={isCapturing}
                                            className="min-h-[44px] px-3 py-2 bg-gradient-to-r from-indigo-600 to-fuchsia-600 hover:from-indigo-500 hover:to-fuchsia-500 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 active:scale-98 transition-all disabled:opacity-50"
                                        >
                                            <Monitor className="w-4 h-4" />
                                            <span>Capture Screen / Tab</span>
                                        </button>
                                    )}

                                    {videoElement && (
                                        <button
                                            type="button"
                                            onClick={handleCaptureVideoPlayer}
                                            className="min-h-[44px] px-3 py-2 bg-white/10 hover:bg-white/15 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-2 border border-white/10 active:scale-98 transition-all"
                                        >
                                            <Camera className="w-4 h-4 text-emerald-400" />
                                            <span>From Video Player</span>
                                        </button>
                                    )}

                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="min-h-[44px] px-3 py-2 bg-white/5 hover:bg-white/10 text-white/90 text-xs font-medium rounded-xl flex items-center justify-center gap-2 border border-white/10 active:scale-98 transition-all sm:col-span-2"
                                    >
                                        <Upload className="w-4 h-4 text-amber-400" />
                                        <span>Upload or Paste Screenshot</span>
                                    </button>
                                </div>
                            </div>
                        )}

                        <input 
                            ref={fileInputRef} 
                            type="file" 
                            accept="image/*" 
                            className="hidden" 
                            onChange={handleFileUpload} 
                        />
                    </div>

                    {/* Quick Recapture Bar if frame exists */}
                    {previewUrl && (
                        <div className="flex flex-wrap items-center gap-2">
                            {isDisplayMediaSupported() && (
                                <button
                                    type="button"
                                    onClick={handleCaptureScreen}
                                    disabled={isCapturing || isAnalyzing}
                                    className="px-3 py-1.5 bg-white/10 hover:bg-white/15 text-white text-[11px] font-semibold rounded-xl flex items-center gap-1.5 border border-white/10 transition-colors"
                                >
                                    <Monitor className="w-3.5 h-3.5 text-indigo-400" />
                                    <span>Capture Screen</span>
                                </button>
                            )}
                            {videoElement && (
                                <button
                                    type="button"
                                    onClick={handleCaptureVideoPlayer}
                                    disabled={isAnalyzing}
                                    className="px-3 py-1.5 bg-white/10 hover:bg-white/15 text-white text-[11px] font-semibold rounded-xl flex items-center gap-1.5 border border-white/10 transition-colors"
                                >
                                    <Camera className="w-3.5 h-3.5 text-emerald-400" />
                                    <span>Grab Player Frame</span>
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={isAnalyzing}
                                className="px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/80 text-[11px] font-medium rounded-xl flex items-center gap-1.5 border border-white/10 transition-colors"
                            >
                                <Upload className="w-3.5 h-3.5 text-amber-400" />
                                <span>Upload Frame</span>
                            </button>
                        </div>
                    )}

                    {/* Language and Format Controls */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-white/[0.02] p-3.5 rounded-2xl border border-white/10">
                        <div>
                            <label className="text-[11px] font-semibold text-white/70 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                                <Languages className="w-3.5 h-3.5 text-indigo-400" />
                                <span>Target Language</span>
                            </label>
                            <div className="relative">
                                <select
                                    value={targetLang}
                                    onChange={e => handleTargetLangChange(e.target.value)}
                                    className="w-full min-h-[42px] bg-black/50 border border-white/15 rounded-xl px-3 pr-8 text-xs text-white appearance-none outline-none focus:border-indigo-500 font-medium cursor-pointer"
                                >
                                    {SUPPORTED_LANGUAGES.map(lang => (
                                        <option key={lang.code} value={lang.code} className="bg-[#1a1a1a] text-white">
                                            {lang.label}
                                        </option>
                                    ))}
                                </select>
                                <ChevronDown className="w-4 h-4 text-white/40 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                        </div>

                        <div>
                            <label className="text-[11px] font-semibold text-white/70 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                                <SlidersHorizontal className="w-3.5 h-3.5 text-fuchsia-400" />
                                <span>Subtitle Layout</span>
                            </label>
                            <div className="relative">
                                <select
                                    value={subtitleFormat}
                                    onChange={e => handleFormatChange(e.target.value)}
                                    className="w-full min-h-[42px] bg-black/50 border border-white/15 rounded-xl px-3 pr-8 text-xs text-white appearance-none outline-none focus:border-fuchsia-500 font-medium cursor-pointer"
                                >
                                    {SUBTITLE_FORMATS.map(fmt => (
                                        <option key={fmt.id} value={fmt.id} className="bg-[#1a1a1a] text-white">
                                            {fmt.label}
                                        </option>
                                    ))}
                                </select>
                                <ChevronDown className="w-4 h-4 text-white/40 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                        </div>
                    </div>

                    {/* Analyze Action Button */}
                    <button
                        type="button"
                        onClick={handleAnalyzeAndTranslate}
                        disabled={!frameBase64 || isAnalyzing}
                        className="w-full min-h-[46px] py-3 px-4 bg-gradient-to-r from-fuchsia-600 via-indigo-600 to-purple-600 hover:from-fuchsia-500 hover:via-indigo-500 hover:to-purple-500 active:scale-98 text-white rounded-2xl text-xs sm:text-sm font-bold shadow-lg shadow-indigo-600/30 flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isAnalyzing ? (
                            <>
                                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                <span>{analysisStep || 'Analyzing Frame & Translating...'}</span>
                            </>
                        ) : (
                            <>
                                <Sparkles className="w-4 h-4 text-amber-300" />
                                <span>Analyze On-Screen Text & Translate</span>
                            </>
                        )}
                    </button>

                    {/* Results Card */}
                    {result && (
                        <div className="space-y-3 p-4 bg-white/[0.03] border border-white/15 rounded-2xl animate-in fade-in slide-in-from-bottom-2 duration-200">
                            {/* Detected OCR Source Text */}
                            {result.detectedOriginalText && (
                                <div className="p-3 bg-black/40 rounded-xl border border-white/10 space-y-1">
                                    <div className="flex items-center justify-between text-[11px] text-white/60">
                                        <span className="font-semibold uppercase tracking-wider text-emerald-400">
                                            Detected Text ({result.detectedLanguage || 'Original'})
                                        </span>
                                    </div>
                                    <p className="text-xs text-white/90 font-mono whitespace-pre-wrap select-all">
                                        {result.detectedOriginalText}
                                    </p>
                                </div>
                            )}

                            {/* Translated Output (Editable) */}
                            <div>
                                <label className="text-[11px] font-semibold text-white/80 uppercase tracking-wider mb-1.5 flex items-center justify-between">
                                    <span className="flex items-center gap-1.5 text-indigo-300">
                                        <FileText className="w-3.5 h-3.5" />
                                        Translated Subtitle Preview
                                    </span>
                                    <span className="text-[10px] text-white/40 lowercase">editable</span>
                                </label>
                                <textarea
                                    value={editedOutput}
                                    onChange={e => setEditedOutput(e.target.value)}
                                    rows={3}
                                    className="w-full bg-black/60 border border-white/15 focus:border-indigo-500 rounded-xl p-3 text-xs sm:text-sm text-white font-sans outline-none resize-none transition-colors"
                                    placeholder="Translated subtitle text will appear here..."
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer Actions */}
                <div className="p-4 border-t border-white/10 shrink-0 bg-[#141416] flex items-center justify-end gap-2.5">
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-h-[44px] px-4 py-2.5 bg-white/5 hover:bg-white/10 text-white/70 hover:text-white rounded-xl text-xs font-semibold transition-colors"
                    >
                        Cancel
                    </button>

                    {result && (
                        <button
                            type="button"
                            onClick={handleAppend}
                            className="min-h-[44px] px-3.5 py-2.5 bg-white/10 hover:bg-white/15 text-white rounded-xl text-xs font-semibold border border-white/15 transition-colors"
                            title="Add translated text to the current subtitle text on a new line"
                        >
                            Append
                        </button>
                    )}

                    <button
                        type="button"
                        onClick={handleApply}
                        disabled={!result && !editedOutput}
                        className="min-h-[44px] px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 active:scale-98 text-white rounded-xl text-xs font-bold shadow-lg shadow-indigo-600/30 flex items-center gap-1.5 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        <Check className="w-4 h-4" />
                        <span>Apply to Subtitle</span>
                    </button>
                </div>
            </div>
        </div>
    );
};
