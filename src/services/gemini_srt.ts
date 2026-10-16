import { GoogleGenAI } from "@google/genai";
import { getCurrentTextModel, callTextModel, withRetry, getGenAI, getEffectiveGeminiApiKey } from "./gemini";
import { normalizeYoutubeUrl, extractYouTubeMediaDetails, fetchNativeYouTubeSubtitlesContent, fetchYouTubeCaptions, downloadYouTubeMediaStream } from "./youtube";
import { parseSubtitles, generateSrt, SubtitleBlock, splitOversizedBlocks } from "../utils/subtitleParser";
import { segmentsToSrt } from "./youtubeCaptionService";

// Candidate multimodal Gemini models for audio transcription in order of reliability
const AUDIO_CANDIDATE_MODELS = [
    'gemini-3.5-transcribe',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-2.5-flash'
];

/**
 * Call Gemini generation with auto-fallback for audio transcription.
 * If the active model is non-multimodal (e.g. Kie/OpenAI text model) or fails with 403/404,
 * it tries standard Gemini Flash multimodal models.
 */
export async function callAudioTranscriptionModel(
    genAI: GoogleGenAI,
    request: any
): Promise<any> {
    const rawSelectedModel = getCurrentTextModel();
    let initialModel = rawSelectedModel;
    
    // If the currently selected text model is a Kie/OpenAI text model, default to gemini-2.5-flash
    if (typeof initialModel === 'string' && (initialModel.startsWith('kie:') || initialModel === 'custom-openai')) {
        initialModel = 'gemini-2.5-flash';
    }

    const modelsToTry = [
        initialModel,
        ...AUDIO_CANDIDATE_MODELS.filter(m => m !== initialModel)
    ];

    let lastError: any = null;

    for (const model of modelsToTry) {
        try {
            const req = { ...request, model };
            return await withRetry(() => genAI.models.generateContent(req), 1);
        } catch (err: any) {
            lastError = err;
            const msg = (err?.message || '') + JSON.stringify(err || '');
            const is403 = err?.status === 403 || msg.includes('403') || msg.includes('PERMISSION_DENIED') || msg.includes('does not have permission');
            const is404 = err?.status === 404 || msg.includes('404') || msg.includes('NOT_FOUND') || msg.includes('not found') || msg.includes('is not found');
            
            if (is403 || is404) {
                console.warn(`[SRT Generator] Model "${model}" hit ${is403 ? '403 Permission Denied' : '404 Not Found'}. Trying fallback model...`);
                continue;
            }
            throw err;
        }
    }

    throw lastError || new Error("Permission Denied (403). Your API key does not have permission for the requested model. Please check your Gemini API key in Settings -> API Settings Vault.");
}

// Helper function to parse and fix a timestamp string (e.g. "01:09:50,500" or "01:00,000" or "00:01:23.456")
function fixTimestamp(ts: string): string {
    ts = ts.trim();
    
    // Case 1: MM:SS,mmm or MM:SS.mmm or M:SS,mmm (missing hour prefix)
    const mmssMatch = ts.match(/^(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (mmssMatch) {
        const [_, m, s, ms] = mmssMatch;
        return `00:${m.padStart(2, '0')}:${s.padStart(2, '0')},${ms.padEnd(3, '0').slice(0, 3)}`;
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
        try {
            const isVideo = file.type.includes('video') || file.name.endsWith('.mp4') || file.name.endsWith('.webm') || file.name.endsWith('.mov');
            const element = document.createElement(isVideo ? 'video' : 'audio');
            element.preload = 'metadata';
            const url = URL.createObjectURL(file);
            element.onloadedmetadata = () => {
                const dur = element.duration;
                URL.revokeObjectURL(url);
                resolve(dur && !isNaN(dur) && isFinite(dur) ? dur : 0);
            };
            element.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(0);
            };
            element.src = url;
        } catch {
            resolve(0);
        }
    });
}

async function uploadFileToGemini(file: File, mimeType: string, apiKey: string, onProgress?: (p: number) => void): Promise<string> {
    const ai = getGenAI(apiKey);
    
    if (onProgress) onProgress(20);
    
    // The official SDK handles chunking, resumable protocol, and headers automatically
    const uploadRes = await ai.files.upload({
        file: file,
        config: {
            mimeType: mimeType,
            displayName: file.name ? file.name.replace(/[^a-zA-Z0-9_\-\.]/g, '') : 'upload'
        }
    });
    
    if (onProgress) onProgress(50);
    
    const name = uploadRes.name.split('/files/')[1] || uploadRes.name;
    
    // Wait for processing
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

        // Check if this cue's text duplicates any of the last few existing cues
        const incNorm = normalizeTextForMatch(inc.textLines.join(' '));
        if (!incNorm) continue;

        const recentBlocks = result.slice(-8);
        const matchIdx = recentBlocks.findIndex(prev => {
            const prevNorm = normalizeTextForMatch(prev.textLines.join(' '));
            if (!prevNorm) return false;
            return incNorm === prevNorm || (incNorm.length > 5 && (prevNorm.includes(incNorm) || incNorm.includes(prevNorm)));
        });

        if (matchIdx !== -1) {
            // Already present in previous chunk, discard duplicate from overlap window
            continue;
        }

        // Adjust start time if it starts slightly before the last block ends
        const lastBlock = result[result.length - 1];
        if (lastBlock && inc.startMs < lastBlock.endMs) {
            if (inc.endMs > lastBlock.endMs + 300) {
                inc.startMs = lastBlock.endMs + 50;
                inc.startTs = msToTime(inc.startMs);
                result.push(inc);
            }
        } else {
            result.push(inc);
        }
    }

    return result;
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
        const line = rawLine.trim();
        if (!line) continue;
        const match = line.match(/^\[(?:CUE\s*)?(\d+)\]\s*(.*)$/i);
        if (match) {
            flush();
            currentCueId = parseInt(match[1], 10);
            if (match[2].trim()) {
                currentLines.push(match[2].trim());
            }
        } else if (currentCueId !== null) {
            currentLines.push(line);
        }
    }
    flush();
    return cueMap;
}

async function translateCuesById(
    blocks: ParsedRawBlock[],
    opts: GenerateSrtOptions,
    genAI: GoogleGenAI,
    onProgress?: (p: number) => void
): Promise<ParsedRawBlock[]> {
    const { mode = 'ori', targetLang = 'Original' } = opts;
    const cleanTarget = targetLang.trim();
    const isOriginalOnly = cleanTarget === '' || cleanTarget.toLowerCase() === 'original' || cleanTarget.toLowerCase() === 'verbatim';

    if (mode === 'ori' && isOriginalOnly) {
        return blocks;
    }

    const currentModel = getCurrentTextModel();
    const BATCH_SIZE = 40;
    const totalBatches = Math.ceil(blocks.length / BATCH_SIZE);
    const translatedBlocks: ParsedRawBlock[] = blocks.map(b => ({ ...b, textLines: [...b.textLines] }));

    for (let b = 0; b < totalBatches; b++) {
        const batchStart = b * BATCH_SIZE;
        const batchBlocks = blocks.slice(batchStart, batchStart + BATCH_SIZE);

        let systemInstruction = `You are an expert subtitle translation and formatting engine.
Translate/format the provided dialogue cues according to the instructions.

CRITICAL ARCHITECTURAL RULES:
1. PRESERVE EVERY CUE ID: Return each cue starting with [CUE X] where X is the exact integer ID.
2. DO NOT MERGE OR SKIP: You must provide a translation for every single [CUE X].
3. DO NOT OUTPUT TIMESTAMPS: Do not generate any timestamps. Timecodes are managed externally.
4. Output format:
[CUE X]
Line 1
Line 2 (if dual/multi-layered)`;

        if (mode === 'ori') {
            systemInstruction += `\n\nMODE: SINGLE-LAYER TRANSLATION into ${cleanTarget}. For each cue, output only the translated text in ${cleanTarget}.`;
        } else if (mode === 'dual') {
            const destLang = isOriginalOnly ? 'English' : cleanTarget;
            systemInstruction += `\n\nMODE: BILINGUAL (DUAL-LAYER). For each cue, output exactly two lines:\nLine 1: Original verbatim spoken text\nLine 2: Faithful ${destLang} translation`;
        } else if (mode === 'dual_trans') {
            const destLang = isOriginalOnly ? 'Spanish' : cleanTarget;
            systemInstruction += `\n\nMODE: DUAL TRANSLATION. For each cue, output exactly two lines:\nLine 1: English translation\nLine 2: ${destLang} translation`;
        } else if (mode === 'triple') {
            const destLang = isOriginalOnly ? 'English' : cleanTarget;
            systemInstruction += `\n\nMODE: TRIPLE-LAYER. For each cue, output three lines:\nLine 1: Original verbatim spoken text\nLine 2: Accurate phonetic transliteration\nLine 3: Faithful ${destLang} translation`;
        } else if (mode === 'quad') {
            const destLang = isOriginalOnly ? 'Spanish' : cleanTarget;
            systemInstruction += `\n\nMODE: QUAD-LAYER. For each cue, output four lines:\nLine 1: Original verbatim spoken text\nLine 2: Accurate phonetic transliteration\nLine 3: Literal English translation\nLine 4: Faithful ${destLang} translation`;
        }

        if (opts.contextInstruction && opts.contextInstruction.trim() !== '') {
            systemInstruction += `\n\nUSER CONTEXT:\n"""\n${opts.contextInstruction.trim()}\n"""`;
        }

        const inputPayload = batchBlocks.map((blk, idx) => {
            const cueId = batchStart + idx + 1;
            return `[CUE ${cueId}]\n${blk.textLines.join('\n')}`;
        }).join('\n\n');

        try {
            const res = await callAudioTranscriptionModel(genAI, {
                contents: `Please translate and format these dialogue cues:\n\n${inputPayload}`,
                config: {
                    temperature: 0.1,
                    systemInstruction
                }
            });

            const cueMap = parseCueMap(res.text || '');

            for (let i = 0; i < batchBlocks.length; i++) {
                const cueId = batchStart + i + 1;
                const globalIdx = batchStart + i;
                if (cueMap.has(cueId)) {
                    const translatedLines = cueMap.get(cueId)!;
                    if (translatedLines.length > 0) {
                        translatedBlocks[globalIdx].textLines = translatedLines;
                    }
                }
            }
        } catch (err) {
            console.warn(`[SRT Generator] Batch translation failed for cues ${batchStart + 1}-${batchStart + batchBlocks.length}:`, err);
        }

        if (onProgress) {
            onProgress(75 + Math.round(((b + 1) / totalBatches) * 20));
        }
    }

    return translatedBlocks;
}

async function transcribeSingleChunk(
    chunkBlob: Blob,
    chunkDurationSec: number,
    opts: GenerateSrtOptions,
    genAI: GoogleGenAI,
    apiKey: string
): Promise<string> {
    const maxTimecode = msToTime(Math.round(chunkDurationSec * 1000));

    let pass1Instruction = `You are an expert audio segmentation and transcription engine.
Your task is to transcribe dialogue from this audio segment (duration: ${Math.round(chunkDurationSec)} seconds).

CRITICAL TEMPORAL & COMPLETENESS CONSTRAINTS:
- The segment duration is exactly ${Math.round(chunkDurationSec)} seconds.
- Relative timestamps MUST start from 00:00:00,000 and MUST NEVER exceed ${maxTimecode}.
- TOTAL TRANSCRIPTION FIDELITY: Transcribe EVERY SINGLE dialogue utterance across the ENTIRE audio slice from 0.0s to the very end of this chunk. Do NOT stop early. Do NOT truncate. Generate all continuous subtitle blocks covering 100% of the speech.
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

    let parts: any[] = [{ text: `Generate precisely timed SRT transcription for this audio slice.` }];
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

async function generateChunkedSRT(
    opts: GenerateSrtOptions,
    totalDurationSec: number,
    genAI: GoogleGenAI,
    apiKey: string
): Promise<string> {
    const { onProgress, audioFile } = opts;
    if (onProgress) onProgress(10);

    if (!audioFile) {
        throw new Error("No audio file provided for chunked transcription.");
    }

    let audioBuffer: AudioBuffer;
    let duration: number;

    try {
        const decoded = await decodeAudioBufferFromFile(audioFile);
        audioBuffer = decoded.audioBuffer;
        duration = Math.min(totalDurationSec, audioBuffer.duration);
    } catch (decodeErr) {
        console.warn('[SRT Generator] decodeAudioData failed on media file (likely video container or unsupported codec). Falling back to direct single-pass transcription:', decodeErr);
        let safeMimeType = audioFile.type || 'audio/mpeg';
        const isVideo = safeMimeType.startsWith('video/') && opts.processingMode === 'video_audio';
        return await generateSinglePassSRT(opts, safeMimeType, isVideo, genAI, apiKey);
    }

    // 90-second chunks (90s) with 6-second overlap to guarantee compact ~2.8MB inlineData payloads and eliminate 15-cue token truncation
    const CHUNK_DURATION_SEC = 90; 
    const OVERLAP_SEC = 6;
    const STEP_SEC = CHUNK_DURATION_SEC - OVERLAP_SEC; // 84 seconds
    const totalChunks = Math.max(1, Math.ceil((duration - OVERLAP_SEC) / STEP_SEC));

    console.log(`[SRT Generator] Anti-Drift Chunking active: ${totalChunks} chunks for ${Math.round(duration)}s audio`);

    let allBlocks: ParsedRawBlock[] = [];

    for (let c = 0; c < totalChunks; c++) {
        const chunkStartSec = c * STEP_SEC;
        const chunkDurSec = Math.min(CHUNK_DURATION_SEC, duration - chunkStartSec);
        if (chunkDurSec <= 1) break;

        if (onProgress) {
            const pct = Math.round(15 + (c / totalChunks) * 55);
            onProgress(pct);
        }

        const { wavBlob } = extractWavSliceFromBuffer(audioBuffer, chunkStartSec, chunkDurSec);
        const rawChunkSrt = await transcribeSingleChunk(wavBlob, chunkDurSec, opts, genAI, apiKey);
        const chunkBlocks = parseRawBlocks(rawChunkSrt);

        const chunkStartMs = Math.round(chunkStartSec * 1000);
        const shiftedBlocks: ParsedRawBlock[] = chunkBlocks.map(b => {
            const startMs = b.startMs + chunkStartMs;
            const endMs = b.endMs + chunkStartMs;
            return {
                startMs,
                endMs,
                startTs: msToTime(startMs),
                endTs: msToTime(endMs),
                textLines: b.textLines
            };
        });

        allBlocks = deduplicateAndMergeBlocks(allBlocks, shiftedBlocks, chunkStartMs);
    }

    if (allBlocks.length === 0) {
        throw new Error("No speech segments detected in any audio chunks.");
    }

    // Pass 2: Translate cues by ID (if requested)
    if (opts.mode !== 'ori' || (opts.targetLang && opts.targetLang !== 'Original' && opts.targetLang.toLowerCase() !== 'verbatim')) {
        if (onProgress) onProgress(75);
        allBlocks = await translateCuesById(allBlocks, opts, genAI, onProgress);
    }

    if (onProgress) onProgress(95);
    return reconstructSRT(allBlocks);
}

async function generateSinglePassSRT(
    opts: GenerateSrtOptions,
    safeMimeType: string,
    isVideo: boolean,
    genAI: GoogleGenAI,
    keyToUse: string
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
    const isVideoSource = Boolean(audioFile && (
        safeMimeType.startsWith('video/') ||
        /\.(mp4|m4v|mov|webm|ogv|mkv|avi|mpeg|mpg|3gp|ts)$/i.test(audioFile.name || '')
    ));

    let systemInstruction = `You are the AI VIDEO SUBTITLE ANALYSIS & PRECISION SYNC ENGINE.
Your task is to transcribe and time-align the provided ${isVideo ? 'video' : 'audio soundtrack'} and generate an accurate, valid SRT file.

${isVideoSource && processingMode === 'audio'
    ? 'LISTEN ONLY MODE: The source is a video file, but use ONLY its embedded audio/soundtrack for transcription and timing. Ignore video frames, facial expressions, lip movements, on-screen text, and visual scene context. Do not create captions from visual-only information. Keep all timestamps aligned to the embedded audio timeline.'
    : isVideo
        ? 'WATCH & LISTEN MODE: Use both the embedded audio and relevant video frames for transcription context. Audio remains the authority for spoken words and timing; never invent dialogue from visuals.'
        : 'AUDIO MODE: Use the audio signal for transcription and timing. Do not infer speech from unrelated visual content.'}

The goal is to create subtitles that are: CORRECTLY WRITTEN + CORRECTLY TRANSLATED + CORRECTLY TIMED + SYNCHRONIZED WITH THE ACTUAL SPEECH${isVideo && processingMode === 'video_audio' ? ' + CONSISTENT WITH THE VISUAL SCENE' : ''}.
Do not process every video as if it were simple continuous speech.

OUTPUT FORMAT:
Output ONLY the raw SRT format. No markdown formatting, no code block backticks (\`\`\`srt), and no conversational explanations.

CORE WORKFLOW:
1. FIRST PASS: Understand the video structure (scene changes, speaker appearances, speech vs. silence).
2. AUDIO ANALYSIS: Detect exact speech onset, offset, pauses, and word boundaries.
3. SPEAKER IDENTIFICATION: Determine who is speaking, if they are on-screen, off-screen, or background.
4. TRANSCRIPTION: Transcribe the actual spoken words. Do not summarize or invent dialogue.
5. TRANSLATION: Translate while preserving meaning, tone, and context.
6. SEGMENTATION: Group words into subtitles based on natural pauses, readability, and the 5-second max duration rule.

CRITICAL RULE 1: EXACT AUDIO-TIMELINE SYNCHRONIZATION (ZERO DRIFT)
- AUDIO-FIRST TIMING: The transcript provides the WORDS. The audio provides the TIMING. Do NOT allow transcript text to override obvious audio acoustic timing.
- NO PHANTOM TIMING (PRE-SPEECH SOUNDS): If a speaker makes a pre-speech sound (like "Woah", "Ah", a gasp, or a sigh) before starting their actual sentence, DO NOT start the sentence's timecode early during that sound UNLESS you explicitly type out the sound (e.g., "Woah, how exciting!"). If you don't type the sound, the timecode MUST NOT start until the actual first word ("how").
- NEVER assume a sentence should occupy the entire time between the previous and next sentence. Do NOT keep a caption on screen during long silent periods merely because the next sentence hasn't started.
- The start timestamp MUST mark the exact millisecond the speaker utters the first syllable.
- The end timestamp MUST mark the exact millisecond when the vocal sound concludes.
- NEVER invent imaginary pauses, do NOT bunch multiple separate lines together, and do NOT let timestamps drift.
- Standard SRT format: HH:MM:SS,mmm --> HH:MM:SS,mmm.

CRITICAL RULE 2: CHRONOLOGICAL & NO OVERLAPPING
- Subtitles must proceed strictly in chronological sequence (start < end).
- NO OVERLAPPING TIMECODES: A subtitle's start time MUST be greater than or equal to the previous subtitle's end time. Never output two subtitle blocks that occur at the same time.
- Do not output invalid seconds (values >= 60).

CRITICAL RULE 3: LINGUISTIC ACCURACY & FAITHFUL TRANSLATION
- 100% TRANSCRIPTION FIDELITY: Transcribe what was actually spoken word-for-word.
- CONTEXT WINDOW: Use the surrounding conversation and visual scene to determine meaning, but NEVER invent dialogue.
- SAME LANGUAGE RULE: If the spoken audio is already in the target language (or Original Language is selected), output the verbatim original spoken words.

CRITICAL RULE 4: PROFESSIONAL SEGMENTATION, BREVITY & NO LONG TEXT (MAX 1 SENTENCE PER BOX)
- NEVER cram multiple complete sentences or long paragraphs into a single subtitle block.
- For example, if a speaker says: "라는 생각을 한 적이 있어. 왜냐면 내가 운동하기 너무 힘들잖아. 그럼 같이 운동할 수 있는 사람?"
  You MUST output 3 SEPARATE, consecutively timed subtitle blocks:
  1. "라는 생각을 한 적이 있어"
  2. "왜냐면 내가 운동하기 너무 힘들잖아"
  3. "그럼 같이 운동할 수 있는 사람?"
  Each with its own accurate speech start and end timestamps!
- STRICT SENTENCE SEGMENTATION: 1 subtitle block = ONLY 1 concise sentence or short clause.
- Whenever a sentence ends (with '.', '?', '!', or a natural spoken pause), immediately start a new subtitle block!
- MAX DURATION: 1.5 to 3.5 seconds per block (maximum 4.0s). Never bundle sentences into 5-7 second blocks.
- MAX LENGTH: Maximum 1-2 short lines per block.
  * Korean / Japanese / Chinese (CJK): MAXIMUM 15-25 characters per line (NEVER > 30 chars).
  * English / Latin / Western: MAXIMUM 35-42 characters per line.
- SHORT REACTIONS & VOCALIZATION SEPARATION: Pay extreme attention to short, rapid reactions (e.g., "Ah", "Oh", "Woah", gasps). Do not skip them. If there is a distinct pre-speech reaction followed by a sentence, strongly prefer splitting them into TWO separate time-aligned subtitle blocks if there is a natural acoustic pause between them.
- OVERLAPPING SPEECH: If two people speak simultaneously, DO NOT create overlapping timecode blocks. Instead, combine their dialogue into a SINGLE subtitle block using two lines (e.g., "- Hello\n- Hi").
- SCENE-AWARE SUBTITLING: Use visual context to prevent subtitles from carrying incorrectly across scenes. A scene change does NOT automatically mean a subtitle must end if the audio continues naturally, but audio continuity takes priority.

CRITICAL RULE 5: VISUAL CAPTIONS, EMOTIONS & NON-VERBAL CONTEXT
- EMOTION & EXPRESSION TAGGING: You MUST capture the emotional state of the speaker. When a speaker exhibits a clear emotion visually (e.g., facial expressions of surprise, shyness) or acoustically (e.g., crying, laughing, tone of voice), include an emotion tag in brackets before their dialogue or as a standalone block. Examples: [Crying], [Surprised], [Laughing], [Shyly], [Sighs], [Gasps].
- ON-SCREEN TEXT & GRAPHICS: If requested, create subtitle blocks for on-screen captions or emotions exactly when they appear, even during silence. Treat existing burned-in subtitles as visual reference only; use the original audio for timing.
- LAUGHTER & VOCALIZATIONS: Detect and accurately time laughter, humming, gasps, and crying independently from speech. Use exact acoustic durations.

CRITICAL RULE 6: CLEAN FORMATTING
- ABSOLUTELY NO TRAILING PERIODS. Do NOT end subtitle lines with a period (.). Question marks (?) and exclamation marks (!) are allowed, but never periods.

CRITICAL RULE 7: TOTAL COMPLETENESS
- Transcribe the entire file continuously from start to finish. Never omit lines.`;

    if (isVideoSource && processingMode === 'audio') {
        systemInstruction += '\n\nSTRICT LISTEN-ONLY OVERRIDE: The input happens to be a video container, but use ONLY its embedded audio/soundtrack. Ignore all video frames, facial expressions, lip movements, on-screen text, scene changes, and any other visual evidence. Do not produce captions from visual-only content. Determine every word and timestamp exclusively from audible speech, singing, and vocalizations.';
    } else if (isVideoSource && processingMode === 'video_audio') {
        systemInstruction += '\n\nWATCH & LISTEN MODE: Use the embedded audio for exact words and timing. Video frames may provide supporting context, but never infer dialogue that cannot be heard.';
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
    let pass1Instruction = `You are an expert audio segmentation and transcription engine.
Your primary task is to identify the exact start and end of every spoken dialogue segment from the ${isVideo && processingMode === 'video_audio' ? 'video and its embedded audio' : 'audio soundtrack'}.
${isVideoSource && processingMode === 'audio' ? 'LISTEN ONLY: Ignore video frames and all visual information. Transcribe only audible speech, singing, and vocalizations from the embedded soundtrack; use the audio for every timestamp.' : isVideo && processingMode === 'video_audio' ? 'WATCH & LISTEN: Audio determines the words and exact timing; use video frames only for relevant context, not to invent speech.' : 'Use the audio signal as the sole source for words and timing.'}

For each dialogue:
- Start the subtitle when the speaker actually begins speaking.
- End it when the speaker finishes speaking.
- Do not estimate timing based on the sentence length.
- Do not distribute subtitles evenly across the audio.
- Do not invent timestamps.
- Pay special attention to silence, pauses, overlapping speech, music, and dialogue transitions.
- Never let a subtitle extend through a significant silence.
- Never shift a subtitle simply to make the subtitle durations look uniform.

CRITICAL RULE: STRICT MONOTONIC TIMECODE CONTINUITY (NO TIMECODE JUMPING).
- Timestamps must progress continuously and monotonically matching the media playback.
- DO NOT jump or skip ahead in time (e.g. jumping from 22 minutes to 33 minutes).
- If speech occurs at 22:45, the next dialogue will be around 22:50 or 23:00, NEVER 33:00. Pay rigorous attention to the minute digits: do not confuse 22/23 with 32/33.
- If an instrumental break, song intro, or silence occurs, output the exact playback time when the next speech resumes without skipping ahead in the clock.

Return the original spoken dialogue aligned to exact timestamps.
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
        parts.push({
            fileData: {
                fileUri: youtubeUrl,
                mimeType: "video/*"
            }
        });
        if (onProgress) onProgress(50);
    } else if (audioFile) {
        let safeMimeType = audioFile.type;
        if (!safeMimeType || safeMimeType === 'application/octet-stream') {
            const lowerName = (audioFile.name || '').toLowerCase();
            if (lowerName.endsWith('.mp4')) safeMimeType = 'video/mp4';
            else if (lowerName.endsWith('.webm')) safeMimeType = 'video/webm';
            else if (lowerName.endsWith('.mov')) safeMimeType = 'video/quicktime';
            else if (lowerName.endsWith('.wav')) safeMimeType = 'audio/wav';
            else if (lowerName.endsWith('.ogg')) safeMimeType = 'audio/ogg';
            else if (lowerName.endsWith('.flac')) safeMimeType = 'audio/flac';
            else safeMimeType = 'audio/mpeg';
        }

        const MAX_INLINE_SIZE = 15 * 1024 * 1024;
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
                console.warn('[SRT Generator] Single-pass file upload failed (possible 403 or quota). Attempting in-memory chunking or direct media slice:', uploadErr);
                try {
                    return await generateChunkedSRT(opts, 300, genAI, keyToUse);
                } catch (chunkErr) {
                    console.warn('[SRT Generator] Chunking also failed on container. Slicing media for inline single-pass:', chunkErr);
                    const sliceBlob = audioFile.slice(0, 14 * 1024 * 1024);
                    const base64 = await blobToBase64(sliceBlob);
                    parts.push({
                        inlineData: {
                            data: base64,
                            mimeType: safeMimeType
                        }
                    });
                    usedInline = true;
                }
            }
        }
    } else {
        throw new Error("Please provide a media file or a YouTube URL.");
    }

    try {
        if (onProgress) onProgress(60);
        // Execute Pass 1 with model fallback
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

        if (isSimpleOriginal) {
            if (onProgress) onProgress(95);
            return reconstructSRT(pass1Blocks);
        }

        // Pass 2: Translate cues by ID (preserving timestamps with 100% fidelity)
        if (onProgress) onProgress(75);
        pass1Blocks = await translateCuesById(pass1Blocks, opts, genAI, onProgress);
        if (onProgress) onProgress(95);
        return reconstructSRT(pass1Blocks);

    } catch (e: any) {
        // If single pass failed due to 403 / upload / size issues, attempt chunked generation as final fallback
        const errMsg = (e?.message || '') + JSON.stringify(e || '');
        if (!usedInline && (errMsg.includes('403') || errMsg.includes('PERMISSION_DENIED') || errMsg.includes('upload') || errMsg.includes('File processing'))) {
            console.warn('[SRT Generator] Single-pass generation failed with permission error. Attempting in-memory chunking fallback...');
            return await generateChunkedSRT(opts, 300, genAI, keyToUse);
        }
        console.error("SRT generation failed", e);
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

            const isOriginalOnly = mode === 'ori' && (!targetLang || targetLang === 'Original' || targetLang.toLowerCase() === 'original' || (sourceLang && targetLang.toLowerCase() === sourceLang.toLowerCase()));

            if (isOriginalOnly && captionRes.rawSrt) {
                if (onProgress) onProgress(100);
                const blocks = parseSubtitles(captionRes.rawSrt);
                const { repairedBlocks } = autoRepairTimeline(blocks);
                return generateSrt(repairedBlocks);
            }

            // Translate authentic timed cues while locking timestamps
            if (onProgress) onProgress(65);
            const rawSrt = captionRes.rawSrt || segmentsToSrt(captionRes.segments);

            const translationPrompt = `You are an expert subtitle translation and formatting engine.
INPUT SUBTITLES (Official YouTube Closed Captions with precise millisecond timecodes):
${rawSrt}

CRITICAL TIMING & BREVITY RULES:
1. You MUST keep EVERY timestamp (HH:MM:SS,mmm --> HH:MM:SS,mmm) and block number 100% IDENTICAL and INTACT.
2. Do NOT modify, recalculate, merge, or re-time any timestamp.
3. CONCISE SUBTITLES: Never output excessive text or long run-on sentences. Keep translations natural, concise, and punchy.

TASK:
- Mode: ${mode === 'dual' ? `Dual-layer bilingual (Line 1: Original text, Line 2: ${targetLang} translation)` : mode === 'dual_trans' ? `Dual translation (Line 1: English, Line 2: ${targetLang})` : mode === 'triple' ? `Triple layer (Line 1: Original, Line 2: Romanized phonetic, Line 3: ${targetLang} translation)` : `Translate to ${targetLang}`}
- Ensure natural, context-aware translation while preserving the exact speech duration and subtitle segmentation.
- Output ONLY the formatted standard SRT blocks without markdown fences or additional commentary.`;

            try {
                const translationRes = await withRetry(() => genAI.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: translationPrompt,
                    config: { temperature: 0.1 }
                }), 1);

                const translatedText = (translationRes.text || '').replace(/^```(?:srt)?\s*/i, '').replace(/\s*```$/i, '').trim();
                const translatedBlocks = parseSubtitles(translatedText);
                if (translatedBlocks.length > 0) {
                    if (onProgress) onProgress(100);
                    const { repairedBlocks } = autoRepairTimeline(translatedBlocks);
                    return generateSrt(repairedBlocks);
                }
            } catch (transErr) {
                console.warn('[YouTube Captions] Translation error, returning authentic native original cues:', transErr);
            }

            if (onProgress) onProgress(100);
            const fallbackBlocks = parseSubtitles(rawSrt);
            const { repairedBlocks: repairedFallback } = autoRepairTimeline(fallbackBlocks);
            return generateSrt(repairedFallback);
        }

        if (captionRes.requiresTranscription || captionRes.source === 'unavailable') {
            console.log(`[YouTube Captions] Authentic YouTube CC is unavailable for ${videoId}. Reason: ${captionRes.reason}. Activating Gemini Multimodal Audio Transcription...`);
        }
    } catch (captionServiceErr) {
        console.warn('[YouTube Captions] Backend caption service notice:', captionServiceErr);
    }

    // STEP 2: Legitimate Multimodal Audio Stream Transcription Fallback
    // When authentic CC is not uploaded on YouTube, stream the media audio so Gemini generates genuine acoustic timecodes
    try {
        if (onProgress) onProgress(40);
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
        
        try {
            // Multimodal Watch & Listen or Listen Only for YouTube
            const isVideoMode = processingMode === 'video_audio';
            return await generateSinglePassSRT(opts, 'video/*', isVideoMode, genAI, keyToUse);
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
    const isVideoSource = safeMimeType.startsWith('video/') || /\.(mp4|m4v|mov|webm|ogv|mkv|avi|mpeg|mpg|3gp|ts)$/i.test(lowerName);
    const isVideo = isVideoSource && processingMode === 'video_audio';

    let rawSRT = "";
    try {
        const mediaDuration = await getMediaDuration(audioFile);

        // If media duration > 75s or file > 3MB, activate Anti-Drift Chunking Engine to ensure 100% full-duration transcription
        const shouldChunk = (mediaDuration > 75 || audioFile.size > 3 * 1024 * 1024 || (mediaDuration === 0 && audioFile.size > 1024 * 1024)) && (!resumeTime || resumeTime.trim() === '');
        if (shouldChunk) {
            try {
                console.log(`[SRT Generator] Activating Anti-Drift Chunking Engine (duration: ${Math.round(mediaDuration)}s, size: ${(audioFile.size / (1024 * 1024)).toFixed(1)}MB).`);
                rawSRT = await generateChunkedSRT(opts, mediaDuration || 300, genAI, keyToUse);
            } catch (chunkErr) {
                console.warn('[SRT Generator] Chunked generation failed, attempting single-pass fallback:', chunkErr);
                rawSRT = await generateSinglePassSRT(opts, safeMimeType, isVideo, genAI, keyToUse);
            }
        } else {
            try {
                rawSRT = await generateSinglePassSRT(opts, safeMimeType, isVideo, genAI, keyToUse);
            } catch (singleErr: any) {
                const errMsg = (singleErr?.message || '') + JSON.stringify(singleErr || '');
                if (errMsg.includes('403') || errMsg.includes('PERMISSION_DENIED') || errMsg.includes('upload') || errMsg.includes('File processing')) {
                    console.warn('[SRT Generator] Single-pass hit upload/permission issue, falling back to in-memory chunking:', singleErr);
                    rawSRT = await generateChunkedSRT(opts, mediaDuration || 300, genAI, keyToUse);
                } else {
                    throw singleErr;
                }
            }
        }

        let parsedBlocks = parseRawBlocks(rawSRT);
        if (parsedBlocks.length > 0) {
            const blocksForRepair = parsedBlocks.map(b => ({
                start: b.startMs,
                end: b.endMs,
                startTs: b.startTs,
                endTs: b.endTs,
                textLines: b.textLines
            }));
            const { repairedBlocks } = autoRepairTimeline(blocksForRepair);
            const issues = validateTimeline(repairedBlocks);
            if (issues.length > 0) {
                console.warn('[SRT Generator] Timeline validation notices:', issues);
            }
            const finalBlocks: ParsedRawBlock[] = repairedBlocks.map(rb => ({
                startMs: rb.start,
                endMs: rb.end,
                startTs: msToTime(rb.start),
                endTs: msToTime(rb.end),
                textLines: rb.textLines
            }));
            return reconstructSRT(finalBlocks);
        }
        return rawSRT;
    } catch (e) {
        console.error("SRT generation failed", e);
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

    const arrayBuffer = await file.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
        throw new Error('Media file buffer is empty (0 bytes)');
    }

    const audioCtx = new AudioContextClass();
    try {
        let audioBuffer: AudioBuffer | null = null;
        let lastError: any = null;

        // Try standard modern Promise-based decodeAudioData first with safe catch
        try {
            audioBuffer = await new Promise<AudioBuffer | null>((resolve) => {
                let settled = false;
                try {
                    const ret = audioCtx.decodeAudioData(
                        arrayBuffer.slice(0),
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