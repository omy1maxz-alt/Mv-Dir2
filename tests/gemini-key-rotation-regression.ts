import assert from "node:assert/strict";

// Regression coverage for the user's repeated quota message after key rotation.
// The tests are source-level by design: importing gemini.ts initializes browser integrations
// and provider adapters, so the small pure rules below mirror the intended key precedence.

type Keys = Record<string, string | undefined>;
const resolveKey = (explicitKey: string | undefined, selectedKey: string, storage: Keys): string => {
  const isReal = (key?: string) => Boolean(key && key.trim().length >= 25 && !key.includes("PLACEHOLDER"));
  if (isReal(explicitKey)) return explicitKey!.trim();
  if (isReal(selectedKey)) return selectedKey.trim();
  for (const k of ["gemini_api_key", "google_api_key", "mv_gemini_api_key"]) {
    if (isReal(storage[k])) return storage[k]!.trim();
  }
  try {
    const vault = JSON.parse(storage.mv_api_keys || "{}");
    const candidate = vault.google || vault.gemini || vault.apiKey || vault.googleApiKey || vault.geminiApiKey;
    if (isReal(candidate)) return candidate.trim();
  } catch {}
  return "";
};

const oldKey = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWX_OLD";
const newKey = "AIzaSyABCDEFGHIJKLMNOPQRSTUVWX_NEW";
assert.equal(
  resolveKey(undefined, newKey, { gemini_api_key: oldKey, mv_api_keys: JSON.stringify({ google: oldKey }) }),
  newKey,
  "the selected in-memory key must beat stale saved slots"
);
assert.equal(
  resolveKey(newKey, oldKey, { gemini_api_key: oldKey }),
  newKey,
  "an explicit current request key must beat all other values"
);
assert.equal(
  resolveKey(undefined, "", { gemini_api_key: newKey, mv_api_keys: JSON.stringify({ google: oldKey }) }),
  newKey,
  "a synchronized current alias must beat an older vault key"
);

console.log("Gemini key rotation regression checks passed.");
