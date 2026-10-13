export type ImageModelOption = { value: string; label: string };
export type ImageModelOptionGroup = { label: string; options: ImageModelOption[] };

/**
 * Curated image models for the always-available Storyboard model picker.
 * These mirror the supported fallback choices in API & Account Settings;
 * the settings screen may further filter Cloudflare options using its live catalog.
 */
export const STORYBOARD_IMAGE_MODEL_GROUPS: ImageModelOptionGroup[] = [
  {
    label: "Google Gemini Direct (Native @google/genai / AI Studio)",
    options: [
      { value: "gemini-nano-banana-2.1", label: "Gemini Nano Banana 2.1 (Google Flagship — 4K / Multi-Reference / Consistent Characters)" },
      { value: "gemini-3.1-flash-lite-image", label: "Gemini 3.1 Flash-Lite Image (Google Official Default — Fast & Multimodal)" },
      { value: "gemini-3-pro-image", label: "Gemini 3 Pro Image (Nano Banana Pro — 4K / Deep Reasoning)" },
      { value: "gemini-3.1-flash-image", label: "Gemini 3.1 Flash Image (AI Studio Direct Alias)" },
      { value: "gemini-2.5-flash-image", label: "Gemini 2.5 Flash Image (Legacy Direct GCP)" },
      { value: "imagen-3.0-generate-002", label: "Imagen 3.0 (Direct GCP / Vertex AI Dedicated Photorealistic Image Model)" }
    ]
  },
  {
    label: "KIE AI — Google Nano Banana (Uses Kie AI API Key)",
    options: [
      { value: "kie:google/nano-banana-2-1", label: "KIE Nano Banana 2.1 (Gemini 3.1 Flash Image — 4K / Multi-Reference)" },
      { value: "kie:google/nano-banana-2", label: "KIE Nano Banana 2 (Gemini 3.1 Flash Image — High Quality)" },
      { value: "kie:google/nano-banana-pro", label: "KIE Nano Banana Pro (Gemini 3.0 Pro Image — 4K / Production)" },
      { value: "kie:google/nano-banana", label: "KIE Nano Banana (Gemini 2.5 Flash Image — Fast)" },
      { value: "kie:google/nano-banana-2-lite", label: "KIE Nano Banana 2 Lite (Gemini 3.1 Flash-Lite Image)" },
      { value: "kie:google/nano-banana-edit", label: "KIE Nano Banana Edit (Prompt Image Editing)" }
    ]
  },
  {
    label: "KIE AI — OpenAI & xAI Image (Uses Kie AI API Key)",
    options: [
      { value: "kie:gpt-image-2-5", label: "KIE GPT Image 2.5 (OpenAI Multimodal / Image Generation & Editing)" },
      { value: "kie:grok-imagine-image-2", label: "KIE Grok Imagine Image 2.0 (xAI Generation & Editing)" }
    ]
  },
  {
    label: "Cloudflare Workers AI (Supported Image Models)",
    options: [
      { value: "cloudflare:@cf/leonardo/lucid-origin", label: "Lucid Origin — Best for prompt adherence, detailed cinematic art & specific direction" },
      { value: "cloudflare:@cf/leonardo/phoenix-1.0", label: "Phoenix 1.0 — Strong prompt adherence, stylized concepts & coherent text" },
      { value: "cloudflare:@cf/black-forest-labs/flux-1-schnell", label: "FLUX.1 [schnell] — Fast drafts & iteration" },
      { value: "cloudflare:@cf/black-forest-labs/flux-2-dev", label: "FLUX.2 [dev] — High-quality generation with up to 4 reference images" },
      { value: "cloudflare:@cf/black-forest-labs/flux-2-klein-4b", label: "FLUX.2 [klein] 4B — Faster reference-guided drafts (4 fixed steps)" },
      { value: "cloudflare:@cf/black-forest-labs/flux-2-klein-9b", label: "FLUX.2 [klein] 9B — Reference-guided generation with enhanced quality (4 fixed steps)" },
      { value: "cloudflare:@cf/lykon/dreamshaper-8-lcm", label: "DreamShaper 8 LCM — Photorealistic / stylized exploration" },
      { value: "cloudflare:@cf/stabilityai/stable-diffusion-xl-base-1.0", label: "Stable Diffusion XL Base — $0.00 per step; supports one reference image" },
      { value: "cloudflare:@cf/bytedance/stable-diffusion-xl-lightning", label: "Stable Diffusion XL Lightning — $0.00 per step (fast drafts)" },
      { value: "cloudflare:@cf/runwayml/stable-diffusion-v1-5-inpainting", label: "Stable Diffusion 1.5 Inpainting — text-to-image, optional one-image img2img; mask required for inpainting" }
    ]
  },
  {
    label: "AI Horde (Decentralized Volunteer GPUs • Crowdsourced Free)",
    options: [
      { value: "aihorde", label: "AI Horde (Crowdsourced Volunteer Cluster • Free / 0-Key or Priority Kudos)" }
    ]
  },
  {
    label: "Free Public Providers (No API Key Required)",
    options: [
      { value: "pollinations", label: "Pollinations (Free Public API, No Key)" }
    ]
  }
];
