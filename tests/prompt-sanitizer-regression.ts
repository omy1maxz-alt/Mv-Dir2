import assert from "node:assert/strict";
import { sanitizeImagePrompt } from "../src/services/gemini.ts";

// Regression: app-level cleanup must not rewrite mature, non-explicit fashion/glamour prompts.
const glamourPrompt =
  "Clearly adult fashion model, sensual editorial styling, revealing evening dress, confident glamour pose.";
assert.equal(sanitizeImagePrompt(glamourPrompt), glamourPrompt);

// Cleanup for unrelated graphic content should remain active.
assert.equal(
  sanitizeImagePrompt("A bloodstained wall in a cinematic scene."),
  "A crimson glow wall in a cinematic scene."
);

console.log("Prompt sanitizer regression checks passed.");
