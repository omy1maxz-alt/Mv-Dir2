import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("src/services/gemini.ts", "utf8");

// Quota/auth failures must stay with the selected provider; KIE is only used when selected explicitly.
assert.equal(source.includes("Auto-routing to KIE"), false, "quota errors must not auto-route to KIE");
assert.equal(source.includes("Gemini Quota Auto-Routing"), false, "the old automatic KIE fallback must be removed");
assert.equal(source.includes("model: 'kie:google/nano-banana-2-1'"), false, "quota handling must not hard-code an automatic KIE model");
assert.equal(source.includes("currentImageModel.startsWith('kie:')"), true, "manual KIE model selection must remain supported");

// Explicit quota and permission failures should surface immediately; transient server failures can retry.
assert.equal(
  source.includes("if (((isRateLimit && !isQuotaExceeded) || isServerError) && retries < maxRetries) {"),
  true,
  "do not retry explicit quota exhaustion or deterministic permission failures"
);

console.log("No-auto-KIE regression checks passed.");
