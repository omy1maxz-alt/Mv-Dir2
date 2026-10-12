export interface SubtitleBlock {
  id: string;
  start: number; // in milliseconds
  end: number;
  text: string;
  isLocked?: boolean;
}

function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const timeToMs = (timeStr: string): number => {
  if (!timeStr) return 0;
  const cleanStr = timeStr.trim().replace(',', '.');
  const [time, msStr] = cleanStr.split('.');
  const parts = time.split(':');
  let seconds = 0;
  if (parts.length === 3) {
    seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
  } else if (parts.length === 2) {
    seconds = parseInt(parts[0]) * 60 + parseInt(parts[1]);
  } else {
    seconds = parseInt(parts[0]) || 0;
  }
  return (seconds * 1000) + (msStr ? parseInt(msStr.padEnd(3, '0').substring(0, 3)) : 0);
};

export const msToSrtTime = (ms: number): string => {
  const h = Math.floor(ms / 3600000).toString().padStart(2, '0');
  const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0');
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
  const ml = Math.floor(ms % 1000).toString().padStart(3, '0');
  return `${h}:${m}:${s},${ml}`;
};

export const msToVttTime = (ms: number): string => {
  const h = Math.floor(ms / 3600000).toString().padStart(2, '0');
  const m = Math.floor((ms % 3600000) / 60000).toString().padStart(2, '0');
  const s = Math.floor((ms % 60000) / 1000).toString().padStart(2, '0');
  const ml = Math.floor(ms % 1000).toString().padStart(3, '0');
  return h === '00' ? `${m}:${s}.${ml}` : `${h}:${m}:${s}.${ml}`;
};

export const parseSubtitles = (content: string): SubtitleBlock[] => {
  if (!content || !content.trim()) return [];
  const blocks: SubtitleBlock[] = [];
  const trimmed = content.trim();

  // 1. YouTube timedtext XML format: <text start="1.5" dur="2.3">Hello world</text>
  if (trimmed.includes('<transcript') || trimmed.includes('<timedtext') || (trimmed.includes('<text ') && trimmed.includes('start='))) {
    const textTagRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = textTagRegex.exec(trimmed)) !== null) {
      const startSec = parseFloat(match[1]) || 0;
      const durSec = parseFloat(match[2]) || 2.0;
      const startMs = Math.round(startSec * 1000);
      const endMs = Math.round((startSec + durSec) * 1000);
      const rawText = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, '').trim());
      if (rawText) {
        blocks.push({
          id: Math.random().toString(36).substring(7),
          start: startMs,
          end: Math.max(endMs, startMs + 500),
          text: rawText
        });
      }
    }

    if (blocks.length > 0) {
      return blocks.sort((a, b) => a.start - b.start);
    }

    // Secondary YouTube XML format: <p t="1500" d="2300">Hello</p>
    const pTagRegex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
    while ((match = pTagRegex.exec(trimmed)) !== null) {
      const startMs = parseInt(match[1], 10) || 0;
      const durMs = parseInt(match[2], 10) || 2000;
      const rawText = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, '').trim());
      if (rawText) {
        blocks.push({
          id: Math.random().toString(36).substring(7),
          start: startMs,
          end: Math.max(startMs + durMs, startMs + 500),
          text: rawText
        });
      }
    }

    if (blocks.length > 0) {
      return blocks.sort((a, b) => a.start - b.start);
    }
  }

  // 2. YouTube JSON3 format: {"events":[{"tStartMs":1500,"dDurationMs":2300,"segs":[{"utf8":"Hello"}]}]}
  if (trimmed.startsWith('{') && trimmed.includes('"events"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed.events)) {
        for (const ev of parsed.events) {
          if (typeof ev.tStartMs === 'number' && Array.isArray(ev.segs)) {
            const startMs = ev.tStartMs;
            const durMs = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 2000;
            const text = ev.segs.map((s: any) => s.utf8 || '').join('').trim();
            if (text && text !== '\n') {
              blocks.push({
                id: Math.random().toString(36).substring(7),
                start: startMs,
                end: Math.max(startMs + durMs, startMs + 500),
                text: decodeHtmlEntities(text)
              });
            }
          }
        }
        if (blocks.length > 0) {
          return blocks.sort((a, b) => a.start - b.start);
        }
      }
    } catch (_) {}
  }

  // 3. Standard SRT / WebVTT format
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const chunks = text.split(/\n\n+/);
  
  for (const chunk of chunks) {
    const lines = chunk.trim().split('\n');
    if (lines.length < 2) continue;
    
    // Find the line with the timestamp
    let timeLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeLineIdx = i;
        break;
      }
    }
    
    if (timeLineIdx === -1) continue;
    
    const [startStr, endStr] = lines[timeLineIdx].split('-->').map(s => s.trim().split(/\s+/)[0]);
    
    // Text is everything after the timeline
    const textLines = lines.slice(timeLineIdx + 1);
    const cleanedText = decodeHtmlEntities(textLines.join('\n').trim());
    
    if (startStr && endStr && cleanedText) {
        blocks.push({
          id: Math.random().toString(36).substring(7),
          start: timeToMs(startStr),
          end: timeToMs(endStr),
          text: cleanedText
        });
    }
  }
  
  return blocks.sort((a, b) => a.start - b.start);
};

export const generateSrt = (blocks: SubtitleBlock[]): string => {
  return blocks.map((block, index) => {
    return `${index + 1}\n${msToSrtTime(block.start)} --> ${msToSrtTime(block.end)}\n${block.text}\n`;
  }).join('\n');
};

export const generateVtt = (blocks: SubtitleBlock[]): string => {
  let vtt = 'WEBVTT\n\n';
  vtt += blocks.map(block => {
    return `${msToVttTime(block.start)} --> ${msToVttTime(block.end)}\n${block.text}\n`;
  }).join('\n');
  return vtt;
};

/**
 * Splits dialogue text into natural sentences or clauses using standard and CJK punctuation (.?!。？！).
 */
export function splitSentences(text: string): string[] {
  if (!text) return [];
  const clean = text.trim();
  // Split on period, question mark, exclamation mark followed by whitespace or end-of-string
  const rawParts = clean.split(/(?<=[.?!。？！])(?:\s+|$)/);
  return rawParts.map(p => p.trim()).filter(Boolean);
}

/**
 * Intelligently splits a subtitle cue's text at the current playhead or midpoint ratio.
 * Preserves sentence and word boundaries, cleanly handling both single-line and multi-line (bilingual) cues.
 */
export function smartSplitCueText(text: string, ratio = 0.5): { part1: string; part2: string } {
  if (!text) return { part1: '', part2: '' };
  const lines = text.split('\n');

  if (lines.length === 1) {
    const s = splitSentences(lines[0]);
    if (s.length >= 2) {
      const mid = Math.max(1, Math.min(s.length - 1, Math.round(s.length * ratio)));
      return {
        part1: s.slice(0, mid).join(' '),
        part2: s.slice(mid).join(' ')
      };
    }
    // Single sentence - split at word boundary
    const words = lines[0].split(' ');
    if (words.length >= 2) {
      const mid = Math.max(1, Math.min(words.length - 1, Math.round(words.length * ratio)));
      return {
        part1: words.slice(0, mid).join(' '),
        part2: words.slice(mid).join(' ')
      };
    }
    return { part1: lines[0], part2: '' };
  } else {
    // Multi-line (e.g. Bilingual Line 1 / Line 2)
    const l1 = lines[0];
    const l2 = lines.slice(1).join('\n');
    const s1 = splitSentences(l1);
    const s2 = splitSentences(l2);

    let p1_l1 = '';
    let p2_l1 = '';
    let p1_l2 = '';
    let p2_l2 = '';

    if (s1.length >= 2) {
      const mid1 = Math.max(1, Math.min(s1.length - 1, Math.round(s1.length * ratio)));
      p1_l1 = s1.slice(0, mid1).join(' ');
      p2_l1 = s1.slice(mid1).join(' ');
    } else {
      const words1 = l1.split(' ');
      const mid1 = Math.max(1, Math.min(words1.length - 1, Math.round(words1.length * ratio)));
      p1_l1 = words1.slice(0, mid1).join(' ');
      p2_l1 = words1.slice(mid1).join(' ');
    }

    if (s2.length >= 2) {
      const mid2 = Math.max(1, Math.min(s2.length - 1, Math.round(s2.length * ratio)));
      p1_l2 = s2.slice(0, mid2).join(' ');
      p2_l2 = s2.slice(mid2).join(' ');
    } else {
      const words2 = l2.split(' ');
      const mid2 = Math.max(1, Math.min(words2.length - 1, Math.round(words2.length * ratio)));
      p1_l2 = words2.slice(0, mid2).join(' ');
      p2_l2 = words2.slice(mid2).join(' ');
    }

    return {
      part1: [p1_l1, p1_l2].filter(Boolean).join('\n'),
      part2: [p2_l1, p2_l2].filter(Boolean).join('\n')
    };
  }
}

/**
 * Splits a single multi-sentence subtitle block into multiple individual subtitle blocks,
 * distributing the duration proportionally based on character weight.
 */
export function splitSingleBlockBySentences(block: SubtitleBlock): SubtitleBlock[] {
  const lines = (block.text || '').split('\n');
  const l1 = lines[0] || '';
  const l2 = lines.slice(1).join('\n') || '';

  const s1 = splitSentences(l1);
  const s2 = splitSentences(l2);

  // If both lines have at most 1 sentence, check if line 1 or line 2 is excessively long (> 50 CJK or > 75 Latin chars)
  if (s1.length <= 1 && s2.length <= 1) {
    const isVeryLong = (l1.length > 50 || l2.length > 75) && (block.end - block.start) >= 2200;
    if (isVeryLong) {
      const { part1, part2 } = smartSplitCueText(block.text, 0.5);
      if (part1 && part2) {
        const midMs = Math.round(block.start + (block.end - block.start) * 0.5);
        return [
          {
            id: Math.random().toString(36).substring(7),
            start: block.start,
            end: midMs,
            text: part1.trim(),
            isLocked: block.isLocked
          },
          {
            id: Math.random().toString(36).substring(7),
            start: midMs,
            end: block.end,
            text: part2.trim(),
            isLocked: block.isLocked
          }
        ];
      }
    }
    return [block];
  }

  const isL1Primary = s1.length >= s2.length;
  const priSentences = isL1Primary ? s1 : s2;
  const secSentences = isL1Primary ? s2 : s1;

  if (priSentences.length <= 1) {
    return [block];
  }

  const dur = block.end - block.start;
  const totalPriLen = priSentences.reduce((acc, s) => acc + Math.max(1, s.length), 0) || 1;
  const totalSecLen = secSentences.reduce((acc, s) => acc + Math.max(1, s.length), 0) || 1;

  // Calculate cumulative normalized intervals for secondary sentences
  const secIntervals: { start: number; end: number; text: string }[] = [];
  let secAccum = 0;
  for (const s of secSentences) {
    const sLen = Math.max(1, s.length);
    const startRatio = secAccum / totalSecLen;
    const endRatio = (secAccum + sLen) / totalSecLen;
    secIntervals.push({ start: startRatio, end: endRatio, text: s });
    secAccum += sLen;
  }

  // Pre-calculate primary intervals
  const priIntervals: { start: number; end: number; text: string }[] = [];
  let priAccum = 0;
  for (const p of priSentences) {
    const pLen = Math.max(1, p.length);
    const startRatio = priAccum / totalPriLen;
    const endRatio = (priAccum + pLen) / totalPriLen;
    priIntervals.push({ start: startRatio, end: endRatio, text: p });
    priAccum += pLen;
  }

  // Assign secondary sentences to primary sentences by maximum interval overlap
  const assignedSec: string[][] = priSentences.map(() => []);
  for (const sInt of secIntervals) {
    let bestPriIdx = 0;
    let maxOverlap = -1;
    for (let i = 0; i < priIntervals.length; i++) {
      const pInt = priIntervals[i];
      const overlap = Math.max(0, Math.min(sInt.end, pInt.end) - Math.max(sInt.start, pInt.start));
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestPriIdx = i;
      }
    }
    assignedSec[bestPriIdx].push(sInt.text);
  }

  let currentStart = block.start;
  const result: SubtitleBlock[] = [];

  for (let i = 0; i < priSentences.length; i++) {
    const pri = priSentences[i];
    const isLast = i === priSentences.length - 1;
    const weight = Math.max(1, pri.length) / totalPriLen;
    const subDur = Math.round(dur * weight);
    const subEnd = isLast ? block.end : Math.min(block.end - 300, currentStart + Math.max(subDur, 600));

    let text = '';
    if (lines.length === 1) {
      text = pri;
    } else {
      let sec = '';
      if (s1.length === s2.length) {
        sec = secSentences[i] || '';
      } else {
        sec = assignedSec[i].join(' ');
      }
      text = isL1Primary ? [pri, sec].filter(Boolean).join('\n') : [sec, pri].filter(Boolean).join('\n');
    }

    result.push({
      id: Math.random().toString(36).substring(7),
      start: currentStart,
      end: subEnd,
      text: text.trim(),
      isLocked: block.isLocked
    });

    currentStart = subEnd;
  }

  return result;
}

/**
 * Automatically scans and splits oversized subtitle blocks containing multiple sentences or long paragraphs.
 */
export function splitOversizedBlocks(blocks: SubtitleBlock[]): { blocks: SubtitleBlock[]; splitCount: number } {
  const result: SubtitleBlock[] = [];
  let splitCount = 0;

  for (const block of blocks) {
    const lines = (block.text || '').split('\n');
    const l1 = lines[0] || '';
    const l2 = lines.slice(1).join('\n') || '';

    const s1 = splitSentences(l1);
    const s2 = splitSentences(l2);

    const dur = block.end - block.start;
    // Condition to split:
    // 1. Has >= 2 sentences AND duration is at least 1400ms (so each child gets >= 700ms)
    // 2. OR line length is excessively long (> 50 CJK or > 75 Latin chars) and duration >= 2200ms
    const hasMultipleSentences = (s1.length >= 2 || s2.length >= 2) && dur >= 1400;
    const isExcessivelyLong = (l1.length > 50 || l2.length > 75) && dur >= 2200;
    const shouldSplit = hasMultipleSentences || isExcessivelyLong;

    if (!shouldSplit) {
      result.push(block);
      continue;
    }

    const subBlocks = splitSingleBlockBySentences(block);
    if (subBlocks.length > 1) {
      splitCount++;
      result.push(...subBlocks);
    } else {
      result.push(block);
    }
  }

  return { blocks: result, splitCount };
}
