import { GoogleGenAI } from "@google/genai";
import { getCurrentTextModel, callTextModel, withRetry, getGenAI, getEffectiveGeminiApiKey, isRealGeminiKey, getLiveMultimodalCandidateModels, recordGeminiModelNotFound } from "./gemini";
import { normalizeYoutubeUrl, extractYouTubeMediaDetails, fetchNativeYouTubeSubtitlesContent, fetchYouTubeCaptions, downloadYouTubeMediaStream } from "./youtube";
import { parseSubtitles, generateSrt, SubtitleBlock, splitOversizedBlocks } from "../utils/subtitleParser";
import { segmentsToSrt } from "./youtubeCaptionService";

let lastWorkingTranscriptionModel: string | null = null;
const notFoundTranscriptionModels = new Set<string>();
let lastTranscriptionKeyFingerprint = '';

function apiKeyFingerprint(key: string): string {
    return key.length > 10 ? `${key.slice(0, 5)}_${key.slice(-4)}` : 'default';
}

/** Convert chunk-relative timecodes to canonical media-timeline cue objects. */
export function shiftSubtitleBlocks(
    blocks: ParsedRawBlock[],
    offsetMs: number,
    chunkDurationMs?: number
): ParsedRawBlock[] {
    return blocks
        .filter(block => block.startMs >= 0 && block.startMs <= (chunkDurationMs == null ? Number.MAX_SAFE_INTEGER : chunkDurationMs + 20000))
        .map(block => {
            const startMs = Math.max(0, block.startMs + offsetMs);
            const endMs = Math.max(startMs + 400, block.endMs + offsetMs);
            return {
                startMs,
                endMs,
                startTs: msToTime(startMs),
                endTs: msToTime(endMs),
                textLines: [...block.textLines]
            };
        });
}

/**
 * Call Gemini generation with live model discovery (`v1beta/models`) and auto-fallback for audio & video transcription.
 * Dynamically queries the exact list of real models available on the user's API key via `getLiveMultimodalCandidateModels`,
 * clamps maxOutputTokens to <= 8192 to prevent Gemini backend 500 INTERNAL errors on multimodal inputs,
 * caches the last working model, and blacklists any 404 model so it is never retried.
 */
export async function callAudioTranscriptionModel(
    genAI: GoogleGenAI,
    request: any
): Promise<any> {
    const requestParts = Array.isArray(request?.contents?.parts) ? request.contents.parts : [];
    const videoMimeTypes = [...new Set(requestParts
        .map((part: any) => part?.inlineData?.mimeType || part?.fileData?.mimeType || '')
        .filter((mime: string) => typeof mime === 'string' && mime.toLowerCase().startsWith('video/')))];
    const hasImageParts = requestParts.some((part: any) => {
        const mime = part?.inlineData?.mimeType || part?.fileData?.mimeType || '';
        return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
    });
    const containsVisualInput = videoMimeTypes.length > 0 || hasImageParts;

    // Use the explicit request key where available so discovery and generation don't
    // accidentally use different saved/default credentials.
    const clientKey = typeof (genAI as any)?.apiKey === 'string' ? (genAI as any).apiKey : '';
    const activeKey = getEffectiveGeminiApiKey(clientKey);
    const keyFingerprint = apiKeyFingerprint(activeKey);
    if (keyFingerprint !== lastTranscriptionKeyFingerprint) {
        lastTranscriptionKeyFingerprint = keyFingerprint;
        lastWorkingTranscriptionModel = null;
        notFoundTranscriptionModels.clear();
    }

    // Google's live catalogue is authoritative for this key. Never rewrite its model IDs.
    const livePool = await getLiveMultimodalCandidateModels(activeKey, containsVisualInput);
    const verifiedPool = livePool
        .map(m => m.replace(/^models\//, '').trim())
        .filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx && !notFoundTranscriptionModels.has(m));
    const requestModel = typeof request?.model === 'string'
        ? request.model.replace(/^models\//, '').trim()
        : '';
    const staticFallbackPool = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-flash-latest']
        .filter(m => !notFoundTranscriptionModels.has(m));
    const modelPool = verifiedPool.length > 0
        ? verifiedPool
        : [requestModel, getCurrentTextModel(), ...staticFallbackPool]
            .map(m => String(m || '').replace(/^models\//, '').trim())
            .filter((m, idx, arr) => Boolean(m) && arr.indexOf(m) === idx && !notFoundTranscriptionModels.has(m));

    let preferredModel = lastWorkingTranscriptionModel && modelPool.includes(lastWorkingTranscriptionModel)
        ? lastWorkingTranscriptionModel
        : (modelPool.includes(requestModel) ? requestModel : modelPool[0]);

    if (containsVisualInput && preferredModel.includes('transcribe')) {
        preferredModel = modelPool.find(m => !m.includes('transcribe')) || modelPool[0];
    }

    const modelsToTry = [
        ...(notFoundTranscriptionModels.has(preferredModel) ? [] : [preferredModel]),
        ...modelPool.filter(m => m !== preferredModel)
    ];

    // Clamp maxOutputTokens to 8192 to prevent Gemini backend 500 INTERNAL crashes when combined with heavy media tokens
    const safeConfig = request?.config ? { ...request.config } : {};
    if (typeof safeConfig.maxOutputTokens === 'number' && safeConfig.maxOutputTokens > 8192) {
        safeConfig.maxOutputTokens = 8192;
    }

    let lastError: any = null;
    let lastVideoArgumentError: any = null;

    if (modelsToTry.length === 0) {
        throw new Error('No usable Gemini transcription model is available for this API key. Verify the key and enable the Generative Language API, then use Captions → Detect Live Models.');
    }

    for (const model of modelsToTry) {
        try {
            const req = { ...request, config: safeConfig, model };
            try {
                const res = await withRetry(() => genAI.models.generateContent(req), 2, 2000);
                lastWorkingTranscriptionModel = model;
                console.info(`[SRT Generator] Successful transcription request model: ${model}`);
                return res;
            } catch (primaryErr: any) {
                const pMsg = (primaryErr?.message || '') + JSON.stringify(primaryErr || '');
                if (pMsg.includes('Failed to call the Gemini API') || pMsg.includes('502') || pMsg.includes('404') || pMsg.includes('Failed to fetch') || pMsg.includes('Direct Gemini proxy')) {
                    const proxyAI = getGenAI(activeKey, true);
                    const res = await proxyAI.models.generateContent(req);
                    lastWorkingTranscriptionModel = model;
                    console.info(`[SRT Generator] Successful transcription request model (proxy): ${model}`);
                    return res;
                }
                if (pMsg.includes('Quota') || pMsg.includes('429') || pMsg.includes('RESOURCE_EXHAUSTED')) throw primaryErr;
                throw primaryErr;
            }
        } catch (err: any) {
            lastError = err;
            const msg = (err?.message || '') + JSON.stringify(err || '');
            const is403 = err?.status === 403 || msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('does not have permission');
            const is404 = err?.status === 404 || msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('is not found');
            const is500 = err?.status === 500 || msg.includes('INTERNAL') || msg.includes('"code":500') || msg.includes('Internal error encountered') || err?.status === 503 || msg.includes('503');
            const isVideoInvalidArgument = videoMimeTypes.length > 0 &&
                (err?.status === 400 || msg.includes('INVALID_ARGUMENT') || msg.includes('Request contains an invalid argument'));
            const isQuotaOrRateLimit = err?.status === 429 || msg.includes('429') || msg.includes('Quota') || msg.includes('RESOURCE_EXHAUSTED');
            if (isQuotaOrRateLimit) throw err;

            if (is404) {
                notFoundTranscriptionModels.add(model);
                recordGeminiModelNotFound(model);
                if (lastWorkingTranscriptionModel === model) {
                    lastWorkingTranscriptionModel = null;
                }
            }

            // If a 500 INTERNAL error occurred with maxOutputTokens set, retry once on the same model without maxOutputTokens
            if (is500 && safeConfig.maxOutputTokens) {
                try {
                    const { maxOutputTokens: _removed, ...minimalConfig } = safeConfig;
                    const retryReq = { ...request, config: minimalConfig, model };
                    const res = await genAI.models.generateContent(retryReq);
                    lastWorkingTranscriptionModel = model;
                    return res;
                } catch (retryErr: any) {
                    lastError = retryErr;
                }
            }

            if (isVideoInvalidArgument) {
                lastVideoArgumentError = err;
                console.warn(`[SRT Generator] Model "${model}" rejected video input (${videoMimeTypes.join(', ')}; INVALID_ARGUMENT). Trying a compatible fallback model...`);
                continue;
            }

            const isInvalidArgument = err?.status === 400 || msg.includes('"code":400') || msg.includes('INVALID_ARGUMENT') || msg.includes('Request contains an invalid argument');
            const reason = is403 ? '403 Permission Denied' : is404 ? '404 Model Not Found' : is500 ? '500 Internal error encountered' : isInvalidArgument ? '400 INVALID_ARGUMENT' : 'Model error';
            console.warn(`[SRT Generator] Model "${model}" failed with ${reason}. Trying next fallback candidate...`);
            continue;
        }
    }

    if (lastVideoArgumentError) {
        const mimeSummary = videoMimeTypes.join(', ') || 'unknown video MIME type';
        const diagnostic = new Error(
            `Gemini rejected the video input (${mimeSummary}) as INVALID_ARGUMENT after trying the available transcription models. The container or codec may not be supported by Gemini. If possible, try an MP4 encoded with H.264 video and AAC audio, then retry. Original API error: ${lastVideoArgumentError?.message || 'Request contains an invalid argument.'}`
        );
        (diagnostic as any).cause = lastVideoArgumentError;
        throw diagnostic;
    }

    throw lastError || new Error("Permission Denied (403). Your API key does not have permission for the requested model. Please check your Gemini API key in Settings -> API Settings Vault.");
}

// Helper function to parse and fix a timestamp string (e.g. "01:09:50,500" or "01:00,000" or "00:01:23.456")
function fixTimestamp(ts: string): string {
    // Strip any trailing WebVTT cue settings like "align:start position:0%"
    ts = ts.trim().split(/\s+/)[0] || '';

    // Case 0: HH:MM:SS:mmm (colon before 3-digit milliseconds)
    const hhmmssColonMs = ts.match(/^(\d{1,2}):(\d{2}):(\d{2}):(\d{1,3})$/);
    if (hhmmssColonMs) {
        const [_, h, m, s, ms] = hhmmssColonMs;
        return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')},${ms.padEnd(3, '0').slice(0, 3)}`;
    }

    // Case 0b: MM:SS:mmm (where 3rd group is 3-digit milliseconds, e.g. 08:15:250)
    const mmssColonMs = ts.match(/^(\d{1,2}):(\d{2}):(\d{3})$/);
    if (mmssColonMs) {
        const [_, m, s, ms] = mmssColonMs;
        return `00:${m.padStart(2, '0')}:${s.padStart(2, '0')},${ms}`;
    }

    // Case 1: MM:SS,mmm or MM:SS.mmm or M:SS,mmm (missing hour prefix)
    const mmssMatch = ts.match(/^(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (mmssMatch) {
        const [_, m, s, ms] = mmssMatch;
        return `00:${m.padStart(2, '0')}:${s.padStart(2, '0')},${ms.padEnd(3, '0').slice(0, 3)}`;
    }

    // Case 1b: MM:SS without milliseconds (e.g. 08:15)
    const mmssNoMs = ts.match(/^(\d{1,2}):(\d{2})$/);
    if (mmssNoMs) {
        const [_, m, s] = mmssNoMs;
        return `00:${m.padStart(2, '0')}:${s.padStart(2, '0')},000`;
    }

    // Case 2: Standard HH:MM:SS,mmm or H:MM:SS.mmm or HH:MM:SS (no ms)
    const standardMatch = ts.match(/^(\d{1,3}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
    if (standardMatch) {
        const [_, h, m, s, ms] = standardMatch;
        const msFormatted = (ms || '000').padEnd(3, '0').slice(0, 3);
        return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')},${msFormatted}`;
    }

    // Case 3: Dot separated milliseconds fallback
    if (ts.includes('.')) {
        return ts.replace('.', ',');
    }
    
    return ts;
}

// Convert HH:MM:SS,mmm to milliseconds
function timeToMs(ts: string): number {
    const match = ts.match(/(\d+):(\d{2}):(\d{2}),(\d{3})/);
    if (!match) return 0;
    const [_, h, m, s, ms] = match;
    return parseInt(h, 10) * 3600000 + parseInt(m, 10) * 60000 + parseInt(s, 10) * 1000 + parseInt(ms, 10);
}

// Convert milliseconds to HH:MM:SS,mmm
function msToTime(msTotal: number): string {
    const clamped = Math.max(0, Math.round(msTotal));
    const ms = clamped % 1000;
    const totalSec = Math.floor(clamped / 1000);
    const s = totalSec % 60;
    const m = Math.floor(totalSec / 60) % 60;
    const h = Math.floor(totalSec / 3600);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
}

export interface ParsedRawBlock {
    startMs: number;
    endMs: number;
    startTs: string;
    endTs: string;
    textLines: string[];
}

export function parseRawBlocks(rawText: string): ParsedRawBlock[] {
    const lines = rawText.split(/\r?\n/).map(l => l.trim());
    const blocks: string[][] = [];
    let currentBlock: string[] = [];
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === '') {
            if (currentBlock.length > 0) {
                blocks.push(currentBlock);
                currentBlock = [];
            }
        } else {
            currentBlock.push(lines[i]);
        }
    }
    if (currentBlock.length > 0) {
        blocks.push(currentBlock);
    }
    
    const parsedBlocks: ParsedRawBlock[] = [];
    
    for (const block of blocks) {
        // Find the timestamp line
        let tsIndex = -1;
        for (let i = 0; i < block.length; i++) {
            if (block[i].includes('-->')) {
                tsIndex = i;
                break;
            }
        }
        if (tsIndex === -1) continue;
        
        const [startRaw, endRaw] = block[tsIndex].split('-->').map(s => s.trim());
        let startTs = fixTimestamp(startRaw);
        let endTs = fixTimestamp(endRaw);
        
        let startMs = timeToMs(startTs);
        let endMs = timeToMs(endTs);
        
        // If end timestamp is invalid or <= start, set a reasonable duration based on text length
        const textLines = block.slice(tsIndex + 1).filter(l => l.length > 0);
        if (textLines.length === 0) continue; // Skip empty subtitle blocks
        
        if (endMs <= startMs) {
            const wordCount = textLines.join(' ').split(/\s+/).length;
            const estimatedDuration = Math.max(1200, Math.min(6000, wordCount * 350));
            endMs = startMs + estimatedDuration;
            endTs = msToTime(endMs);
        }
        
        parsedBlocks.push({
            startMs,
            endMs,
            startTs,
            endTs,
            textLines
        });
    }
    return parsedBlocks;
}

// Ensure chronological order and valid start/end without destructive cascading shifts
export function reconstructSRT(blocks: ParsedRawBlock[]): string {
    return blocks.map((b, idx) => {
        const cleanedText = b.textLines.map(l => l.replace(/\.$/, '').trim()).join('\n');
        return `${idx + 1}\n${b.startTs} --> ${b.endTs}\n${cleanedText}`;
    }).join('\n\n');
}

export function validateAndFixSRT(rawText: string): string {
    const parsedBlocks = parseRawBlocks(rawText);
    if (parsedBlocks.length === 0) return rawText;

    // Stable sort chronologically by start timestamp
    parsedBlocks.sort((a, b) => a.startMs - b.startMs);

    // Reconstruct valid SRT with consecutive sequence numbers
    return reconstructSRT(parsedBlocks);
}

export type TimelineIssueType = 'backward' | 'gap' | 'overlap' | 'duration';

export interface TimelineIssue {
    index: number; // 0-based index of the cue with the issue
    type: TimelineIssueType;
    message: string;
    gapMs?: number;
    gapFormatted?: string;
    fromBlock?: { start: number; end: number; text?: string };
    toBlock?: { start: number; end: number; text?: string };
}

/**
 * Validates timeline integrity and detects backward jumps, unexpected gaps, overlaps, and duration anomalies.
 */
export function validateTimeline(
    blocks: Array<{ start: number; end: number; text?: string }>,
    maxUnexpectedGapMs = 25000
): TimelineIssue[] {
    const issues: TimelineIssue[] = [];
    if (!blocks || blocks.length < 2) return issues;

    for (let i = 1; i < blocks.length; i++) {
        const prev = blocks[i - 1];
        const curr = blocks[i];

        // 1. Backward timecode: current starts before previous starts
        if (curr.start < prev.start) {
            issues.push({
                index: i,
                type: 'backward',
                message: `Cue #${i + 1} starts before #${i} (${msToTime(curr.start)} < ${msToTime(prev.start)})`,
                fromBlock: prev,
                toBlock: curr
            });
        }

        // 2. Overlapping timecodes: current starts before previous ends
        if (curr.start < prev.end && curr.start >= prev.start) {
            const overlapSec = Math.round((prev.end - curr.start) / 100) / 10;
            issues.push({
                index: i,
                type: 'overlap',
                message: `Cue #${i + 1} overlaps #${i} by ${overlapSec}s`,
                fromBlock: prev,
                toBlock: curr
            });
        }

        // 3. Abnormal gap / temporal jump (> maxUnexpectedGapMs, e.g. 25 seconds)
        const gap = curr.start - prev.end;
        if (gap >= maxUnexpectedGapMs) {
            const minutes = Math.floor(gap / 60000);
            const seconds = Math.floor((gap % 60000) / 1000);
            const gapFormatted = minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
            issues.push({
                index: i,
                type: 'gap',
                message: `Abnormal jump/gap of ${gapFormatted} between #${i} and #${i + 1}`,
                gapMs: gap,
                gapFormatted,
                fromBlock: prev,
                toBlock: curr
            });
        }

        // 4. Invalid zero or negative duration
        if (curr.end <= curr.start) {
            issues.push({
                index: i,
                type: 'duration',
                message: `Cue #${i + 1} has zero or negative duration`,
                toBlock: curr
            });
        }
    }

    return issues;
}

/**
 * Auto-repairs timeline anomalies:
 * - Sorts blocks chronologically
 * - Enforces positive durations (minimum 500ms)
 * - Resolves overlaps by capping previous end time
 */
export function autoRepairTimeline<T extends { start: number; end: number; text?: string; textLines?: string[]; [key: string]: any }>(
    blocks: T[]
): { repairedBlocks: T[]; fixedCount: number } {
    if (!blocks || blocks.length === 0) return { repairedBlocks: [], fixedCount: 0 };

    let fixedCount = 0;

    // 0. Automatically split oversized multi-sentence subtitle blocks
    let baseBlocks: T[] = blocks;
    const hasDialogue = blocks.some(b => (b.text && b.text.trim().length > 0) || (b.textLines && b.textLines.length > 0));
    if (hasDialogue) {
        const blocksWithText = blocks.map(b => ({
            ...b,
            id: (b as any).id || Math.random().toString(36).substring(7),
            text: b.text || (b.textLines ? b.textLines.join('\n') : '')
        }));
        const { blocks: splitResults, splitCount } = splitOversizedBlocks(blocksWithText as any);
        if (splitCount > 0) {
            fixedCount += splitCount;
            baseBlocks = splitResults.map(sb => ({
                ...sb,
                textLines: (sb.text || '').split('\n')
            })) as any;
        }
    }

    // 1. Sort chronologically
    const sorted = [...baseBlocks].sort((a, b) => a.start - b.start);
    if (sorted.some((b, i) => b !== baseBlocks[i])) {
        fixedCount++;
    }

    const repaired: T[] = [];

    for (let i = 0; i < sorted.length; i++) {
        let block = { ...sorted[i] };
        
        // Ensure duration is at least 500ms
        if (block.end <= block.start) {
            block.end = block.start + 1200;
            fixedCount++;
        }

        // Prevent overlap with preceding block
        if (repaired.length > 0) {
            const prev = repaired[repaired.length - 1];
            if (block.start < prev.end) {
                // If overlap is small, adjust prev.end or block.start
                if (prev.end - block.start > 0) {
                    prev.end = Math.max(prev.start + 500, block.start - 50);
                    fixedCount++;
                }
            }
        }

        repaired.push(block);
    }

    return { repairedBlocks: repaired, fixedCount };
}

/**
 * Returns media duration in seconds using HTMLMediaElement metadata loading.
 */
export async function getMediaDuration(file: File): Promise<number> {
    return new Promise((resolve) => {
        let settled = false;
        let url = '';
        const finish = (val: number) => {
            if (settled) return;
            settled = true;
            if (url) {
                try { URL.revokeObjectURL(url); } catch (_) {}
            }
            resolve(val > 0 && !isNaN(val) && isFinite(val) ? val : 0);
        };
        const timer = setTimeout(() => finish(0), 10000);
        try {
            const lower = (file.name || '').toLowerCase();
            const isVideo = file.type.includes('video') || /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(lower);
            const element = document.createElement(isVideo ? 'video' : 'audio');
            element.preload = 'metadata';
            url = URL.createObjectURL(file);
            element.onloadedmetadata = () => {
                if (element.duration === Infinity) {
                    element.currentTime = 1e101;
                    element.ontimeupdate = () => {
                        element.ontimeupdate = null;
                        clearTimeout(timer);
                        finish(element.duration);
                    };
                } else {
                    clearTimeout(timer);
                    finish(element.duration);
                }
            };
            element.onerror = () => {
                clearTimeout(timer);
                finish(0);
            };
            element.src = url;
        } catch {
            clearTimeout(timer);
            finish(0);
        }
    });
}

/**
 * Streams media directly to the same-origin Express server endpoint /api/gemini/upload-file,
 * which uploads to Gemini's File API server-side, eliminating browser CORS preflight restrictions
 * and avoiding large ArrayBuffer heap allocations in browser memory.
 */
async function uploadFileViaServerProxy(file: File, mimeType: string, apiKey: string, onProgress?: (p: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/gemini/upload-file', true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Mime-Type', mimeType);
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'upload'));
        const keyToSend = getEffectiveGeminiApiKey(apiKey);
        if (keyToSend) {
            xhr.setRequestHeader('X-Gemini-API-Key', keyToSend);
        }

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && onProgress) {
                // Upload phase maps to 10% - 45%
                const pct = Math.min(45, Math.round(10 + (event.loaded / event.total) * 35));
                onProgress(pct);
            }
        };

        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data?.fileUri) {
                        if (onProgress) onProgress(50);
                        resolve(data.fileUri);
                        return;
                    }
                    reject(new Error(data?.error || 'Server upload returned invalid response without fileUri'));
                } catch (parseErr: any) {
                    reject(new Error(`Failed to parse server upload response: ${parseErr?.message || parseErr}`));
                }
            } else {
                let errText = `Server upload failed (HTTP ${xhr.status})`;
                try {
                    const data = JSON.parse(xhr.responseText);
                    if (data?.error) errText = data.error;
                } catch (_) {}
                if (xhr.status === 401) {
                    errText = 'Gemini API key is missing or invalid. Please open Settings -> API Settings Vault to enter your Google Gemini API Key.';
                }
                reject(new Error(errText));
            }
        };

        xhr.onerror = () => {
            reject(new Error('Network error during server file upload'));
        };

        xhr.ontimeout = () => {
            reject(new Error('Server file upload timed out (10-minute limit exceeded)'));
        };

        xhr.timeout = 600000; // 10 minutes for large media files
        xhr.send(file);
    });
}

async function uploadFileToGemini(file: File, mimeType: string, apiKey: string, onProgress?: (p: number) => void): Promise<string> {
    const effectiveKey = getEffectiveGeminiApiKey(apiKey);

    // If running with AI Studio's built-in placeholder key (no personal API key configured),
    // the Gemini File API (/upload/v1beta/files) cannot be called because AI Studio's window.fetch
    // blocks multipart/resumable File API uploads with "Failed to call the Gemini API. Please try again."
    // Throw immediately so callers seamlessly delegate to the Multimodal Chunked Engine (WAV + Sampled JPEG Video Frames).
    if (!isRealGeminiKey(effectiveKey)) {
        throw new Error('File API upload requires a personal Gemini API key; delegating to in-browser multimodal chunked engine.');
    }

    // 1. Primary path: Stream via same-origin Express/Vite server proxy (/api/gemini/upload-file)
    try {
        console.log(`[SRT Generator] Uploading ${(file.size / (1024 * 1024)).toFixed(1)}MB media via server proxy...`);
        const serverUri = await uploadFileViaServerProxy(file, mimeType, effectiveKey, onProgress);
        if (serverUri) {
            console.log(`[SRT Generator] Server upload successful, fileUri:`, serverUri);
            return serverUri;
        }
    } catch (proxyErr: any) {
        console.warn(`[SRT Generator] Server upload proxy failed, attempting SDK upload via proxy:`, proxyErr?.message || proxyErr);
    }

    // 2. Secondary fallback: SDK upload routed through /api/gemini/proxy (never raw window.fetch to generativelanguage.googleapis.com)
    const ai = getGenAI(effectiveKey, true);
    
    if (onProgress) onProgress(20);
    
    const uploadRes = await ai.files.upload({
        file: file,
        config: {
            mimeType: mimeType,
            displayName: file.name ? file.name.replace(/[^a-zA-Z0-9_\-\.]/g, '') : 'upload'
        }
    });
    
    if (onProgress) onProgress(50);
    
    let state = uploadRes.state;
    while (state === 'PROCESSING') {
        await new Promise(resolve => setTimeout(resolve, 3000));
        const statusData = await ai.files.get({ name: uploadRes.name });
        state = statusData.state;
        if (state === 'FAILED') throw new Error('File processing failed on server');
    }
    
    if (onProgress) onProgress(100);
    return uploadRes.uri;
}

export interface GenerateSrtOptions {
    audioFile?: File | null;
    youtubeUrl?: string | null;
    mode?: 'ori' | 'dual' | 'dual_trans' | 'triple' | 'quad';
    targetLang?: string;
    sourceLang?: string;
    apiKey?: string;
    styling?: string;
    processingMode?: 'audio' | 'video_audio' | 'youtube_transcript';
    onProgress?: (progress: number) => void;
    resumeTime?: string;
    contextInstruction?: string;
    knownDurationSec?: number;
}

function normalizeTextForMatch(text: string): string {
    return text.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
}

function deduplicateAndMergeBlocks(
    previousBlocks: ParsedRawBlock[],
    incomingBlocks: ParsedRawBlock[],
    overlapStartMs: number
): ParsedRawBlock[] {
    if (previousBlocks.length === 0) return incomingBlocks;
    if (incomingBlocks.length === 0) return previousBlocks;

    const result = [...previousBlocks];

    for (const inc of incomingBlocks) {
        // If incoming block ends before overlap interval began, skip
        if (inc.endMs < overlapStartMs) continue;

        // Restrict duplicate checks to the actual chunk-overlap region. Applying a global
        // "recent cue" match can delete repeated words/chorus lines that legitimately recur.
        const incNorm = normalizeTextForMatch(inc.textLines.join(' '));
        if (!incNorm) continue;

        const matchIdx = result.findIndex(prev => {
            if (prev.startMs < overlapStartMs - 6000) return false;
            const prevNorm = normalizeTextForMatch(prev.textLines.join(' '));
            if (!prevNorm) return false;
            const textMatches = incNorm === prevNorm || (incNorm.length > 5 && (prevNorm.includes(incNorm) || incNorm.includes(prevNorm)));
            if (!textMatches) return false;
            return Math.abs(inc.startMs - prev.startMs) < 5000 ||
                (inc.startMs < prev.endMs + 800 && inc.endMs > prev.startMs);
        });

        if (matchIdx !== -1) {
            // Duplicate in the actual overlap interval only.
            continue;
        }

        // Keep the model's cue boundaries intact. Moving only startMs (without
        // re-aligning the text against audio) can make the caption appear late/early.
        // Preserve overlaps for the Stage 1 timeline validator rather than changing
        // speech alignment based on the preceding cue's duration.
        result.push(inc);
    }

    return result;
}

/**
 * STAGE 1 TIMELINE LOCK:
 * Segments any oversized multi-sentence native cues and repairs overlaps ONCE on the pure native 1-line cues,
 * then freezes startMs, endMs, startTs, and endTs so Stage 2 (Style Format / Subtitle Mode) NEVER alters original timing.
 */
export function lockStage1NativeBlocks(rawNativeBlocks: ParsedRawBlock[]): ParsedRawBlock[] {
    if (!rawNativeBlocks || rawNativeBlocks.length === 0) return [];
    const blocksForRepair = rawNativeBlocks.map((b, i) => ({
        id: String(i + 1),
        start: b.startMs,
        end: b.endMs,
        text: b.textLines.join('\n').trim(),
        textLines: b.textLines
    }));
    const { repairedBlocks } = autoRepairTimeline(blocksForRepair);
    const locked: ParsedRawBlock[] = repairedBlocks.map(rb => {
        const startMs = Math.max(0, Math.round(rb.start));
        const endMs = Math.max(startMs + 400, Math.round(rb.end));
        const cleanLines = (rb.textLines && rb.textLines.length > 0
            ? rb.textLines
            : String(rb.text || '').split('\n')
        ).map((l: string) => l.replace(/\.$/, '').trim()).filter(Boolean);
        return {
            startMs,
            endMs,
            startTs: msToTime(startMs),
            endTs: msToTime(endMs),
            textLines: cleanLines.length > 0 ? cleanLines : ['...']
        };
    });

    // Persist the pure Stage 1 native SRT so the user can re-apply any Style Format / Mode later while keeping original time
    try {
        if (typeof localStorage !== 'undefined' && locked.length > 0) {
            localStorage.setItem('mv_stage1_native_srt', reconstructSRT(locked));
        }
    } catch (_) {}

    return locked;
}

function applyVisualLayerStyling(lines: string[], mode: string, styling?: string): string[] {
    const clean = lines.map(l => l.replace(/<\/?font[^>]*>/gi, '').replace(/\.$/, '').trim()).filter(Boolean);
    if (styling !== 'colors' || clean.length === 0) {
        return clean;
    }
    if (clean.length === 1) {
        return [`<font color="#38bdf8">${clean[0]}</font>`];
    }
    if (clean.length === 2) {
        return [
            clean[0],
            `<font color="#facc15">${clean[1]}</font>`
        ];
    }
    if (clean.length === 3) {
        return [
            clean[0],
            `<font color="#38bdf8">${clean[1]}</font>`,
            `<font color="#facc15">${clean[2]}</font>`
        ];
    }
    return [
        clean[0],
        `<font color="#38bdf8">${clean[1]}</font>`,
        `<font color="#4ade80">${clean[2]}</font>`,
        `<font color="#facc15">${clean.slice(3).join(' ')}</font>`
    ];
}

function parseCueMap(text: string): Map<number, string[]> {
    const cueMap = new Map<number, string[]>();
    const lines = text.split(/\r?\n/);
    let currentCueId: number | null = null;
    let currentLines: string[] = [];

    const flush = () => {
        if (currentCueId !== null && currentLines.length > 0) {
            cueMap.set(currentCueId, [...currentLines]);
        }
        currentLines = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trim().replace(/^\*\*|\*\*$/g, '').trim();
        if (!line || line.startsWith('```')) continue;
        // Skip accidental SRT timestamp lines if the model ever echoed one
        if (line.includes('-->')) continue;

        const match = line.match(/^(?:\[\s*(?:CUE\s*#?\s*)?(\d+)(?:\s*\|[^\]]*)?\s*\]|CUE\s*#?\s*(\d+)\s*[:\-])\s*(.*)$/i);
        if (match) {
            flush();
            currentCueId = parseInt(match[1] || match[2], 10);
            const remainder = (match[3] || '').trim();
            if (remainder && !remainder.includes('-->')) {
                currentLines.push(remainder);
            }
        } else if (currentCueId !== null) {
            currentLines.push(line);
        }
    }
    flush();
    return cueMap;
}

/**
 * STAGE 2 — STYLE FORMAT / SUBTITLE MODE ADJUSTMENT (STRICT ORIGINAL TIME LOCK):
 * Takes the Stage 1 Native blocks and transforms ONLY `textLines` according to the user's selected
 * Style Format (`ori`, `dual`, `dual_trans`, `triple`, `quad`), Target Language, and Visual Styling (`none` | `colors`),
 * while keeping every block's original `startMs`, `endMs`, `startTs`, and `endTs` 100% untouched.
 */
async function translateCuesById(
    blocks: ParsedRawBlock[],
    opts: GenerateSrtOptions,
    genAI: GoogleGenAI,
    onProgress?: (p: number) => void
): Promise<ParsedRawBlock[]> {
    const { mode = 'ori', targetLang = 'Original', sourceLang, styling = 'none' } = opts;
    const cleanTarget = (targetLang || '').trim();
    const cleanSource = (sourceLang || '').trim();
    const isSameAsSource = Boolean(
        cleanSource &&
        cleanSource.toLowerCase() !== 'auto-detect' &&
        cleanTarget.toLowerCase() === cleanSource.toLowerCase()
    );
    const isOriginalOnly =
        cleanTarget === '' ||
        cleanTarget.toLowerCase() === 'original' ||
        cleanTarget.toLowerCase() === 'verbatim' ||
        isSameAsSource;

    // If Standard 1-line mode in Original language, no translation call is needed—just apply visual styling while keeping exact original time
    if (mode === 'ori' && isOriginalOnly) {
        return blocks.map(b => ({
            startMs: b.startMs,
            endMs: b.endMs,
            startTs: b.startTs,
            endTs: b.endTs,
            textLines: applyVisualLayerStyling([b.textLines.join(' ').trim()], mode, styling)
        }));
    }

    const BATCH_SIZE = 45;
    const totalBatches = Math.ceil(blocks.length / BATCH_SIZE);
    // Deep-clone while strictly locking startMs, endMs, startTs, and endTs from Stage 1
    const formattedBlocks: ParsedRawBlock[] = blocks.map(b => ({
        startMs: b.startMs,
        endMs: b.endMs,
        startTs: b.startTs,
        endTs: b.endTs,
        textLines: [...b.textLines]
    }));

    const destLang = isOriginalOnly ? 'English' : cleanTarget;

    for (let b = 0; b < totalBatches; b++) {
        const batchStart = b * BATCH_SIZE;
        const batchBlocks = blocks.slice(batchStart, batchStart + BATCH_SIZE);

        let systemInstruction = `You are Stage 2 of a precision 2-Stage Subtitle Engine.
Stage 1 has ALREADY transcribed the native spoken dialogue and locked the exact acoustic timestamps.
Your job in Stage 2 is to adjust/format each native cue into the requested STYLE FORMAT / SUBTITLE MODE so that it fits naturally inside its locked time window WITHOUT ever changing timestamps or merging/splitting cues.

CRITICAL RULES:
1. PRESERVE EVERY CUE ID 1-TO-1: Return every cue starting with [CUE X] where X is the exact integer ID.
2. NEVER MERGE, SPLIT, OR SKIP CUES: Output exactly 1 [CUE X] block for each input [CUE X].
3. NEVER OUTPUT TIMESTAMPS: Do not output any timecodes. The original Stage 1 timestamps are locked externally.
4. DURATION-AWARE BREVITY: Each input header shows its locked duration (e.g. [CUE 1 | 2.1s]). Keep translations concise and natural so the viewer can read them comfortably within that exact time window. Do not end lines with trailing periods (.).`;

        if (mode === 'ori') {
            systemInstruction += `\n\nSTYLE FORMAT: STANDARD (1-LINE TRANSLATED)
For each [CUE X], output ONLY 1 concise line translated into ${destLang}:
[CUE X]
<Concise ${destLang} translation>`;
        } else if (mode === 'dual') {
            systemInstruction += `\n\nSTYLE FORMAT: BILINGUAL (2-LINE: NATIVE + TRANSLATED)
For each [CUE X], output ONLY the faithful, concise ${destLang} translation (1 line). Our engine will automatically lock the original Native line on Line 1 and place your ${destLang} translation on Line 2:
[CUE X]
<Concise ${destLang} translation>`;
        } else if (mode === 'dual_trans') {
            const secondLang = destLang.toLowerCase() === 'english' ? 'Indonesian' : destLang;
            systemInstruction += `\n\nSTYLE FORMAT: DUAL TRANSLATION (2-LINE: ENGLISH + ${secondLang.toUpperCase()})
For each [CUE X], output EXACTLY 2 lines:
[CUE X]
<Line 1: Concise English translation>
<Line 2: Concise ${secondLang} translation>`;
        } else if (mode === 'triple') {
            systemInstruction += `\n\nSTYLE FORMAT: TRIPLE LAYER (3-LINE: NATIVE + ROMANIZED + TRANSLATED)
For each [CUE X], output EXACTLY 2 lines (Line 1: Accurate Romanized phonetic reading such as Romaji/Pinyin/Revised Romanization; Line 2: Concise ${destLang} translation). Our engine will automatically lock the original Native script on the top line:
[CUE X]
<Accurate Romanized phonetic pronunciation>
<Concise ${destLang} translation>`;
        } else if (mode === 'quad') {
            const fourthLang = destLang.toLowerCase() === 'english' ? 'Indonesian' : destLang;
            systemInstruction += `\n\nSTYLE FORMAT: QUAD LAYER (4-LINE: NATIVE + ROMANIZED + ENGLISH + ${fourthLang.toUpperCase()})
For each [CUE X], output EXACTLY 3 lines (Line 1: Accurate Romanized phonetic pronunciation; Line 2: Literal English meaning; Line 3: Natural ${fourthLang} translation). Our engine will automatically lock the original Native script on the top line:
[CUE X]
<Accurate Romanized phonetic pronunciation>
<Literal English translation>
<Natural ${fourthLang} translation>`;
        }

        if (opts.contextInstruction && opts.contextInstruction.trim() !== '') {
            systemInstruction += `\n\nUSER CONTEXT & TERMINOLOGY:\n"""\n${opts.contextInstruction.trim()}\n"""`;
        }

        const inputPayload = batchBlocks.map((blk, idx) => {
            const cueId = batchStart + idx + 1;
            const durSec = Math.max(0.5, (blk.endMs - blk.startMs) / 1000).toFixed(1);
            const nativeLine = blk.textLines.join(' ').trim();
            return `[CUE ${cueId} | ${durSec}s]\n${nativeLine}`;
        }).join('\n\n');

        try {
            const res = await callAudioTranscriptionModel(genAI, {
                contents: `Format and translate these Stage 1 native dialogue cues into the requested Subtitle Mode while respecting each cue's locked duration:\n\n${inputPayload}`,
                config: {
                    temperature: 0.1,
                    maxOutputTokens: 8192,
                    systemInstruction
                }
            });

            const cueMap = parseCueMap(res.text || '');

            for (let i = 0; i < batchBlocks.length; i++) {
                const cueId = batchStart + i + 1;
                const globalIdx = batchStart + i;
                const nativeLine = batchBlocks[i].textLines.join(' ').replace(/<\/?font[^>]*>/gi, '').trim();
                const aiLines = (cueMap.get(cueId) || []).map(l => l.replace(/<\/?font[^>]*>/gi, '').trim()).filter(Boolean);

                let finalLines: string[] = [nativeLine];

                if (aiLines.length > 0) {
                    if (mode === 'ori') {
                        finalLines = [aiLines.join(' ')];
                    } else if (mode === 'dual') {
                        // If AI returned 2 lines where line 1 repeats native, take line 2; otherwise aiLines[0] is the translation
                        const transLine = (aiLines.length >= 2 && normalizeTextForMatch(aiLines[0]) === normalizeTextForMatch(nativeLine))
                            ? aiLines.slice(1).join(' ')
                            : aiLines[aiLines.length - 1];
                        finalLines = [nativeLine, transLine];
                    } else if (mode === 'dual_trans') {
                        if (aiLines.length >= 2) {
                            finalLines = [aiLines[0], aiLines.slice(1).join(' ')];
                        } else {
                            finalLines = [aiLines[0], aiLines[0]];
                        }
                    } else if (mode === 'triple') {
                        // Filter out nativeLine if AI echoed it as the first line
                        const filtered = (aiLines.length >= 3 && normalizeTextForMatch(aiLines[0]) === normalizeTextForMatch(nativeLine))
                            ? aiLines.slice(1)
                            : aiLines;
                        const romaji = filtered[0] || nativeLine;
                        const trans = filtered.slice(1).join(' ') || filtered[0] || '';
                        finalLines = [nativeLine, romaji, trans].filter(Boolean);
                    } else if (mode === 'quad') {
                        const filtered = (aiLines.length >= 4 && normalizeTextForMatch(aiLines[0]) === normalizeTextForMatch(nativeLine))
                            ? aiLines.slice(1)
                            : aiLines;
                        const romaji = filtered[0] || '';
                        const litEn = filtered[1] || filtered[0] || '';
                        const targetTrans = filtered.slice(2).join(' ') || filtered[filtered.length - 1] || '';
                        finalLines = [nativeLine, romaji, litEn, targetTrans].filter(Boolean);
                    }
                }

                // Lock original Stage 1 timestamps and apply optional visual layer styling
                formattedBlocks[globalIdx] = {
                    startMs: batchBlocks[i].startMs,
                    endMs: batchBlocks[i].endMs,
                    startTs: batchBlocks[i].startTs,
                    endTs: batchBlocks[i].endTs,
                    textLines: applyVisualLayerStyling(finalLines, mode, styling)
                };
            }
        } catch (err) {
            console.warn(`[SRT Stage 2] Batch formatting failed for cues ${batchStart + 1}-${batchStart + batchBlocks.length}:`, err);
        }

        if (onProgress) {
            onProgress(75 + Math.round(((b + 1) / totalBatches) * 20));
        }
    }

    return formattedBlocks;
}

/**
 * Re-applies any Style Format / Subtitle Mode (`ori`, `dual`, `dual_trans`, `triple`, `quad`),
 * Target Language, and Visual Styling (`none` | `colors`) to an existing SRT string
 * while keeping 100% of the original timestamps locked.
 */
export async function formatExistingSRTKeepTime(
    existingSrt: string,
    opts: GenerateSrtOptions
): Promise<string> {
    const rawBlocks = parseRawBlocks(existingSrt);
    if (rawBlocks.length === 0) {
        throw new Error("No valid timed subtitle cues found to format.");
    }
    // Extract the top native line from each block while keeping exact original startMs/endMs/startTs/endTs
    const nativeLockedBlocks: ParsedRawBlock[] = rawBlocks.map(b => ({
        startMs: b.startMs,
        endMs: b.endMs,
        startTs: b.startTs,
        endTs: b.endTs,
        textLines: [b.textLines[0]?.replace(/<\/?font[^>]*>/gi, '').trim() || b.textLines.join(' ').trim()]
    }));

    const keyToUse = getEffectiveGeminiApiKey(opts.apiKey);
    const genAI = getGenAI(keyToUse);
    if (opts.onProgress) opts.onProgress(20);
    const formatted = await translateCuesById(nativeLockedBlocks, opts, genAI, opts.onProgress);
    if (opts.onProgress) opts.onProgress(100);
    return reconstructSRT(formatted);
}

/**
 * Samples representative JPEG frames from a local video File across [startSec, startSec + durationSec].
 * Used by Watch & Listen (video_audio) chunked mode so Gemini receives both the WAV audio slice AND visual frames
 * without sending raw video container bytes that can trigger Gemini 500 INTERNAL errors.
 */
async function extractVideoFramesForWindow(
    videoFile: File,
    startSec: number,
    durationSec: number,
    maxFrames = 6
): Promise<any[]> {
    if (typeof document === 'undefined') return [];
    return new Promise((resolve) => {
        const video = document.createElement('video');
        const url = URL.createObjectURL(videoFile);
        let settled = false;
        const finish = (parts: any[]) => {
            if (settled) return;
            settled = true;
            try {
                video.removeAttribute('src');
                video.load();
            } catch (_) {}
            URL.revokeObjectURL(url);
            resolve(parts);
        };

        const timeoutId = setTimeout(() => finish([]), 12000);

        video.preload = 'auto';
        video.muted = true;
        video.playsInline = true;
        video.src = url;

        video.onerror = () => {
            clearTimeout(timeoutId);
            finish([]);
        };

        video.onloadedmetadata = async () => {
            try {
                const vw = video.videoWidth || 640;
                const vh = video.videoHeight || 360;
                const scale = Math.min(1, 640 / Math.max(vw, vh));
                const cw = Math.max(160, Math.round(vw * scale));
                const ch = Math.max(90, Math.round(vh * scale));

                const canvas = document.createElement('canvas');
                canvas.width = cw;
                canvas.height = ch;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    clearTimeout(timeoutId);
                    finish([]);
                    return;
                }

                const frameParts: any[] = [];
                const count = Math.max(1, Math.min(maxFrames, Math.floor(durationSec / 20) || 3));
                const step = durationSec / (count + 1);

                for (let i = 1; i <= count; i++) {
                    const targetTime = Math.min(
                        Math.max(0.1, startSec + i * step),
                        Math.max(0.1, (video.duration || (startSec + durationSec)) - 0.1)
                    );
                    await new Promise<void>((seekRes) => {
                        const onSeeked = () => {
                            video.removeEventListener('seeked', onSeeked);
                            seekRes();
                        };
                        video.addEventListener('seeked', onSeeked);
                        try {
                            video.currentTime = targetTime;
                        } catch (_) {
                            video.removeEventListener('seeked', onSeeked);
                            seekRes();
                        }
                    });
                    ctx.drawImage(video, 0, 0, cw, ch);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
                    const base64 = dataUrl.split(',')[1] || '';
                    if (base64) {
                        const relSec = Math.max(0, Math.round(targetTime - startSec));
                        const relTs = msToTime(relSec * 1000);
                        frameParts.push({ text: `[Visual Frame at relative timestamp ${relTs}]` });
                        frameParts.push({
                            inlineData: {
                                data: base64,
                                mimeType: 'image/jpeg'
                            }
                        });
                    }
                }
                clearTimeout(timeoutId);
                finish(frameParts);
            } catch (_) {
                clearTimeout(timeoutId);
                finish([]);
            }
        };
    });
}

async function transcribeSingleChunk(
    chunkBlob: Blob,
    chunkDurationSec: number,
    opts: GenerateSrtOptions,
    genAI: GoogleGenAI,
    apiKey: string,
    videoFrameParts: any[] = []
): Promise<string> {
    const maxTimecode = msToTime(Math.round(chunkDurationSec * 1000));
    const hasVisualFrames = videoFrameParts.length > 0;

    let pass1Instruction = `You are an expert ${hasVisualFrames ? 'multimodal video & audio' : 'audio'} segmentation and transcription engine.
Your task is to transcribe dialogue${hasVisualFrames ? ' and visible on-screen text/captions' : ''} from this media segment (duration: ${Math.round(chunkDurationSec)} seconds).

CRITICAL TEMPORAL & COMPLETENESS CONSTRAINTS:
- The segment duration is exactly ${Math.round(chunkDurationSec)} seconds.
- Relative timestamps MUST start from 00:00:00,000 and MUST NEVER exceed ${maxTimecode}.
- TOTAL TRANSCRIPTION FIDELITY: Transcribe EVERY SINGLE dialogue utterance${hasVisualFrames ? ', sung lyric, and meaningful on-screen text/title' : ''} across the ENTIRE segment from 0.0s to the very end of this chunk. Do NOT stop early. Do NOT truncate. Generate all continuous subtitle blocks covering 100% of the speech.
- Subtitles must proceed strictly in chronological sequence (start < end).
- Do not jump ahead in time.
- Standard SRT format: HH:MM:SS,mmm --> HH:MM:SS,mmm.
- CRITICAL SUBTITLE BREVITY & NO LONG TEXT (MAX 1 SENTENCE PER BLOCK):
  * NEVER cram multiple complete sentences or long paragraphs into a single subtitle block.
  * 1 subtitle block = EXACTLY 1 concise sentence or phrase (Max 1-2 short lines).
  * Whenever a speaker finishes a sentence (ending in '.', '?', '!', or a natural spoken pause), immediately END that subtitle block and start a NEW time-aligned subtitle block for the next sentence!
  * Maximum duration per block: 1.5 to 3.5 seconds (never leave a subtitle block spanning 5-7 seconds with bundled sentences).
  * Character limits per line: Korean/Japanese/Chinese (CJK) MAXIMUM 15-25 characters; English/Latin MAXIMUM 35-42 characters.
- Transcribe the verbatim spoken dialogue in original language. Do not translate yet.
- Output ONLY valid SRT format. No backticks, no explanations.`;

    if (opts.sourceLang && opts.sourceLang !== 'Auto-detect') {
        pass1Instruction += `\nAUDIO LANGUAGE HINT: The primary spoken language is "${opts.sourceLang}".`;
    }

    if (opts.contextInstruction && opts.contextInstruction.trim() !== '') {
        pass1Instruction += `\nUSER CONTEXT & TERMINOLOGY:\n"""\n${opts.contextInstruction.trim()}\n"""`;
    }

    let parts: any[] = [{ text: `Generate precisely timed SRT transcription for this ${hasVisualFrames ? 'video + audio' : 'audio'} slice.` }];
    const MAX_INLINE_SIZE = 15 * 1024 * 1024;

    if (chunkBlob.size <= MAX_INLINE_SIZE) {
        const base64 = await blobToBase64(chunkBlob);
        parts.push({
            inlineData: {
                data: base64,
                mimeType: 'audio/wav',
            }
        });
    } else {
        try {
            const chunkFile = new File([chunkBlob], 'chunk.wav', { type: 'audio/wav' });
            const fileUri = await uploadFileToGemini(chunkFile, 'audio/wav', apiKey);
            parts.push({
                fileData: {
                    fileUri,
                    mimeType: 'audio/wav',
                }
            });
        } catch (uploadErr) {
            console.warn('[SRT Generator] Chunk upload failed, using inlineData base64 fallback:', uploadErr);
            const base64 = await blobToBase64(chunkBlob);
            parts.push({
                inlineData: {
                    data: base64,
                    mimeType: 'audio/wav',
                }
            });
        }
    }

    if (hasVisualFrames) {
        parts.push(...videoFrameParts);
    }

    const res = await callAudioTranscriptionModel(genAI, {
        contents: { parts },
        config: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            systemInstruction: pass1Instruction,
        }
    });

    let srt = res.text || "";
    if (srt.startsWith('```')) {
        srt = srt.replace(/^```[a-z]*\r?\n/, '').replace(/\r?\n```$/, '');
    }
    return srt;
}

function parseResumeTimeToSec(resumeTime?: string): number {
    if (!resumeTime || !resumeTime.trim()) return 0;
    const parts = resumeTime.trim().replace(',', '.').split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || 0;
}

/**
 * Byte-windowed streaming audio decode fallback for massive audio files (e.g. 80MB+ MP3/AAC/WAV)
 * when full-file decodeAudioData exceeds browser/WebView contiguous PCM memory limits.
 */
async function generateByteWindowedChunkedSRT(
    opts: GenerateSrtOptions,
    totalDurationSec: number,
    genAI: GoogleGenAI,
    apiKey: string
): Promise<string> {
    const { audioFile, onProgress } = opts;
    if (!audioFile) throw new Error("No audio file provided.");

    const WINDOW_BYTES = 10 * 1024 * 1024; // 10 MB per window (~4.5 to 5 minutes of audio)
    const totalWindows = Math.max(1, Math.ceil(audioFile.size / WINDOW_BYTES));
    const CHUNK_DURATION_SEC = 150;
    const OVERLAP_SEC = 5;
    const STEP_SEC = CHUNK_DURATION_SEC - OVERLAP_SEC;

    let allBlocks: ParsedRawBlock[] = [];
    let accumulatedTimeOffsetSec = parseResumeTimeToSec(opts.resumeTime);
    const startByteRatio = totalDurationSec > 0 && accumulatedTimeOffsetSec > 0
        ? Math.min(0.95, accumulatedTimeOffsetSec / totalDurationSec)
        : 0;
    const startWindowIdx = Math.floor(startByteRatio * totalWindows);

    for (let w = startWindowIdx; w < totalWindows; w++) {
        const byteStart = w * WINDOW_BYTES;
        const byteEnd = Math.min(audioFile.size, (w + 1) * WINDOW_BYTES);
        if (byteEnd - byteStart < 32 * 1024) break;

        const sliceFile = new File(
            [audioFile.slice(byteStart, byteEnd)],
            `window_${w}_${audioFile.name}`,
            { type: audioFile.type || 'audio/mpeg' }
        );

        const decoded = await decodeAudioBufferFromFile(sliceFile);
        const winBuffer = decoded.audioBuffer;
        const winDur = winBuffer.duration;
        const subChunks = Math.max(1, Math.ceil((winDur - OVERLAP_SEC) / STEP_SEC));

        for (let c = 0; c < subChunks; c++) {
            const subStartSec = c * STEP_SEC;
            const subDurSec = Math.min(CHUNK_DURATION_SEC, winDur - subStartSec);
            if (subDurSec <= 1) break;

            if (onProgress) {
                const overallProgress = ((w - startWindowIdx) + (c / subChunks)) / Math.max(1, totalWindows - startWindowIdx);
                onProgress(Math.round(15 + overallProgress * 58));
            }

            const { wavBlob } = extractWavSliceFromBuffer(winBuffer, subStartSec, subDurSec, 12000);
            let rawChunkSrt = '';
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    rawChunkSrt = await transcribeSingleChunk(wavBlob, subDurSec, opts, genAI, apiKey);
                    if (rawChunkSrt && rawChunkSrt.trim()) break;
                } catch (err) {
                    console.warn(`[SRT Byte-Window] Window ${w + 1}/${totalWindows} chunk ${c + 1} attempt ${attempt + 1} notice:`, err);
                    await new Promise(r => setTimeout(r, 2500 * (attempt + 1)));
                }
            }

            const chunkBlocks = parseRawBlocks(rawChunkSrt);
            const globalChunkStartMs = Math.round((accumulatedTimeOffsetSec + subStartSec) * 1000);
            const shiftedBlocks = shiftSubtitleBlocks(
                chunkBlocks,
                globalChunkStartMs,
                Math.round(subDurSec * 1000)
            );

            allBlocks = deduplicateAndMergeBlocks(allBlocks, shiftedBlocks, globalChunkStartMs);
        }

        accumulatedTimeOffsetSec += winDur;
    }

    if (allBlocks.length === 0) {
        throw new Error("No speech segments decoded from byte-windowed audio.");
    }

    // Stage 1 Lock: Clean and lock original native timestamps BEFORE Stage 2 Mode/Style adjustment
    allBlocks = lockStage1NativeBlocks(allBlocks);

    // Stage 2: Adjust Style Format / Subtitle Mode & Visual Styling while keeping 100% of original Stage 1 timestamps
    if (onProgress) onProgress(75);
    allBlocks = await translateCuesById(allBlocks, opts, genAI, onProgress);

    if (onProgress) onProgress(95);
    return reconstructSRT(allBlocks);
}

async function generateChunkedSRT(
    opts: GenerateSrtOptions,
    totalDurationSec: number,
    genAI: GoogleGenAI,
    apiKey: string,
    allowSinglePassFallback = true
): Promise<string> {
    const { onProgress, audioFile } = opts;
    if (onProgress) onProgress(10);

    if (!audioFile) {
        throw new Error("No audio file provided for chunked transcription.");
    }

    const lowerFileName = (audioFile.name || '').toLowerCase();
    const isVideoContainer = (audioFile.type || '').startsWith('video/') ||
        /\.(mp4|m4v|mov|webm|ogv|mkv|avi|flv|wmv|mpeg|mpg|mpe|3gp|3g2|ts|m2ts|mts)$/i.test(lowerFileName);
    const shouldSampleVideoFrames = isVideoContainer && opts.processingMode === 'video_audio';

    let audioBuffer: AudioBuffer;
    let duration: number;

    try {
        const decoded = await decodeAudioBufferFromFile(audioFile);
        audioBuffer = decoded.audioBuffer;
        // CRITICAL FIX: Never cap audioBuffer.duration with a 300s fallback!
        // Always trust the real decoded PCM duration (e.g. 2280s = 38 minutes).
        duration = audioBuffer.duration > 0
            ? audioBuffer.duration
            : (totalDurationSec > 0 ? totalDurationSec : 3600);
    } catch (decodeErr) {
        console.warn('[SRT Generator] Full-file decodeAudioData failed on media file:', decodeErr);
        let safeMimeType = audioFile.type || '';
        const lowerName = (audioFile.name || '').toLowerCase();
        const extension = lowerName.split('.').pop() || '';
        const inferredMimeTypes: Record<string, string> = {
            mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
            webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
            avi: 'video/x-msvideo', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
            mpeg: 'video/mpeg', mpg: 'video/mpeg', mpe: 'video/mpeg',
            '3gp': 'video/3gpp', '3g2': 'video/3gpp2', ts: 'video/mp2t',
            m2ts: 'video/mp2t', mts: 'video/mp2t', mxf: 'application/mxf',
            vob: 'video/mpeg', rm: 'application/vnd.rn-realmedia',
            rmvb: 'application/vnd.rn-realmedia-vbr', divx: 'video/divx', f4v: 'video/mp4', asf: 'video/x-ms-asf',
            mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
            wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg',
            flac: 'audio/flac', aiff: 'audio/aiff',
        };
        const inferredMimeType = inferredMimeTypes[extension];
        const genericMimeType = !safeMimeType || safeMimeType === 'application/octet-stream' || safeMimeType === 'binary/octet-stream';
        if (inferredMimeType && (genericMimeType || (inferredMimeType.startsWith('video/') && !safeMimeType.startsWith('video/')))) {
            safeMimeType = inferredMimeType;
        } else if (genericMimeType) {
            safeMimeType = 'audio/mpeg';
        }

        // If this is a large streamable audio file (e.g. 80MB MP3/AAC/WAV/OGG) that ran out of contiguous PCM RAM,
        // decode it in 10MB byte windows before falling back to cloud single-pass!
        const isStreamableAudio = /\.(mp3|aac|wav|ogg|opus|flac)$/i.test(lowerName) || /^audio\/(mpeg|mp3|aac|wav|ogg|flac)/i.test(safeMimeType);
        if (isStreamableAudio && audioFile.size > 12 * 1024 * 1024) {
            try {
                console.log('[SRT Generator] Trying 10MB Byte-Windowed Audio Decoding for large audio file...');
                return await generateByteWindowedChunkedSRT(opts, totalDurationSec, genAI, apiKey);
            } catch (byteWinErr) {
                console.warn('[SRT Generator] Byte-windowed decode fallback failed:', byteWinErr);
            }
        }

        if (!allowSinglePassFallback) {
            throw decodeErr;
        }

        const isVideoSource = safeMimeType.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|mkv|avi|flv|wmv|mpeg|mpg|mpe|3gp|3g2|ts|m2ts|mts|mxf|vob|rm|rmvb|divx|f4v|asf)$/i.test(lowerName);
        const isVideo = isVideoSource && opts.processingMode === 'video_audio';
        return await generateSinglePassSRT(opts, safeMimeType, isVideo, genAI, apiKey, totalDurationSec);
    }

    // 150-second chunks (2.5 min) with 5-second overlap at 12kHz mono (~3.6MB WAV)
    // Reduces total API calls for a 38-minute file from 28 down to 16 and prevents 8-10min rate-limit cutoffs
    const CHUNK_DURATION_SEC = 150; 
    const OVERLAP_SEC = 5;
    const STEP_SEC = CHUNK_DURATION_SEC - OVERLAP_SEC; // 145 seconds
    const resumeOffsetSec = parseResumeTimeToSec(opts.resumeTime);
    const effectiveDurationSec = Math.max(0, duration - resumeOffsetSec);
    const totalChunks = Math.max(1, Math.ceil((effectiveDurationSec - OVERLAP_SEC) / STEP_SEC));

    console.log(`[SRT Generator] Anti-Drift Chunking active: ${totalChunks} chunks for ${Math.round(duration)}s total media (starting at ${Math.round(resumeOffsetSec)}s, visualFrames=${shouldSampleVideoFrames})`);

    let allBlocks: ParsedRawBlock[] = [];

    for (let c = 0; c < totalChunks; c++) {
        const chunkStartSec = resumeOffsetSec + c * STEP_SEC;
        const chunkDurSec = Math.min(CHUNK_DURATION_SEC, duration - chunkStartSec);
        if (chunkDurSec <= 1) break;

        if (onProgress) {
            const pct = Math.round(12 + (c / totalChunks) * 62);
            onProgress(pct);
        }

        // Gentle pacing between chunks on long files (> 8 minutes) to avoid 429 RPM/TPM rate limit spikes at 8-10 min
        if (c > 0 && totalChunks > 4) {
            await new Promise(resolve => setTimeout(resolve, 900));
        }

        const { wavBlob } = extractWavSliceFromBuffer(audioBuffer, chunkStartSec, chunkDurSec, 12000);
        const videoFrameParts = shouldSampleVideoFrames
            ? await extractVideoFramesForWindow(audioFile, chunkStartSec, chunkDurSec, 6)
            : [];

        let rawChunkSrt = '';
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                rawChunkSrt = await transcribeSingleChunk(wavBlob, chunkDurSec, opts, genAI, apiKey, videoFrameParts);
                if (rawChunkSrt && rawChunkSrt.trim()) break;
            } catch (chunkErr: any) {
                console.warn(`[SRT Generator] Chunk ${c + 1}/${totalChunks} (${Math.round(chunkStartSec)}s-${Math.round(chunkStartSec + chunkDurSec)}s) attempt ${attempt + 1} failed:`, chunkErr?.message || chunkErr);
                if (attempt < 2) {
                    await new Promise(resolve => setTimeout(resolve, 3000 * (attempt + 1)));
                }
            }
        }

        if (!rawChunkSrt || !rawChunkSrt.trim()) {
            console.warn(`[SRT Generator] Skipping empty chunk ${c + 1}/${totalChunks} and continuing remaining chunks...`);
            continue;
        }

        const chunkBlocks = parseRawBlocks(rawChunkSrt);
        if (chunkBlocks.length === 0) continue;

        const chunkStartMs = Math.round(chunkStartSec * 1000);

        // Each WAV slice starts at relative time zero; always offset every cue by the
        // known slice start. Inferring absolute-vs-relative time from one cue caused drift.
        const shiftedBlocks = shiftSubtitleBlocks(
            chunkBlocks,
            chunkStartMs,
            Math.round(chunkDurSec * 1000)
        );

        allBlocks = deduplicateAndMergeBlocks(allBlocks, shiftedBlocks, chunkStartMs);
    }

    if (allBlocks.length === 0) {
        throw new Error("No speech segments detected in any audio chunks.");
    }

    // Stage 1 Lock: Clean and lock original native timestamps BEFORE Stage 2 Mode/Style adjustment
    allBlocks = lockStage1NativeBlocks(allBlocks);

    // Stage 2: Adjust Style Format / Subtitle Mode & Visual Styling while keeping 100% of original Stage 1 timestamps
    if (onProgress) onProgress(75);
    allBlocks = await translateCuesById(allBlocks, opts, genAI, onProgress);

    if (onProgress) onProgress(95);
    return reconstructSRT(allBlocks);
}

async function generateSinglePassSRT(
    opts: GenerateSrtOptions,
    safeMimeType: string,
    isVideo: boolean,
    genAI: GoogleGenAI,
    keyToUse: string,
    knownDurationSec = 0
): Promise<string> {
    const {
        audioFile,
        youtubeUrl,
        mode = 'ori',
        targetLang = 'Original',
        sourceLang,
        onProgress,
        resumeTime
    } = opts;
    const processingMode = opts.processingMode || 'video_audio';
    const isVideoSource = Boolean(youtubeUrl || (audioFile && (
        safeMimeType.startsWith('video/') ||
        /\.(mp4|m4v|mov|webm|ogv|mkv|avi|flv|wmv|mpeg|mpg|mpe|3gp|3g2|ts|m2ts|mts|mxf|vob|rm|rmvb|divx|f4v|asf)$/i.test(audioFile.name || '')
    )));

    let systemInstruction = `You are the AI MULTIMODAL VIDEO & SUBTITLE ANALYSIS ENGINE.
Your task is to transcribe and time-align the provided ${isVideo ? 'video' : 'audio soundtrack'} and generate an accurate, complete, valid SRT file.

${isVideoSource && processingMode === 'audio'
    ? 'LISTEN ONLY MODE: The source is a video file, but use ONLY its embedded audio/soundtrack for transcription and timing. Ignore video frames, facial expressions, lip movements, on-screen text, and visual scene context. Do not create captions from visual-only information. Keep all timestamps aligned to the embedded audio timeline.'
    : isVideo
        ? 'WATCH & LISTEN MODE (COMPREHENSIVE MULTIMODAL CAPTURE): Watch the video frames AND listen to the audio soundtrack simultaneously. You MUST capture 100% of all text: transcribe all spoken dialogue, sung lyrics, chants, and vocalizations (using visual lip movement and facial expressions to catch every word even when fast or quiet), PLUS capture all on-screen text, burned-in subtitles, lyrics displays, title cards, dialogue overlays, signs, and captions timed to when they appear and disappear.'
        : 'AUDIO MODE: Use the audio signal for transcription and timing. Capture 100% of spoken and sung dialogue accurately aligned to the audio waveform.'}

The goal is to create subtitles that are: 100% COMPLETE + ALL TEXT CAPTURED + CORRECTLY WRITTEN + ACCURATELY TIMED + ZERO DRIFT${isVideo && processingMode === 'video_audio' ? ' + VISUALLY GROUNDED' : ''}.

OUTPUT FORMAT:
Output ONLY the raw SRT format. No markdown formatting, no code block backticks (\`\`\`srt), and no conversational explanations.

CORE WORKFLOW:
1. FIRST PASS: Understand the video structure (scene changes, on-screen text, speaker appearances, speech vs. silence).
2. AUDIO & VISUAL ANALYSIS: Detect exact speech onset, offset, pauses, word boundaries, and visual text appearance/disappearance intervals.
3. SPEAKER & TEXT IDENTIFICATION: Transcribe who is speaking and what text appears on screen.
4. TRANSCRIPTION FIDELITY: Transcribe ALL spoken words, sung lyrics, and visual on-screen text. Do not summarize or omit text.
5. TRANSLATION: Translate while preserving meaning, tone, and context.
6. SEGMENTATION: Group words into subtitles based on natural pauses, readability, and the 5-second max duration rule.

CRITICAL RULE 1: EXACT MEDIA-TIMELINE SYNCHRONIZATION (ZERO DRIFT)
- TIMING SYNCHRONIZATION: For vocal dialogue/lyrics, align start and end to the acoustic delivery. For on-screen visual text/subtitles/titles, align start and end to when the text appears and disappears in the video frames.
- NO PHANTOM TIMING (PRE-SPEECH SOUNDS): If a speaker makes a pre-speech sound (like "Woah", "Ah", a gasp, or a sigh) before starting their actual sentence, DO NOT start the sentence's timecode early during that sound UNLESS you explicitly type out the sound (e.g., "Woah, how exciting!"). If you don't type the sound, the timecode MUST NOT start until the actual first word ("how").
- NEVER assume a sentence should occupy the entire time between the previous and next sentence. Do NOT keep a caption on screen during long silent periods merely because the next sentence hasn't started.
- The start timestamp MUST mark the exact millisecond the speaker utters the first syllable or text appears.
- The end timestamp MUST mark the exact millisecond when the vocal sound concludes or text disappears.
- Standard SRT format: HH:MM:SS,mmm --> HH:MM:SS,mmm.

CRITICAL RULE 2: CHRONOLOGICAL & NO OVERLAPPING
- Subtitles must proceed strictly in chronological sequence (start < end).
- NO OVERLAPPING TIMECODES: A subtitle's start time MUST be greater than or equal to the previous subtitle's end time. Never output two subtitle blocks that occur at the same time.
- Do not output invalid seconds (values >= 60).

CRITICAL RULE 3: LINGUISTIC ACCURACY & FAITHFUL TRANSCRIPTION
- 100% TRANSCRIPTION FIDELITY: Transcribe what was actually spoken, sung, or displayed on-screen without omitting lines.
- CONTEXT WINDOW: Use the surrounding conversation, music, and visual scene to determine meaning and lyrics.
- SAME LANGUAGE RULE: If the spoken audio is already in the target language (or Original Language is selected), output the verbatim original text.

CRITICAL RULE 4: PROFESSIONAL SEGMENTATION, BREVITY & NO LONG TEXT (MAX 1 SENTENCE PER BOX)
- NEVER cram multiple complete sentences or long paragraphs into a single subtitle block.
- STRICT SENTENCE SEGMENTATION: 1 subtitle block = ONLY 1 concise sentence, lyric line, or short clause.
- Whenever a sentence ends (with '.', '?', '!', or a natural spoken pause), immediately start a new subtitle block!
- MAX DURATION: 1.5 to 3.5 seconds per block (maximum 4.0s). Never bundle sentences into 5-7 second blocks.
- MAX LENGTH: Maximum 1-2 short lines per block.
  * Korean / Japanese / Chinese (CJK): MAXIMUM 15-25 characters per line (NEVER > 30 chars).
  * English / Latin / Western: MAXIMUM 35-42 characters per line.
- SHORT REACTIONS & VOCALIZATION SEPARATION: Pay extreme attention to short, rapid reactions (e.g., "Ah", "Oh", "Woah", gasps). Do not skip them.
- OVERLAPPING SPEECH: If two people speak simultaneously, DO NOT create overlapping timecode blocks. Instead, combine their dialogue into a SINGLE subtitle block using two lines (e.g., "- Hello\n- Hi").

CRITICAL RULE 5: VISUAL TEXT, ON-SCREEN SUBTITLES & EMOTION CONTEXT
- ON-SCREEN TEXT & GRAPHICS: In Watch & Listen mode, actively capture and create subtitle blocks for all on-screen burned-in subtitles, lyric displays, title cards, captions, dialogue overlays, signs, and presenter notes exactly when they appear.
- EMOTION & EXPRESSION TAGGING: When a speaker exhibits a clear emotion visually (e.g., facial expressions of surprise, shyness) or acoustically (e.g., crying, laughing, sighs), you may include an emotion tag in brackets (e.g., [Laughing], [Surprised], [Sighs]).
- LAUGHTER & VOCALIZATIONS: Detect and accurately time laughter, humming, gasps, and crying.

CRITICAL RULE 6: CLEAN FORMATTING
- ABSOLUTELY NO TRAILING PERIODS. Do NOT end subtitle lines with a period (.). Question marks (?) and exclamation marks (!) are allowed, but never periods.

CRITICAL RULE 7: TOTAL COMPLETENESS — CAPTURE ALL TEXT
- Transcribe the entire media continuously from start to finish. NEVER omit lines, chorus refrains, whispered words, rapid dialogue, or on-screen captions. Every piece of textual content must be captured.`;

    if (isVideoSource && processingMode === 'audio') {
        systemInstruction += '\n\nSTRICT LISTEN-ONLY OVERRIDE: The input happens to be a video container, but use ONLY its embedded audio/soundtrack. Ignore all video frames, facial expressions, lip movements, on-screen text, scene changes, and any other visual evidence. Do not produce captions from visual-only content. Determine every word and timestamp exclusively from audible speech, singing, and vocalizations.';
    } else if (isVideoSource && processingMode === 'video_audio') {
        systemInstruction += '\n\nWATCH & LISTEN COMPREHENSIVE CAPTURE DIRECTIVE: You MUST capture ALL text present in this video—both audible and visual. ' +
            '1. Spoken & Sung Text: Transcribe all dialogue, lyrics, chants, and vocalizations. Use lip movements and facial context to catch subtle, whispered, rapid, or background speech. ' +
            '2. On-Screen Text & Subtitles: Capture all on-screen burned-in subtitles, lyric displays, title cards, captions, signboards, presentation text, and dialogue overlays. Time visual text to its visible interval (or align with speech when synchronized). ' +
            '3. Zero Omissions: Never skip or truncate any line, lyric, or dialogue. Capture everything completely from start to finish.';
    }

    if (sourceLang && sourceLang !== 'Auto-detect') {
        systemInstruction += `\nAUDIO LANGUAGE HINT: The primary spoken language in this media is "${sourceLang}". Use this acoustic context to ensure 100% phonetic recognition and eliminate transcription mistakes.`;
    }

    if (resumeTime && resumeTime.trim() !== '') {
        systemInstruction += `\nCRITICAL RULE 8: RESUME POSITION. The user requested to resume transcription starting at playback timestamp ${resumeTime.trim()}. Ignore audio prior to this point and start your very first subtitle block at or immediately after ${resumeTime.trim()} with absolute media timestamps continuing until the end.`;
    }

    if (opts.contextInstruction && opts.contextInstruction.trim() !== '') {
        systemInstruction += `\n\nUSER CONTEXT & INSTRUCTIONS FOR THIS MEDIA:\n"""\n${opts.contextInstruction.trim()}\n"""\nPlease adhere to these specific contextual instructions when transcribing and translating (e.g. character names, specific terminology, or context about the source material).`;
    }

    const cleanTarget = targetLang.trim();
    const isOriginalOnly = cleanTarget === '' || cleanTarget.toLowerCase() === 'original' || cleanTarget.toLowerCase() === 'verbatim';
    const isSimpleOriginal = mode === 'ori' && isOriginalOnly;

    // --- PASS 1: TRANSCRIPTION & TIMING (Stopwatch) ---
    let pass1Instruction = `You are an expert multimodal video and audio transcription engine.
Your primary task is to identify and transcribe EVERY dialogue, lyric, vocalization, and on-screen text segment from the ${isVideo && processingMode === 'video_audio' ? 'video frames and its audio soundtrack' : 'audio soundtrack'}.
${isVideoSource && processingMode === 'audio'
    ? 'LISTEN ONLY: Ignore video frames and all visual information. Transcribe only audible speech, singing, and vocalizations from the embedded soundtrack; use the audio for every timestamp.'
    : isVideo && processingMode === 'video_audio'
        ? 'WATCH & LISTEN (COMPREHENSIVE CAPTURE): Watch all video frames and listen to the audio soundtrack. Capture ALL text: (1) All spoken dialogue and sung lyrics without missing any words; (2) All on-screen text, burned-in subtitles, lyric displays, title cards, dialogue banners, and visual captions. Align timestamps precisely with speech and on-screen visibility.'
        : 'AUDIO MODE: Transcribe all spoken dialogue, singing, and vocalizations with exact millisecond timing.'}

For each dialogue or text segment:
- For spoken/sung words: Start the subtitle when the speaker/singer begins; end it when they finish.
- For visual on-screen text: Start when the text becomes visible; end when it disappears.
- Do not estimate timing based on sentence length or distribute subtitles evenly; follow the real media timeline.
- Pay special attention to silence, pauses, overlapping speech, music, and dialogue transitions.
- Never let a subtitle extend through a long silence unless on-screen text is continuously visible.

CRITICAL RULE: STRICT MONOTONIC TIMECODE CONTINUITY (NO TIMECODE JUMPING).
- Timestamps must progress continuously and monotonically matching the media playback.
- DO NOT jump or skip ahead in time (e.g. jumping from 02:00 to 05:00).
- If an instrumental break or silence occurs, output the exact playback time when the next speech or on-screen text resumes without skipping ahead in the clock.

CRITICAL RULE: CAPTURE ALL TEXT (ZERO OMISSIONS).
- Capture all lyrics, refrains, choruses, dialogue, whispers, rapid speech, and on-screen text displays.
- Never omit lines.

Return the original text aligned to exact timestamps.
Format the output strictly as standard SRT (HH:MM:SS,mmm --> HH:MM:SS,mmm).
CRITICAL: STRICT SUBTITLE BREVITY (MAX 1 SENTENCE PER BLOCK):
- Never bundle multiple sentences into one subtitle block. Split dialogue into concise 1-sentence segments anchored to the speech timing (1.5 - 3.5 seconds per block).
- Max 15-25 CJK characters or 35-42 Latin characters per line. Never write long paragraphs.

Do not translate yet.
Do not rewrite the dialogue yet.
Do not generate explanations.
Output ONLY the raw SRT format.`;

    if (sourceLang && sourceLang !== 'Auto-detect') {
        pass1Instruction += `\nAUDIO LANGUAGE HINT: The primary spoken language is "${sourceLang}". Use this acoustic context to ensure 100% phonetic recognition.`;
    }

    if (resumeTime && resumeTime.trim() !== '') {
        pass1Instruction += `\nCRITICAL RULE: RESUME POSITION. Start your very first subtitle block at or immediately after ${resumeTime.trim()} with absolute media timestamps.`;
    }

    if (opts.contextInstruction && opts.contextInstruction.trim() !== '') {
        pass1Instruction += `\nUSER CONTEXT & INSTRUCTIONS:\n"""\n${opts.contextInstruction.trim()}\n"""\nAdhere to these instructions when transcribing (e.g. character names, terminology).`;
    }

    const currentModel = getCurrentTextModel();

    let parts: any[] = [{ text: `Generate the precisely timed SRT transcription for this media.` }];
    let usedInline = false;

    if (youtubeUrl) {
        if (onProgress) onProgress(30);
        const { videoId } = normalizeYoutubeUrl(youtubeUrl);
        const canonicalYtUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : youtubeUrl.trim();
        parts.push({
            fileData: {
                fileUri: canonicalYtUrl,
                mimeType: "video/mp4"
            }
        });
        if (onProgress) onProgress(50);
    } else if (audioFile) {
        let safeMimeType = audioFile.type || '';
        const lowerName = (audioFile.name || '').toLowerCase();
        const extension = lowerName.split('.').pop() || '';
        const inferredMimeTypes: Record<string, string> = {
            mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
            webm: 'video/webm', ogv: 'video/ogg', mkv: 'video/x-matroska',
            avi: 'video/x-msvideo', flv: 'video/x-flv', wmv: 'video/x-ms-wmv',
            mpeg: 'video/mpeg', mpg: 'video/mpeg', mpe: 'video/mpeg',
            '3gp': 'video/3gpp', '3g2': 'video/3gpp2', ts: 'video/mp2t',
            m2ts: 'video/mp2t', mts: 'video/mp2t', mxf: 'application/mxf',
            vob: 'video/mpeg', rm: 'application/vnd.rn-realmedia',
            rmvb: 'application/vnd.rn-realmedia-vbr', divx: 'video/divx', f4v: 'video/mp4', asf: 'video/x-ms-asf',
            mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
            wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg',
            flac: 'audio/flac', aiff: 'audio/aiff',
        };
        const inferredMimeType = inferredMimeTypes[extension];
        const genericMimeType = !safeMimeType || safeMimeType === 'application/octet-stream' || safeMimeType === 'binary/octet-stream';
        if (inferredMimeType && (genericMimeType || (inferredMimeType.startsWith('video/') && !safeMimeType.startsWith('video/')))) {
            safeMimeType = inferredMimeType;
        } else if (genericMimeType) {
            safeMimeType = 'audio/mpeg';
        }

        const isVideoContainer = safeMimeType.startsWith('video/');
        // Video containers > 2MB should be uploaded via Gemini File API so Gemini's preprocessor extracts 1 FPS frames + audio cleanly.
        // Sending larger video containers via base64 inlineData frequently triggers Gemini 500 INTERNAL errors.
        const MAX_INLINE_SIZE = isVideoContainer ? 2 * 1024 * 1024 : 15 * 1024 * 1024;
        if (audioFile.size <= MAX_INLINE_SIZE) {
            if (onProgress) onProgress(20);
            const base64 = await blobToBase64(audioFile);
            parts.push({
                inlineData: {
                    data: base64,
                    mimeType: safeMimeType,
                }
            });
            usedInline = true;
            if (onProgress) onProgress(40);
        } else {
            try {
                const fileUri = await uploadFileToGemini(audioFile, safeMimeType, keyToUse, onProgress);
                parts.push({
                    fileData: {
                        fileUri: fileUri,
                        mimeType: safeMimeType,
                    }
                });
            } catch (uploadErr) {
                console.warn('[SRT Generator] File API upload failed, delegating to multimodal chunked engine:', uploadErr);
                // Delegate to chunked engine (with allowSinglePassFallback = false to prevent infinite loop).
                // For video_audio mode, generateChunkedSRT extracts both 12kHz WAV audio + sampled JPEG video frames!
                try {
                    return await generateChunkedSRT(opts, knownDurationSec || 3600, genAI, keyToUse, false);
                } catch (chunkErr) {
                    console.warn('[SRT Generator] Chunked fallback encountered issue:', chunkErr);
                }
                // NEVER slice raw video containers (MP4/MOV/MKV/WebM) mid-file as inlineData because slicing corrupts the moov atom/index and causes a 500 server crash.
                if (isVideoContainer) {
                    throw new Error(`Video transcription upload failed: ${(uploadErr as any)?.message || 'Unable to upload or decode video container.'}`);
                }
                // Memory-safe compressed audio slice (up to 15MB inline data) for pure streamable audio files
                try {
                    console.warn('[SRT Generator] Using memory-safe audio slice inline fallback for audio transcription...');
                    const sliceBlob = audioFile.slice(0, Math.min(audioFile.size, 15 * 1024 * 1024));
                    const base64 = await blobToBase64(sliceBlob);
                    parts.push({
                        inlineData: {
                            data: base64,
                            mimeType: safeMimeType
                        }
                    });
                    usedInline = true;
                } catch (sliceErr) {
                    throw new Error(`Media transcription failed: ${(uploadErr as any)?.message || 'Upload failed'}. ${(sliceErr as any)?.message || ''}`);
                }
            }
        }
    } else {
        throw new Error("Please provide a media file or a YouTube URL.");
    }

    try {
        if (onProgress) onProgress(50);
        // Execute Pass 1 with 8192 maxOutputTokens and automatic multi-window continuation for long media (e.g. 38+ min)
        const mediaOnlyParts = parts.slice(1);
        const res1 = await callAudioTranscriptionModel(genAI, {
            contents: { parts },
            config: {
                temperature: 0.1,
                maxOutputTokens: 8192,
                systemInstruction: pass1Instruction,
            }
        });
        
        let pass1Srt = res1.text || "";
        if (pass1Srt.startsWith('```')) {
            pass1Srt = pass1Srt.replace(/^```[a-z]*\r?\n/, '').replace(/\r?\n```$/, '');
        }

        let pass1Blocks = parseRawBlocks(pass1Srt);
        if (pass1Blocks.length === 0) {
            return validateAndFixSRT(pass1Srt);
        }

        // Determine target duration in ms so we detect if Gemini stopped early (e.g. at 8-10 min of a 38-min file)
        let effectiveDurationSec = knownDurationSec;
        if (!effectiveDurationSec && audioFile) {
            try {
                effectiveDurationSec = await getMediaDuration(audioFile);
            } catch (_) {}
        }
        if (!effectiveDurationSec && youtubeUrl) {
            try {
                const details = await extractYouTubeMediaDetails(youtubeUrl);
                if (details?.duration) {
                    effectiveDurationSec = details.duration;
                }
            } catch (_) {}
        }
        if (!effectiveDurationSec && audioFile && audioFile.size > 0) {
            const lowerExt = (audioFile.name || '').toLowerCase();
            const bytesPerSec = lowerExt.endsWith('.wav') ? 176400 : 20480; // ~160kbps average for compressed audio
            effectiveDurationSec = Math.max(60, Math.round(audioFile.size / bytesPerSec));
            console.log(`[SRT Generator] Estimated duration: ${effectiveDurationSec}s (${(effectiveDurationSec / 60).toFixed(1)} min) for ${(audioFile.size / 1024 / 1024).toFixed(1)}MB media.`);
        }
        const targetDurationMs = effectiveDurationSec > 0 ? Math.round(effectiveDurationSec * 1000) : 0;

        // Multi-Pass Auto-Continuation Loop:
        // If Pass 1 stopped before the end of a long media file (or hit the ~8-10 minute single-turn generation window),
        // automatically continue transcribing from the last cue timestamp using the already-uploaded media part!
        const MAX_CONTINUATION_PASSES = 25;
        for (let contPass = 1; contPass <= MAX_CONTINUATION_PASSES; contPass++) {
            const lastBlock = pass1Blocks[pass1Blocks.length - 1];
            const lastEndMs = lastBlock ? lastBlock.endMs : 0;

            const needsContinuation = targetDurationMs > 0
                ? (lastEndMs < targetDurationMs - 3000)
                : (pass1Blocks.length >= 10 && lastEndMs > 0);

            if (!needsContinuation || mediaOnlyParts.length === 0) {
                break;
            }

            const resumeTs = msToTime(lastEndMs);
            const targetEndTs = targetDurationMs > 0 ? msToTime(targetDurationMs) : 'the very end of the media';
            console.log(`[SRT Generator] Auto-Continuation Pass #${contPass}: continuing from ${resumeTs} toward ${targetEndTs}...`);

            if (onProgress) {
                const pct = targetDurationMs > 0
                    ? Math.min(74, Math.round(50 + (lastEndMs / targetDurationMs) * 24))
                    : Math.min(74, 50 + contPass * 4);
                onProgress(pct);
            }

            // Gentle delay before continuation pass to respect rate limits
            await new Promise(resolve => setTimeout(resolve, 1200));

            const contInstruction = `${pass1Instruction}

CRITICAL FULL-TIMELINE CONTINUATION DIRECTIVE (PASS #${contPass + 1}):
- The previous transcription pass already covered from 00:00:00,000 up to ${resumeTs}.
- Last transcribed line ending at ${resumeTs}: "${lastBlock.textLines.join(' ')}"
- You MUST now CONTINUE transcribing strictly AFTER ${resumeTs} and proceed chronologically until ${targetEndTs}.
- DO NOT repeat any text or dialogue before ${resumeTs}.
- Output your very first subtitle block at the exact timestamp >= ${resumeTs} where the next speech, singing, or on-screen text appears.
- If there is an instrumental interlude, silence, or break after ${resumeTs}, do NOT stop! Advance forward across the timeline to where speech, singing, or on-screen text resumes and continue transcribing until ${targetEndTs}.
- Make sure to cover the FULL TIMELINE until ${targetEndTs}. Capture ALL text without stopping early.`;

            try {
                const contRes = await callAudioTranscriptionModel(genAI, {
                    contents: {
                        parts: [
                            { text: `Continue the SRT transcription strictly starting after timestamp ${resumeTs} through ${targetEndTs}. Transcribe all spoken dialogue, lyrics, and on-screen text across the full timeline until ${targetEndTs}.` },
                            ...mediaOnlyParts
                        ]
                    },
                    config: {
                        temperature: 0.1,
                        maxOutputTokens: 8192,
                        systemInstruction: contInstruction,
                    }
                });

                let contSrt = (contRes.text || "").trim();
                if (contSrt.startsWith('```')) {
                    contSrt = contSrt.replace(/^```[a-z]*\r?\n/, '').replace(/\r?\n```$/, '');
                }

                let contBlocks = parseRawBlocks(contSrt);
                if (contBlocks.length === 0) {
                    console.log(`[SRT Generator] Continuation pass #${contPass} returned 0 additional blocks. Finishing Pass 1.`);
                    break;
                }

                // If the model accidentally returned 0-based relative timestamps instead of timestamps >= lastEndMs, shift them
                if (lastEndMs > 60000 && contBlocks[0].startMs < lastEndMs * 0.4) {
                    contBlocks = contBlocks.map(b => {
                        const startMs = b.startMs + lastEndMs;
                        const endMs = b.endMs + lastEndMs;
                        return {
                            startMs,
                            endMs,
                            startTs: msToTime(startMs),
                            endTs: msToTime(endMs),
                            textLines: b.textLines
                        };
                    });
                }

                const prevEndMs = lastEndMs;
                pass1Blocks = deduplicateAndMergeBlocks(pass1Blocks, contBlocks, Math.max(0, lastEndMs - 5000));
                const newLastEndMs = pass1Blocks[pass1Blocks.length - 1]?.endMs || prevEndMs;

                // If timeline did not advance by at least 1.0 second, we have reached the end of all dialogue/text
                if (newLastEndMs - prevEndMs < 1000) {
                    console.log(`[SRT Generator] Continuation pass #${contPass} reached end of speech at ${msToTime(newLastEndMs)}.`);
                    break;
                }
            } catch (contErr) {
                console.warn(`[SRT Generator] Continuation pass #${contPass} encountered an error, preserving ${pass1Blocks.length} transcribed blocks:`, contErr);
                break;
            }
        }

        // Stage 1 Lock: Clean and lock original native timestamps BEFORE Stage 2 Mode/Style adjustment
        pass1Blocks = lockStage1NativeBlocks(pass1Blocks);

        // Stage 2: Adjust Style Format / Subtitle Mode & Visual Styling while keeping 100% of original Stage 1 timestamps
        if (onProgress) onProgress(75);
        pass1Blocks = await translateCuesById(pass1Blocks, opts, genAI, onProgress);
        if (onProgress) onProgress(95);
        return reconstructSRT(pass1Blocks);

    } catch (e: any) {
        // Log as warning here so outer generateSRT fallback can recover without triggering console.error monitors prematurely
        console.warn("[SRT Generator] Single-pass attempt notice:", e?.message || e);
        throw e;
    }
}

/**
 * Generates subtitle SRT for a YouTube video:
 * 1. Checks authentic YouTube Closed Captions (CC) via backend caption service (/api/youtube/captions).
 * 2. If authentic CC exists: preserves exact millisecond timecodes (and translates/formats with strict timing locks if requested).
 * 3. If authentic CC is unavailable on YouTube (e.g. video only has burned-in subs or no CC uploaded):
 *    seamlessly activates Gemini Multimodal Audio Transcription by streaming the audio track into memory
 *    and analyzing authentic acoustic speech onsets/offsets (SOURCE = GEMINI MEDIA TRANSCRIPTION).
 */
export async function generateYouTubeSRT(
    youtubeUrl: string,
    opts: Partial<GenerateSrtOptions> = {}
): Promise<string> {
    const keyToUse = getEffectiveGeminiApiKey(opts.apiKey);
    const genAI = getGenAI(keyToUse);
    const { onProgress, mode = 'ori', targetLang = 'English', sourceLang } = opts;

    if (onProgress) onProgress(15);

    const { videoId } = normalizeYoutubeUrl(youtubeUrl);
    const cleanUrl = videoId ? `https://www.youtube.com/watch?v=${videoId}` : youtubeUrl;

    // STEP 1: Backend Structured Caption Retrieval Service
    try {
        if (onProgress) onProgress(25);
        const captionRes = await fetchYouTubeCaptions(cleanUrl, targetLang);

        if (captionRes.success && captionRes.source === 'youtube_cc' && captionRes.segments && captionRes.segments.length > 0) {
            console.log(`[YouTube Captions] Retrieved ${captionRes.segments.length} authentic CC segments from YouTube:`, captionRes.language);

            // Stage 1: Lock authentic YouTube CC native cues & timestamps
            const rawSrt = captionRes.rawSrt || segmentsToSrt(captionRes.segments);
            let stage1Blocks = lockStage1NativeBlocks(parseRawBlocks(rawSrt));

            // Stage 2: Apply Style Format / Subtitle Mode & Visual Styling while keeping 100% of original timestamps
            if (onProgress) onProgress(65);
            const stage2Blocks = await translateCuesById(
                stage1Blocks,
                { ...opts, mode, targetLang, sourceLang },
                genAI,
                onProgress
            );
            if (onProgress) onProgress(100);
            return reconstructSRT(stage2Blocks);
        }

        if (captionRes.requiresTranscription || captionRes.source === 'unavailable') {
            console.log(`[YouTube Captions] Authentic YouTube CC is unavailable for ${videoId}. Reason: ${captionRes.reason}. Activating Gemini Multimodal Audio Transcription...`);
        }
    } catch (captionServiceErr) {
        console.warn('[YouTube Captions] Backend caption service notice:', captionServiceErr);
    }

    // STEP 2: Direct Gemini Multimodal YouTube URL Transcription Fallback
    // Gemini 2.5 Flash natively ingests public YouTube URLs via fileData without requiring server-side stream downloading
    try {
        if (onProgress) onProgress(40);
        console.log(`[Gemini Native YouTube Transcription] Analyzing YouTube video ${cleanUrl} directly with Gemini multimodal...`);
        const directSrt = await generateSinglePassSRT(
            {
                ...opts,
                youtubeUrl: cleanUrl,
                audioFile: null,
                mode,
                targetLang,
                sourceLang,
                onProgress: (p) => {
                    if (onProgress) onProgress(Math.min(98, Math.max(40, p)));
                }
            },
            'video/mp4',
            opts.processingMode !== 'audio',
            genAI,
            keyToUse
        );
        if (directSrt && parseSubtitles(directSrt).length > 0) {
            if (onProgress) onProgress(100);
            return directSrt;
        }
    } catch (directYtErr) {
        console.warn('[Gemini Native YouTube Transcription] Direct YouTube fileUri pass failed, falling back to audio stream download:', directYtErr);
    }

    // STEP 2B: Legitimate Multimodal Audio Stream Transcription Fallback
    // When authentic CC is not uploaded on YouTube, stream the media audio so Gemini generates genuine acoustic timecodes
    try {
        if (onProgress) onProgress(45);
        console.log(`[Gemini Media Transcription] Streaming audio for video ${videoId} to perform acoustic waveform transcription...`);

        const mediaFile = await downloadYouTubeMediaStream(cleanUrl, 'audio', (p) => {
            if (onProgress) onProgress(Math.min(75, 40 + Math.round(p.percent * 0.35)));
        });

        if (mediaFile && mediaFile.size > 0) {
            console.log(`[Gemini Media Transcription] Audio stream acquired (${(mediaFile.size / (1024 * 1024)).toFixed(2)} MB). Running Gemini audio transcription...`);
            return await generateSRT({
                ...opts,
                audioFile: mediaFile,
                youtubeUrl: null,
                processingMode: 'audio',
                onProgress: (p) => {
                    if (onProgress) onProgress(Math.min(98, 75 + Math.round(p * 0.23)));
                }
            });
        }
    } catch (streamErr: any) {
        console.warn('[Gemini Media Transcription] Direct audio stream transcription encountered an error:', streamErr);
    }

    // STEP 3: Fallback Error with Clear Guidance & Structured Diagnostics
    const structuredErr: any = new Error(
        `Authentic YouTube Closed Captions (CC) are not uploaded for this video (ID: ${videoId || 'unknown'}).\n\n` +
        `To generate accurately timed subtitles, you can:\n` +
        `1. Use "Fetch & Convert" or 1-Click Downloader to load the audio file for Gemini Multimodal Analysis.\n` +
        `2. Play the video in Timeline Editor and manually sync speech cues.`
    );
    structuredErr.code = 'CAPTIONS_NOT_AVAILABLE';
    structuredErr.videoId = videoId;
    structuredErr.requiresTranscription = true;
    throw structuredErr;
}

export async function generateSRT(
    fileOrOptions: File | GenerateSrtOptions,
    legacyMode?: 'ori' | 'dual' | 'dual_trans' | 'triple' | 'quad',
    legacyTargetLang?: string,
    legacyApiKey?: string,
    legacyOnProgressOrStyling?: any,
    legacyProcessingMode?: 'audio' | 'video_audio',
    legacyResumeOrProgress?: any,
    legacyResumeTime?: string,
    legacySourceLang?: string
): Promise<string> {
    let opts: GenerateSrtOptions;
    if (fileOrOptions instanceof File) {
        let onProgress: ((p: number) => void) | undefined = undefined;
        let styling = 'none';
        if (typeof legacyOnProgressOrStyling === 'function') {
            onProgress = legacyOnProgressOrStyling;
        } else if (typeof legacyOnProgressOrStyling === 'string') {
            styling = legacyOnProgressOrStyling;
        }
        
        let resumeTime = legacyResumeTime;
        if (typeof legacyResumeOrProgress === 'string') {
            resumeTime = legacyResumeOrProgress;
        } else if (typeof legacyResumeOrProgress === 'function') {
            onProgress = legacyResumeOrProgress;
        }

        opts = {
            audioFile: fileOrOptions,
            mode: legacyMode || 'ori',
            targetLang: legacyTargetLang || 'Original',
            apiKey: legacyApiKey,
            styling,
            processingMode: legacyProcessingMode || 'video_audio',
            onProgress,
            resumeTime,
            sourceLang: legacySourceLang
        };
    } else {
        opts = fileOrOptions;
    }

    const {
        audioFile,
        youtubeUrl,
        apiKey,
        processingMode = 'video_audio',
        resumeTime
    } = opts;

    if (!audioFile && !youtubeUrl) {
        throw new Error("Please upload a media file or provide a YouTube URL.");
    }

    const keyToUse = getEffectiveGeminiApiKey(apiKey);
    const genAI = getGenAI(keyToUse);

    if (youtubeUrl && !audioFile) {
        if (processingMode === 'youtube_transcript') {
            return await generateYouTubeSRT(youtubeUrl, opts);
        }
        
        let ytDuration = opts.knownDurationSec || 0;
        if (!ytDuration) {
            try {
                const details = await extractYouTubeMediaDetails(youtubeUrl);
                if (details?.duration) ytDuration = details.duration;
            } catch (_) {}
        }

        try {
            // Multimodal Watch & Listen or Listen Only for YouTube
            const isVideoMode = processingMode === 'video_audio';
            return await generateSinglePassSRT(opts, 'video/mp4', isVideoMode, genAI, keyToUse, ytDuration);
        } catch (ytErr) {
            console.warn('[SRT Generator] Direct YouTube stream transcription encountered an error, falling back to Web Search Grounding / Transcript extraction:', ytErr);
            return await generateYouTubeSRT(youtubeUrl, opts);
        }
    }
    
    let safeMimeType = audioFile ? (audioFile.type || '') : 'audio/mpeg';
    const lowerName = (audioFile?.name || '').toLowerCase();
    const extensionMimeTypes: Record<string, string> = {
        mp4: 'video/mp4',
        m4v: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm',
        ogv: 'video/ogg',
        mkv: 'video/x-matroska',
        avi: 'video/x-msvideo',
        mpeg: 'video/mpeg',
        mpg: 'video/mpeg',
        '3gp': 'video/3gpp',
        ts: 'video/mp2t',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        opus: 'audio/ogg',
        flac: 'audio/flac',
        aiff: 'audio/aiff',
    };
    const extension = lowerName.split('.').pop() || '';
    const inferredMimeType = extensionMimeTypes[extension];
    const genericMimeType = !safeMimeType || safeMimeType === 'application/octet-stream' || safeMimeType === 'binary/octet-stream';
    const extensionIndicatesVideo = Boolean(inferredMimeType?.startsWith('video/'));
    if (inferredMimeType && (genericMimeType || (extensionIndicatesVideo && !safeMimeType.startsWith('video/')))) {
        safeMimeType = inferredMimeType;
    } else if (genericMimeType) {
        safeMimeType = 'audio/mpeg';
    }

    // Keep the input as a video container for Gemini, but change the instructions by mode:
    // Listen Only must attend to its embedded soundtrack and ignore frames; Watch & Listen may
    // use both soundtrack and visual frames. This avoids falsely labeling a video as audio/*.
    const isVideoSource = safeMimeType.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|mkv|avi|flv|wmv|mpeg|mpg|mpe|3gp|3g2|ts|m2ts|mts|mxf|vob|rm|rmvb|divx|f4v|asf)$/i.test(lowerName);
    const isVideo = isVideoSource && processingMode === 'video_audio';

    let rawSRT = "";
    try {
        const mediaDuration = await getMediaDuration(audioFile);

        const hasPersonalKey = isRealGeminiKey(keyToUse);
        const requiresChunkedForBuiltInKey = Boolean(isVideo && audioFile && audioFile.size > 2 * 1024 * 1024 && !hasPersonalKey);
        const shouldChunk = requiresChunkedForBuiltInKey || (!isVideo && (mediaDuration > 75 || audioFile.size > 3 * 1024 * 1024 || (mediaDuration === 0 && audioFile.size > 1024 * 1024)));

        if (shouldChunk) {
            try {
                console.log(`[SRT Generator] Activating Multimodal Anti-Drift Chunking Engine (duration: ${Math.round(mediaDuration)}s, size: ${(audioFile.size / (1024 * 1024)).toFixed(1)}MB, mode: ${processingMode}).`);
                rawSRT = await generateChunkedSRT(opts, mediaDuration || 3600, genAI, keyToUse, true);
            } catch (chunkErr) {
                console.warn('[SRT Generator] Chunked generation failed, attempting multi-pass cloud fallback:', chunkErr);
                rawSRT = await generateSinglePassSRT(opts, safeMimeType, isVideo, genAI, keyToUse, mediaDuration);
            }
        } else {
            try {
                console.log(`[SRT Generator] Using Cloud Gemini File API with full-timeline multi-pass continuation (size: ${(audioFile.size / (1024 * 1024)).toFixed(1)}MB, mode: ${processingMode}).`);
                rawSRT = await generateSinglePassSRT(opts, safeMimeType, isVideo, genAI, keyToUse, mediaDuration);
            } catch (singleErr: any) {
                const errMsg = (singleErr?.message || '') + JSON.stringify(singleErr || '');
                console.warn(`[SRT Generator] Single-pass video/audio pass encountered error (${errMsg.slice(0, 140)}). Falling back to Multimodal WAV + Sampled Video Frames Chunked Engine...`);
                if (audioFile) {
                    try {
                        rawSRT = await generateChunkedSRT(opts, mediaDuration || 3600, genAI, keyToUse, false);
                    } catch (fallbackErr: any) {
                        console.warn('[SRT Generator] Multimodal chunked fallback also failed:', fallbackErr);
                        throw singleErr;
                    }
                } else {
                    throw singleErr;
                }
            }
        }

        // Stage 1 already locked all native timestamps via lockStage1NativeBlocks,
        // and Stage 2 adjusted only the text lines for the chosen Style Format / Mode.
        // Return rawSRT directly so post-Stage-2 multi-line blocks are NEVER re-split or re-timed!
        return rawSRT;
    } catch (e: any) {
        console.warn("[SRT Generator] SRT generation notice:", e?.message || e);
        throw e;
    }
}

// --- WAV Encoding and Audio Slicing for Instant Vocal Alignment ---

function encodeWAV(samples: Float32Array, sampleRate: number): Blob {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    function writeString(offset: number, str: string) {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    }

    /* RIFF identifier */
    writeString(0, 'RIFF');
    /* file length */
    view.setUint32(4, 36 + samples.length * 2, true);
    /* RIFF type */
    writeString(8, 'WAVE');
    /* format chunk identifier */
    writeString(12, 'fmt ');
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (raw PCM) */
    view.setUint16(20, 1, true);
    /* channel count (1 for mono) */
    view.setUint16(22, 1, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * 2, true);
    /* block align (channel count * bytes per sample) */
    view.setUint16(32, 2, true);
    /* bits per sample */
    view.setUint16(34, 16, true);
    /* data chunk identifier */
    writeString(36, 'data');
    /* data chunk length */
    view.setUint32(40, samples.length * 2, true);

    // Float32 to Int16
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([view], { type: 'audio/wav' });
}

export async function decodeAudioBufferFromFile(file: File): Promise<{ audioBuffer: AudioBuffer; duration: number }> {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) {
        throw new Error('AudioContext is not supported in this browser environment');
    }

    const isVideoFile = (file.type || '').startsWith('video/') ||
        /\.(mp4|m4v|mov|webm|ogv|mkv|avi|flv|wmv|mpeg|mpg|mpe|3gp|3g2|ts|m2ts|mts)$/i.test(file.name || '');
    const maxDecodeBytes = isVideoFile ? 250 * 1024 * 1024 : 180 * 1024 * 1024;

    if (file.size > maxDecodeBytes) {
        throw new Error(`Media file (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds browser in-memory decode threshold (${Math.round(maxDecodeBytes / (1024 * 1024))}MB).`);
    }

    const arrayBuffer = await file.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error('Media file buffer is empty (0 bytes)');
    }

    // Use 16kHz sampleRate when supported to reduce PCM memory footprint by 3x (67% less RAM on 80MB+ / 38-min files)
    let audioCtx: AudioContext;
    try {
        audioCtx = new AudioContextClass({ sampleRate: 16000 });
    } catch {
        audioCtx = new AudioContextClass();
    }
    try {
        let audioBuffer: AudioBuffer | null = null;
        let lastError: any = null;

        // Try standard modern Promise-based decodeAudioData first with safe catch
        try {
            audioBuffer = await new Promise<AudioBuffer | null>((resolve) => {
                let settled = false;
                try {
                    const ret = audioCtx.decodeAudioData(
                        arrayBuffer,
                        (decoded) => {
                            if (!settled) { settled = true; resolve(decoded); }
                        },
                        (err) => {
                            lastError = err;
                            if (!settled) { settled = true; resolve(null); }
                        }
                    );
                    if (ret && typeof ret.then === 'function') {
                        ret.then((decoded) => {
                            if (!settled) { settled = true; resolve(decoded); }
                        }).catch((err) => {
                            lastError = err;
                            if (!settled) { settled = true; resolve(null); }
                        });
                    }
                } catch (e) {
                    lastError = e;
                    if (!settled) { settled = true; resolve(null); }
                }
            });
        } catch (promiseErr) {
            lastError = promiseErr;
        }

        if (!audioBuffer) {
            const isVideo = (file.type || '').startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(file.name || '');
            const msg = isVideo
                ? `Video container (${file.type || 'video'}) cannot be decoded into Web Audio Buffer. Direct multimodal processing will be used.`
                : (lastError?.message || 'Unable to decode audio data');
            const err = new Error(msg);
            (err as any).name = 'AudioDecodeError';
            (err as any).isContainerIssue = isVideo;
            throw err;
        }

        return { audioBuffer, duration: audioBuffer.duration };
    } finally {
        try {
            await audioCtx.close();
        } catch (_) {}
    }
}

export function extractWavSliceFromBuffer(
    audioBuffer: AudioBuffer,
    startSec: number,
    durationSec: number,
    targetSampleRate = 16000
): { wavBlob: Blob; actualStartSec: number; actualDurationSec: number } {
    const actualStartSec = Math.max(0, startSec);
    const actualEndSec = Math.min(audioBuffer.duration, actualStartSec + durationSec);
    const actualDurationSec = Math.max(0.1, actualEndSec - actualStartSec);

    const numChannels = audioBuffer.numberOfChannels;
    const sourceSampleRate = audioBuffer.sampleRate;
    const startSample = Math.floor(actualStartSec * sourceSampleRate);
    const endSample = Math.floor(actualEndSec * sourceSampleRate);
    const lengthSamples = Math.max(1, endSample - startSample);

    // Mix down to mono
    const mono = new Float32Array(lengthSamples);
    for (let c = 0; c < numChannels; c++) {
        const channelData = audioBuffer.getChannelData(c);
        for (let i = 0; i < lengthSamples; i++) {
            mono[i] += (channelData[startSample + i] || 0) / numChannels;
        }
    }

    // Resample down to targetSampleRate (16kHz) for ultra-compact payload
    const ratio = sourceSampleRate / targetSampleRate;
    const newLength = Math.max(1, Math.floor(lengthSamples / ratio));
    const resampled = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
        const originalIndex = Math.floor(i * ratio);
        resampled[i] = mono[originalIndex] || 0;
    }

    const wavBlob = encodeWAV(resampled, targetSampleRate);
    return { wavBlob, actualStartSec, actualDurationSec };
}

export async function sliceAudioFileToWav(
    file: File,
    startSec: number,
    durationSec: number,
    targetSampleRate = 16000
): Promise<{ wavBlob: Blob; actualStartSec: number; actualDurationSec: number }> {
    const { audioBuffer } = await decodeAudioBufferFromFile(file);
    return extractWavSliceFromBuffer(audioBuffer, startSec, durationSec, targetSampleRate);
}

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(',')[1] || '';
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function extractJsonPayload(text: string): any {
    let clean = text.trim();
    if (clean.startsWith('```')) {
        clean = clean.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    const firstBrace = clean.indexOf('{');
    const firstBracket = clean.indexOf('[');
    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        const lastBrace = clean.lastIndexOf('}');
        if (lastBrace !== -1) {
            clean = clean.substring(firstBrace, lastBrace + 1);
        }
    } else if (firstBracket !== -1) {
        const lastBracket = clean.lastIndexOf(']');
        if (lastBracket !== -1) {
            clean = clean.substring(firstBracket, lastBracket + 1);
        }
    }
    return JSON.parse(clean);
}

// --- Gemini AI Semantic Alignment Interfaces ---

export interface AiAlignSingleResult {
    id: string;
    newStart: number;
    newEnd: number;
    found: boolean;
    confidence?: number;
    message: string;
}

export interface AiAlignAllResult {
    updatedBlocks: { id: string; text: string; start: number; end: number; isLocked?: boolean }[];
    alignedCount: number;
    message: string;
}

/**
 * Aligns a single subtitle block to the human vocals using Gemini speech recognition.
 * Slices a focused 15-second audio window around the block to achieve near-instant AI analysis.
 */
export const alignSingleBlockWithGemini = async (
    audioFile: File,
    block: { id: string; text: string; start: number; end: number },
    context?: { prevText?: string; nextText?: string },
    apiKey?: string
): Promise<AiAlignSingleResult> => {
    const keyToUse = getEffectiveGeminiApiKey(apiKey);
    if (!keyToUse) {
        throw new Error("No Gemini API key found. Please configure your API key in Settings.");
    }
    const genAI = getGenAI(keyToUse);

    const blockDurationSec = Math.max(1, (block.end - block.start) / 1000);
    // Slice 6 seconds before start and 6 seconds after end to ensure full vocal capture
    const prePadSec = 6;
    const postPadSec = 6;
    const sliceStartSec = Math.max(0, (block.start / 1000) - prePadSec);
    const sliceDurationSec = blockDurationSec + prePadSec + postPadSec;

    let audioPart: any = null;
    let actualStartOffsetSec = sliceStartSec;

    try {
        // Attempt fast browser audio slicing
        const { wavBlob, actualStartSec } = await sliceAudioFileToWav(audioFile, sliceStartSec, sliceDurationSec);
        actualStartOffsetSec = actualStartSec;
        const base64Wav = await blobToBase64(wavBlob);
        audioPart = {
            inlineData: {
                data: base64Wav,
                mimeType: 'audio/wav'
            }
        };
    } catch (sliceErr) {
        console.warn("Fast audio slice failed on media container, falling back to direct file inline buffer:", sliceErr);
        const sliceBlob = audioFile.size > 14 * 1024 * 1024 ? audioFile.slice(0, 14 * 1024 * 1024) : audioFile;
        const base64 = await blobToBase64(sliceBlob);
        audioPart = {
            inlineData: {
                data: base64,
                mimeType: audioFile.type || 'audio/mpeg'
            }
        };
        actualStartOffsetSec = 0; // Relative to whole file
    }

    const systemInstruction = `You are a world-class speech and lyric forced-alignment AI.
Your ONLY mission is to detect the exact human vocal onset and vocal ending of the requested lyric/dialogue line.

CRITICAL INSTRUCTIONS:
1. FOCUS STRICTLY ON HUMAN VOCALS / VOICE: Disregard drums, 808 sub-bass, synthesizers, guitars, and background instruments. Do not trigger on drum kicks.
2. TIMESTAMPS: Return the exact start and end millisecond timestamps relative to the beginning of the provided audio clip (0 ms = start of the clip).
3. IF DETECTED: Set "found": true, with "relativeStartMs" and "relativeEndMs" covering the spoken/sung syllables.
4. IF INAUDIBLE / NOT IN CLIP: If the vocals for this line are not sung in this clip (e.g. pure instrumental solo), set "found": false with your best estimate.
5. FORMAT: Return ONLY valid JSON matching this schema:
{
  "found": boolean,
  "relativeStartMs": number,
  "relativeEndMs": number,
  "confidence": number
}`;

    const promptText = `Target Subtitle to Align: "${block.text}"
Audio slice offset: starts at ${actualStartOffsetSec.toFixed(2)}s in the full song.
Approximate expected timing in this clip: around ${Math.max(0, Math.round((block.start - actualStartOffsetSec * 1000)))}ms to ${Math.max(500, Math.round((block.end - actualStartOffsetSec * 1000)))}ms.
${context?.prevText ? `Previous lyric line: "${context.prevText}"` : ''}
${context?.nextText ? `Next lyric line: "${context.nextText}"` : ''}

Listen to the vocal track, locate where "${block.text}" is sung/spoken, and return the precise relative millisecond boundaries.`;

    const response = await callAudioTranscriptionModel(genAI, {
        contents: {
            parts: [audioPart, { text: promptText }]
        },
        config: {
            temperature: 0.1,
            systemInstruction
        }
    });

    const parsed = extractJsonPayload(response.text || '{}');
    
    if (parsed && typeof parsed.relativeStartMs === 'number') {
        const computedStart = Math.max(0, Math.round(actualStartOffsetSec * 1000 + parsed.relativeStartMs));
        let computedEnd = Math.max(computedStart + 300, Math.round(actualStartOffsetSec * 1000 + (parsed.relativeEndMs || (parsed.relativeStartMs + 2000))));
        
        // Guard against runaway lengths
        if (computedEnd <= computedStart) {
            computedEnd = computedStart + 1500;
        }

        const duration = ((computedEnd - computedStart) / 1000).toFixed(2);
        return {
            id: block.id,
            newStart: computedStart,
            newEnd: computedEnd,
            found: parsed.found !== false,
            confidence: parsed.confidence || 0.9,
            message: parsed.found !== false 
                ? `AI aligned block to vocal phrase (${duration}s duration).`
                : `AI estimated boundary (${duration}s) - low vocal certainty.`
        };
    }

    throw new Error("Could not parse timing from Gemini response");
};

/**
 * Batch aligns all subtitle blocks against the human vocals in the entire audio/video file.
 * Preserves user text and block IDs while accurately relocating timestamps to speech phonemes.
 */
export const alignAllSubtitlesWithGemini = async (
    audioFile: File,
    blocks: { id: string; text: string; start: number; end: number; isLocked?: boolean }[],
    apiKey?: string,
    onProgress?: (progress: number, statusText?: string) => void
): Promise<AiAlignAllResult> => {
    const keyToUse = getEffectiveGeminiApiKey(apiKey);
    if (!keyToUse) {
        throw new Error("No Gemini API key found. Please configure your API key in Settings.");
    }
    const genAI = getGenAI(keyToUse);

    if (blocks.length === 0) {
        return { updatedBlocks: [], alignedCount: 0, message: "No blocks to align." };
    }

    if (onProgress) onProgress(15, "Preparing audio for Gemini Vocal Recognition...");

    let safeMimeType = audioFile.type || 'audio/mpeg';
    let audioPart: any = null;
    const MAX_INLINE_SIZE = 15 * 1024 * 1024;

    if (audioFile.size <= MAX_INLINE_SIZE) {
        const base64 = await blobToBase64(audioFile);
        audioPart = {
            inlineData: {
                data: base64,
                mimeType: safeMimeType
            }
        };
        if (onProgress) onProgress(40, "Media loaded in memory. Analyzing vocal stems...");
    } else {
        try {
            if (onProgress) onProgress(25, "Uploading media file to Gemini Cloud...");
            const fileUri = await uploadFileToGemini(audioFile, safeMimeType, keyToUse, (p) => {
                if (onProgress) onProgress(Math.round(25 + p * 0.35), "Uploading audio track...");
            });
            audioPart = {
                fileData: {
                    fileUri,
                    mimeType: safeMimeType
                }
            };
        } catch (uploadErr) {
            console.warn("[SRT Alignment] Cloud upload failed, trying audio slice or inline fallback:", uploadErr);
            let inlined = false;
            try {
                const { audioBuffer } = await decodeAudioBufferFromFile(audioFile);
                const { wavBlob } = extractWavSliceFromBuffer(audioBuffer, 0, Math.min(audioBuffer.duration, 300), 16000);
                const base64 = await blobToBase64(wavBlob);
                audioPart = {
                    inlineData: {
                        data: base64,
                        mimeType: 'audio/wav'
                    }
                };
                inlined = true;
            } catch (decodeErr) {
                console.warn("[SRT Alignment] Audio decoding failed on container (likely video file). Falling back to direct inline media transmission:", decodeErr);
            }

            if (!inlined) {
                const sliceBlob = audioFile.size > 14 * 1024 * 1024 ? audioFile.slice(0, 14 * 1024 * 1024) : audioFile;
                const base64 = await blobToBase64(sliceBlob);
                audioPart = {
                    inlineData: {
                        data: base64,
                        mimeType: safeMimeType
                    }
                };
            }
        }
        if (onProgress) onProgress(65, "Media ready. Recognizing speech & singing phonemes...");
    }

    const systemInstruction = `You are a professional audio forced-alignment engine and speech recognition subtitler.
You will be provided an audio/video track and an array of subtitle blocks (with existing text and approximate timestamps).

CRITICAL DIRECTIVES:
1. "HEAR" HUMAN SPEECH & SINGING: Strictly isolate human vocals. Ignore all drums, percussive transients, 808 kicks, synth drops, guitars, and background instruments. Do not trigger or shift on instrumental beats.
2. PRESERVE ORIGINAL TEXT & BLOCK IDS: Do not alter, translate, spell-correct, or omit the text. Keep each block's exact "id".
3. PRECISE VOCAL BOUNDARIES: For every block, determine the precise millisecond timestamps (startMs and endMs) where the lyrics/dialogue are vocalized.
4. ORDER & NON-OVERLAPPING: Maintain strict chronological order: startMs < endMs. Blocks should not overlap unnaturally.
5. LOCKED BLOCKS: If a block has "isLocked": true, you MUST keep its existing approxStartMs and approxEndMs completely unchanged.
6. OUTPUT FORMAT: Respond ONLY with a valid JSON array of objects. No markdown formatting, no explanations.
JSON schema:
[
  { "id": "string", "startMs": number, "endMs": number }
]`;

    const blocksPayload = blocks.map(b => ({
        id: b.id,
        text: b.text,
        approxStartMs: Math.round(b.start),
        approxEndMs: Math.round(b.end),
        isLocked: !!b.isLocked
    }));

    const promptText = `Here is the ordered list of ${blocks.length} subtitle blocks to align to the human vocals in this track:
${JSON.stringify(blocksPayload, null, 2)}

Listen to the audio, locate each vocal phrase in the song, and return the exact startMs and endMs for each id. Return ONLY the JSON array.`;

    if (onProgress) onProgress(80, "Gemini is aligning subtitle boundaries to voice...");

    const response = await callAudioTranscriptionModel(genAI, {
        contents: {
            parts: [audioPart, { text: promptText }]
        },
        config: {
            temperature: 0.1,
            systemInstruction
        }
    });

    if (onProgress) onProgress(95, "Parsing aligned timing results...");

    const parsedArray = extractJsonPayload(response.text || '[]');
    if (!Array.isArray(parsedArray)) {
        throw new Error("Invalid response format from Gemini alignment engine");
    }

    const timingMap = new Map<string, { startMs: number; endMs: number }>();
    for (const item of parsedArray) {
        if (item && item.id && typeof item.startMs === 'number' && typeof item.endMs === 'number') {
            timingMap.set(item.id, {
                startMs: Math.max(0, Math.round(item.startMs)),
                endMs: Math.max(Math.round(item.startMs) + 300, Math.round(item.endMs))
            });
        }
    }

    let alignedCount = 0;
    const updatedBlocks = blocks.map(block => {
        if (block.isLocked) return block;
        const newTiming = timingMap.get(block.id);
        if (newTiming) {
            alignedCount++;
            return {
                ...block,
                start: newTiming.startMs,
                end: newTiming.endMs
            };
        }
        return block;
    }).sort((a, b) => a.start - b.start);

    return {
        updatedBlocks,
        alignedCount,
        message: `Successfully aligned ${alignedCount} subtitle block${alignedCount > 1 ? 's' : ''} to human vocals using Gemini AI.`
    };
};