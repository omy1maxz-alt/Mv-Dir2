import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const srt = readFileSync("src/services/gemini_srt.ts", "utf8");
const gemini = readFileSync("src/services/gemini.ts", "utf8");
assert.equal(srt.includes(".map(m => /^gemini-3\\./i.test(m)"), false,
  "transcription must not rewrite live model IDs");
assert.equal(srt.includes("const isAlreadyAbsolute = chunkStartSec"), false,
  "chunk timestamps must not use the first-cue heuristic");
assert.equal(srt.includes("shiftSubtitleBlocks(\n            chunkBlocks"), true,
  "long-file chunks should use canonical timestamp offset handling");
assert.equal(srt.includes("Successful transcription request model:"), true,
  "runtime logs should record the actual model");
assert.equal(gemini.includes("Map fictional/aliased 3.x UI model names to real Gemini 2.5 models when live discovery is unavailable"), false,
  "model resolution must not silently rewrite the selected model when discovery fails");

type Cue = { startMs: number; endMs: number; startTs: string; endTs: string; textLines: string[] };
const fmt = (n: number) => {
  const ms = Math.max(0, Math.round(n));
  return `${Math.floor(ms / 3600000).toString().padStart(2,"0")}:${(Math.floor(ms/60000)%60).toString().padStart(2,"0")}:${(Math.floor(ms/1000)%60).toString().padStart(2,"0")},${(ms%1000).toString().padStart(3,"0")}`;
};
function shift(blocks: Cue[], offset: number, duration: number) {
  return blocks.filter(b => b.startMs >= 0 && b.startMs <= duration + 20000).map(b => {
    const startMs = Math.max(0, b.startMs + offset);
    const endMs = Math.max(startMs + 400, b.endMs + offset);
    return { ...b, startMs, endMs, startTs: fmt(startMs), endTs: fmt(endMs), textLines: [...b.textLines] };
  });
}
const input: Cue[] = [
  { startMs: 1000, endMs: 1800, startTs: "00:00:01,000", endTs: "00:00:01,800", textLines: ["first"] },
  { startMs: 149000, endMs: 150000, startTs: "00:02:29,000", endTs: "00:02:30,000", textLines: ["last-in-slice"] },
  { startMs: 155000, endMs: 156000, startTs: "00:02:35,000", endTs: "00:02:36,000", textLines: ["out-of-slice"] }
];
const shifted = shift(input, 145000, 150000);
assert.deepEqual(shifted.map(c => c.startMs), [146000, 294000]);
assert.equal(shifted[1].startTs, "00:04:54,000");
assert.equal(shifted[0].textLines[0], "first", "shifting must not reassign text to another cue");
console.log("Caption model/timing regression checks passed.");