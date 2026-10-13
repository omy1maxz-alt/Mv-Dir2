export interface ExternalImageOptions {
  prompt: string;
  aspectRatio?: string;
  addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

export interface CloudflareReferenceImage {
  data: string;
  description?: string;
}

export interface CloudflareOptions extends ExternalImageOptions {
  accountId?: string;
  apiToken?: string;
  model?: string;
  referenceImages?: CloudflareReferenceImage[];
  seed?: number;
}

export interface AIHordeOptions extends ExternalImageOptions {
  apiKey?: string;
  model?: string;
}

/**
 * Calculates dimensions for AI Horde based on aspect ratio
 */
const getDimensionsForHorde = (aspectRatio?: string): { width: number; height: number } => {
  switch (aspectRatio) {
    case '16:9': return { width: 768, height: 448 };
    case '9:16': return { width: 448, height: 768 };
    case '4:3': return { width: 640, height: 480 };
    case '3:4': return { width: 480, height: 640 };
    case '2.35:1': return { width: 832, height: 352 };
    case '14:9': return { width: 640, height: 416 };
    case '8:15': return { width: 384, height: 704 };
    case '1:1':
    default: return { width: 512, height: 512 };
  }
};

/**
 * Image dimensions for common aspect ratios. Cloudflare image models need width/height
 * in the model input; a prompt alone is not enough for consistent framing.
 */
const getImageDimensions = (aspectRatio?: string): { width: number; height: number } => {
  switch (aspectRatio) {
    case '16:9': return { width: 1024, height: 576 };
    case '9:16': return { width: 576, height: 1024 };
    case '4:3': return { width: 768, height: 576 };
    case '3:4': return { width: 576, height: 768 };
    case '2.35:1': return { width: 1024, height: 448 };
    case '14:9': return { width: 896, height: 576 };
    case '8:15': return { width: 512, height: 960 };
    case '1:1':
    default: return { width: 768, height: 768 };
  }
};

const readStoredProviderKeys = (): Record<string, any> => {
  try {
    const s = localStorage.getItem('mv_api_keys');
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
};

const responseErrorText = async (response: Response, tokenToRedact?: string): Promise<string> => {
  const text = (await response.text()).slice(0, 1200);
  return tokenToRedact
    ? text.replaceAll(tokenToRedact, '[redacted]').replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    : text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
};

const isCloudflareMultipartImageModel = (model: string) =>
  model === '@cf/black-forest-labs/flux-2-dev'
  || model === '@cf/black-forest-labs/flux-2-klein-4b'
  || model === '@cf/black-forest-labs/flux-2-klein-9b';

/**
 * FLUX.1 [schnell] has a documented 2,048-character prompt limit.
 * Preserve both the start (scene/subject) and end (style/quality constraints)
 * when shortening an oversized MV Director scene prompt.
 */
const fitCloudflarePromptToModelLimit = (
  rawPrompt: string,
  model: string,
  addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void
): string => {
  const maxCharacters = model === '@cf/black-forest-labs/flux-1-schnell' ? 2048 : null;
  const prompt = String(rawPrompt || '').trim();
  if (!maxCharacters) return prompt;

  const characters = Array.from(prompt);
  if (characters.length <= maxCharacters) return prompt;

  const bodyBudget = maxCharacters - 3; // room for " … "
  const headBudget = Math.floor(bodyBudget * 0.74);
  const tailBudget = bodyBudget - headBudget;
  let head = characters.slice(0, headBudget).join('').replace(/\s+\S*$/, '').trimEnd();
  let tail = characters.slice(-tailBudget).join('').replace(/^\S*\s+/, '').trimStart();
  let shortened = `${head} … ${tail}`;
  if (Array.from(shortened).length > maxCharacters) {
    shortened = Array.from(shortened).slice(0, maxCharacters).join('').trimEnd();
  }

  addLog?.(
    `FLUX.1 [schnell] supports prompts up to 2,048 characters. Condensed this scene prompt from ${characters.length} to ${Array.from(shortened).length} characters to prevent Cloudflare HTTP 400.`,
    'warning'
  );
  return shortened;
};

const imageToCloudflareDataUrl = async (source: string): Promise<string> => {
  const trimmed = String(source || '').trim();
  if (!trimmed) throw new Error('A reference image has no image data.');
  const dataUrl = trimmed.startsWith('data:') ? trimmed : `data:image/png;base64,${trimmed}`;

  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Could not decode a selected reference image for FLUX.2.'));
    image.src = dataUrl;
  });
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error('The selected reference image has no usable dimensions.');
  }

  // Cloudflare requires each FLUX.2 reference image to be smaller than 512x512.
  const scale = Math.min(1, 511 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Reference image resizing is unavailable in this browser.');
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL('image/jpeg', 0.9);
};

/**
 * Prepare one reference image for Cloudflare models that use an image_b64 input.
 */
const imageToCloudflareImageBase64 = async (source: string): Promise<string> => {
  const trimmed = String(source || '').trim();
  if (!trimmed) throw new Error('The selected reference image has no image data.');
  const dataUrl = trimmed.startsWith('data:') ? trimmed : `data:image/png;base64,${trimmed}`;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Could not decode the selected reference image for Cloudflare image-to-image generation.'));
    image.src = dataUrl;
  });
  if (!image.naturalWidth || !image.naturalHeight) {
    throw new Error('The selected reference image has no usable dimensions.');
  }

  // Keep a useful face/reference resolution while staying within common image payload limits.
  const scale = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Reference image resizing is unavailable in this browser.');
  context.drawImage(image, 0, 0, width, height);
  const base64 = canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  if (!base64) throw new Error('Could not encode the selected reference image for Cloudflare image-to-image generation.');
  return base64;
};

const cloudflareInputToMultipart = (input: Record<string, any>): FormData => {
  const form = new FormData();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (/^input_image_[0-3]$/.test(key) && typeof value === 'string') {
      const match = value.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
      const mimeType = match?.[1] || 'image/png';
      const base64 = match?.[2] || value.replace(/^data:[^,]*,/, '');
      let binary: string;
      try {
        binary = atob(base64);
      } catch {
        throw new Error(`Reference image field ${key} is not valid base64 data.`);
      }
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      const extension = mimeType.split('/')[1]?.replace(/[^a-zA-Z0-9]/g, '') || 'png';
      form.append(key, new Blob([bytes], { type: mimeType }), `${key}.${extension}`);
      continue;
    }
    form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return form;
};

const postCloudflareModel = async (args: {
  action: 'image' | 'text';
  model: string;
  input: Record<string, any>;
  accountId: string;
  apiToken: string;
  proxyUrl?: string;
  proxyToken?: string;
}): Promise<Response> => {
  const { action, model, input, accountId, apiToken, proxyUrl, proxyToken } = args;

  // A user-configured Worker is the reliable browser-to-server route inside
  // the Google AI Studio iframe. Its own CORS response allows the hosted UI origin.
  if (proxyUrl) {
    if (!proxyToken) {
      throw new Error('Cloudflare Worker Proxy URL is configured, but its Proxy Access Token is missing.');
    }
    let response: Response;
    try {
      response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${proxyToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ action, model, input })
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not reach the Cloudflare Worker Proxy. Verify the Worker URL, that it is deployed, and that its CORS preflight allows this app. ${message}`
      );
    }
    if (!response.ok) {
      const errorText = await responseErrorText(response, proxyToken);
      if (action === 'image' && isCloudflareMultipartImageModel(model) && /required properties.*multipart/i.test(errorText)) {
        throw new Error(
          'FLUX.2 requires multipart/form-data, but the configured Worker appears to be forwarding this request as JSON. Deploy the latest cloudflare-worker-proxy/worker.js from GitHub to the exact Worker URL saved in API Settings, then retry. GitHub source changes do not automatically update the live Cloudflare Worker.'
        );
      }
      throw new Error(`Cloudflare Worker Proxy Error (HTTP ${response.status}): ${errorText || response.statusText}`);
    }
    return response;
  }

  // First use the same-origin route in deployments that run this repository's
  // Express/Vite server. AI Studio's hosted preview usually does not run these routes.
  let proxyResponse: Response | undefined;
  try {
    proxyResponse = await fetch('/api/cloudflare-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, accountId, apiToken, model, input, ...input })
    });
  } catch {
    // Continue to the direct request below only if client credentials are available.
  }

  const proxyType = proxyResponse?.headers.get('content-type') || '';
  const looksLikeApiResponse = Boolean(
    proxyResponse && (proxyType.includes('application/json') || proxyType.startsWith('image/'))
  );
  if (proxyResponse && looksLikeApiResponse && proxyResponse.status !== 404 && proxyResponse.status !== 405) {
    return proxyResponse;
  }

  if (!accountId || !apiToken) {
    throw new Error(
      'Cloudflare credentials or a working proxy are missing. In Google AI Studio, deploy the included Cloudflare Worker Proxy, then configure its URL and access token in API Vault.'
    );
  }

  try {
    const target = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`;
    if (action === 'image' && isCloudflareMultipartImageModel(model)) {
      // The FLUX.2 endpoints require multipart/form-data. Let fetch set the boundary.
      return await fetch(target, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiToken}` },
        body: cloudflareInputToMultipart(input)
      });
    }
    return await fetch(target, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cloudflare Workers AI could not be reached from this browser. The direct Cloudflare API request is likely blocked by browser CORS in the AI Studio iframe; DNS/network blocking can produce the same error. Deploy the included Worker Proxy and set its URL and access token in API Vault. Details: ${message}`
    );
  }
};

/**
 * Generate image via Cloudflare Workers AI. In Google AI Studio, configure the
 * included Cloudflare Worker Proxy because browser calls to api.cloudflare.com
 * can fail CORS preflight in the hosted iframe.
 */
export async function generateImageCloudflare(options: CloudflareOptions): Promise<string> {
  const { prompt, addLog } = options;
  const model = options.model || '@cf/black-forest-labs/flux-1-schnell';
  const storedKeys = readStoredProviderKeys();

  const accountId = options.accountId || storedKeys.cloudflareAccountId || localStorage.getItem('cf_account_id') || '';
  const apiToken = options.apiToken || storedKeys.cloudflareApiToken || localStorage.getItem('cf_api_token') || '';
  const proxyUrl = String(storedKeys.cloudflareWorkerProxyUrl || '').trim();
  const proxyToken = String(storedKeys.cloudflareWorkerProxyToken || '').trim();
  const { width, height } = getImageDimensions(options.aspectRatio);

  // These model IDs use distinct input contracts. Keep this shared adapter limited
  // to the JSON-schema image models so prompts/aspect ratios remain predictable.
  const cloudflarePrompt = fitCloudflarePromptToModelLimit(prompt, model, addLog);
  const modelInput: Record<string, any> = { prompt: cloudflarePrompt, width, height };
  const isMultipartModel = isCloudflareMultipartImageModel(model);
  if (isMultipartModel) {
    // FLUX.2 supports an optional seed; pass the scene seed when supplied.
    if (typeof options.seed === 'number' && Number.isFinite(options.seed)) {
      modelInput.seed = Math.trunc(options.seed);
    }
    const references = (options.referenceImages || []).filter(reference => typeof reference?.data === 'string' && reference.data.trim());
    if (references.length > 4) {
      throw new Error(`Cloudflare FLUX.2 accepts at most four reference images, but ${references.length} were supplied. Reduce references before generation; the adapter will not silently drop any selected face.`);
    }
    for (let index = 0; index < references.length; index++) {
      modelInput[`input_image_${index}`] = await imageToCloudflareDataUrl(references[index].data);
    }
    if (references.length > 0) {
      addLog?.(`Preparing ${references.length} reference image(s) for FLUX.2 multipart editing (max 4, resized to 512px).`, 'info');
    }
  } else if ((model === '@cf/stabilityai/stable-diffusion-xl-base-1.0' || model === '@cf/runwayml/stable-diffusion-v1-5-inpainting') && (options.referenceImages || []).length > 0) {
    const references = (options.referenceImages || []).filter(reference => typeof reference?.data === 'string' && reference.data.trim());
    if (references.length !== 1) {
      throw new Error(`Cloudflare ${model} supports one reference image in this MV Director adapter. ${references.length} references were supplied. Select one face/reference image, or use FLUX.2 for up to four references.`);
    }
    modelInput.image_b64 = await imageToCloudflareImageBase64(references[0].data);
    modelInput.num_steps = 20;
    modelInput.strength = 0.72;
    modelInput.guidance = 7.5;
    addLog?.(`Preparing one reference image for ${model} (1024px max; 20 steps).`, 'info');
  } else if ((options.referenceImages || []).length > 0) {
    throw new Error(`The selected Cloudflare model (${model}) has no reference-image input in this adapter. MV Director will not discard the selected face/frame images. Choose FLUX.2 [dev], Klein 4B/9B, SDXL Base, or a Gemini/KIE reference-capable model.`);
  }
  if (model === '@cf/black-forest-labs/flux-1-schnell') {
    // FLUX.1 schnell only accepts prompt/steps; dimensions are not in its schema.
    delete modelInput.width;
    delete modelInput.height;
    modelInput.steps = 4;
  } else if (model === '@cf/stabilityai/stable-diffusion-xl-lightning') {
    modelInput.num_steps = 4;
  } else if (model === '@cf/stabilityai/stable-diffusion-xl-base-1.0') {
    // Cloudflare's official schema supports up to 20 diffusion steps.
    modelInput.num_steps = 20;
  } else if (model === '@cf/runwayml/stable-diffusion-v1-5-inpainting') {
    // Supports text-to-image and optional img2img; mask-based editing requires a mask.
    modelInput.num_steps = 20;
  } else if (model === '@cf/leonardo/lucid-origin') {
    modelInput.width = Math.min(width, 2500);
    modelInput.height = Math.min(height, 2500);
    modelInput.steps = 30;
  } else if (model === '@cf/leonardo/phoenix-1.0') {
    modelInput.width = Math.min(width, 2048);
    modelInput.height = Math.min(height, 2048);
    modelInput.num_steps = 25;
  } else if (model === '@cf/lykon/dreamshaper-8-lcm') {
    modelInput.num_steps = 8;
  }

  addLog?.(`Connecting to Cloudflare Workers AI (${model})...`, 'info');

  const response = await postCloudflareModel({
    action: 'image',
    model,
    input: modelInput,
    accountId,
    apiToken,
    proxyUrl,
    proxyToken
  });

  if (!response.ok) {
    const errorText = await responseErrorText(response, apiToken || proxyToken);
    if (isMultipartModel && /required properties.*multipart/i.test(errorText)) {
      throw new Error(
        'FLUX.2 requires multipart/form-data, but the configured Worker appears to be forwarding this request as JSON. Deploy the latest cloudflare-worker-proxy/worker.js from GitHub to the exact Worker URL saved in API Settings, then retry. GitHub source changes do not automatically update the live Cloudflare Worker.'
      );
    }
    throw new Error(`Cloudflare Workers AI Error (HTTP ${response.status}): ${errorText || response.statusText || 'Request rejected'}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error('Cloudflare Workers AI returned invalid JSON.');
    }

    const encodedImage = typeof data.result?.image === 'string'
      ? data.result.image
      : typeof data.result === 'string'
        ? data.result
        : '';
    if (encodedImage) {
      addLog?.('Cloudflare Workers AI successfully rendered image.', 'success');
      return `data:image/png;base64,${encodedImage}`;
    }

    const providerMessage = typeof data.errors?.[0]?.message === 'string'
      ? data.errors[0].message
      : typeof data.error === 'string'
        ? data.error
        : 'No image data was returned.';
    throw new Error(`Cloudflare Workers AI returned an unexpected JSON response: ${providerMessage.slice(0, 300)}`);
  }

  if (!contentType.startsWith('image/')) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Cloudflare Workers AI returned an unexpected content type (${contentType || 'unknown'}): ${body}`);
  }

  const blob = await response.blob();
  if (!blob.size) throw new Error('Cloudflare Workers AI returned an empty image response.');

  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('Unable to encode the Cloudflare image response.'));
    reader.onerror = () => reject(new Error('Unable to read the Cloudflare image response.'));
    reader.readAsDataURL(blob);
  });

  addLog?.('Cloudflare Workers AI successfully rendered image.', 'success');
  return base64;
}

/**
 * Run a Cloudflare Workers AI text model using the current text-generation request.
 */
export async function generateTextCloudflare(options: {
  model: string;
  input: Record<string, any>;
  addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}): Promise<string> {
  const storedKeys = readStoredProviderKeys();
  const accountId = String(storedKeys.cloudflareAccountId || localStorage.getItem('cf_account_id') || '');
  const apiToken = String(storedKeys.cloudflareApiToken || localStorage.getItem('cf_api_token') || '');
  const proxyUrl = String(storedKeys.cloudflareWorkerProxyUrl || '').trim();
  const proxyToken = String(storedKeys.cloudflareWorkerProxyToken || '').trim();

  const response = await postCloudflareModel({
    action: 'text',
    model: options.model,
    input: options.input,
    accountId,
    apiToken,
    proxyUrl,
    proxyToken
  });

  if (!response.ok) {
    const errorText = await responseErrorText(response, apiToken || proxyToken);
    throw new Error(`Cloudflare Text Generation Error (HTTP ${response.status}): ${errorText || response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Cloudflare text model returned unexpected content type (${contentType || 'unknown'}): ${body}`);
  }

  const data = await response.json();
  const result = data.result;
  const text = typeof result?.response === 'string'
    ? result.response
    : typeof result?.text === 'string'
      ? result.text
      : typeof result === 'string'
        ? result
        : typeof data.response === 'string'
          ? data.response
          : '';
  if (!text) {
    const detail = typeof data.errors?.[0]?.message === 'string' ? data.errors[0].message : 'No text field was returned.';
    throw new Error(`Cloudflare text model returned an empty response: ${detail.slice(0, 300)}`);
  }
  return text;
}

/**
 * Generate image via AI Horde (aihorde.net)
 * Decentralized, crowdsourced volunteer GPU cluster.
 * Uses anonymous key ("0000000000") by default or user API key with kudos for higher priority.
 */
export async function generateTextAIHorde(options: {
  prompt: string;
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}): Promise<string> {
  const storedKeys = readStoredProviderKeys();
  const apiKey = options.apiKey || storedKeys.aiHordeApiKey || localStorage.getItem('aihorde_api_key') || '0000000000';
  const isAnonymous = apiKey === '0000000000';
  addLog?.(
    isAnonymous
      ? 'Submitting text job to AI Horde (anonymous requests have the lowest queue priority)...'
      : 'Submitting text job to AI Horde with your account priority...',
    'info'
  );

  const response = await fetch('https://aihorde.net/api/v2/generate/text/async', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
      'Client-Agent': 'mv-director:1.0:web'
    },
    body: JSON.stringify({
      prompt: options.prompt,
      params: {
        max_context_length: 4096,
        max_length: Math.min(Math.max(options.maxTokens || 1024, 128), 4096),
        temperature: Math.min(Math.max(options.temperature ?? 0.4, 0), 2),
        top_p: 0.9,
        top_k: 0,
        rep_pen: 1.08
      },
      ...(options.model ? { models: [options.model] } : {})
    })
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 700);
    throw new Error(`AI Horde text request failed (HTTP ${response.status}): ${detail}`);
  }

  const data = await response.json();
  const jobId = data.id;
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('AI Horde did not return a valid text Job ID.');
  }
  addLog?.(`AI Horde text job queued (${jobId.slice(0, 8)}...). Waiting for a volunteer worker...`, 'info');

  const maxAttempts = 180; // Up to ~6 minutes, including volunteer queue time.
  let attempts = 0;
  let completed = false;
  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    attempts++;
    try {
      const checkRes = await fetch(`https://aihorde.net/api/v2/generate/text/check/${jobId}`, {
        headers: { 'Client-Agent': 'mv-director:1.0:web' }
      });
      if (!checkRes.ok) {
        if (attempts % 10 === 0) addLog?.(`AI Horde text status returned HTTP ${checkRes.status}; retrying...`, 'warning');
        continue;
      }
      const checkData = await checkRes.json();
      if (checkData.faulted) throw new Error('AI Horde text job faulted on the volunteer worker.');
      if (checkData.done) {
        completed = true;
        break;
      }
      if (checkData.queue_position !== undefined && attempts % 5 === 0) {
        addLog?.(
          checkData.queue_position > 0
            ? `AI Horde text queue position: #${checkData.queue_position} (estimated wait: ${Math.round(checkData.wait_time || 0)}s)...`
            : 'AI Horde text worker is generating the response...',
          'info'
        );
      }
    } catch (error: any) {
      if (error.message?.includes('faulted')) throw error;
    }
  }

  if (!completed) {
    throw new Error(`AI Horde text job ${jobId.slice(0, 8)} is still queued or processing after 6 minutes. It was not resubmitted; retry later to avoid duplicate jobs.`);
  }

  const statusRes = await fetch(`https://aihorde.net/api/v2/generate/text/status/${jobId}`, {
    headers: { 'Client-Agent': 'mv-director:1.0:web' }
  });
  if (!statusRes.ok) {
    throw new Error(`Failed to retrieve completed AI Horde text response (HTTP ${statusRes.status}).`);
  }
  const statusData = await statusRes.json();
  const text = statusData.generations?.[0]?.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('AI Horde text job completed without returning generated text.');
  }
  return text.trim();
}

export async function generateImageAIHorde(options: AIHordeOptions): Promise<string> {
  const { prompt, aspectRatio, addLog } = options;

  const storedKeys = (() => {
    try {
      const s = localStorage.getItem('mv_api_keys');
      return s ? JSON.parse(s) : {};
    } catch {
      return {};
    }
  })();

  const apiKey = options.apiKey || storedKeys.aiHordeApiKey || localStorage.getItem('aihorde_api_key') || '0000000000';
  const isAnonymous = apiKey === '0000000000';

  const { width, height } = getDimensionsForHorde(aspectRatio);

  addLog?.(
    isAnonymous
      ? 'Submitting job to AI Horde (Anonymous mode - queue depends on volunteer GPUs)...'
      : 'Submitting job to AI Horde with user priority key...',
    'info'
  );

  const initResponse = await fetch('https://aihorde.net/api/v2/generate/async', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
      'Client-Agent': 'mv-director:1.0:web'
    },
    body: JSON.stringify({
      prompt,
      params: {
        width,
        height,
        steps: 25,
        sampler_name: 'k_euler_a',
        cfg_scale: 7.5
      },
      models: options.model ? [options.model] : ['stable_diffusion', 'SDXL 1.0', 'ICBINP - I Can\'t Believe It\'s Not Photography']
    })
  });

  if (!initResponse.ok) {
    const err = await initResponse.text();
    throw new Error(`AI Horde Request Failed (${initResponse.status}): ${err}`);
  }

  const initData = await initResponse.json();
  const jobId = initData.id;
  if (!jobId) {
    throw new Error('AI Horde did not return a valid Job ID.');
  }

  addLog?.(`AI Horde Job queued (ID: ${jobId.slice(0, 8)}...). Polling worker status...`, 'info');

  // Volunteer capacity varies. Allow a longer queue window and never fetch status
  // as if the job had completed when the polling window has expired.
  const maxAttempts = 180; // Up to ~6 minutes
  let attempts = 0;
  let completed = false;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 2000));
    attempts++;

    try {
      const checkRes = await fetch(`https://aihorde.net/api/v2/generate/check/${jobId}`, {
        headers: { 'Client-Agent': 'mv-director:1.0:web' }
      });
      if (!checkRes.ok) {
        if (attempts % 10 === 0) {
          addLog?.(`AI Horde status check returned HTTP ${checkRes.status}; retrying...`, 'warning');
        }
        continue;
      }

      const checkData = await checkRes.json();
      if (checkData.faulted) {
        throw new Error('AI Horde job reported a fault during rendering. Try another model or retry.');
      }
      if (checkData.done) {
        completed = true;
        break;
      }
      if (checkData.queue_position !== undefined && attempts % 5 === 0) {
        addLog?.(
          checkData.queue_position > 0
            ? `AI Horde queue position: #${checkData.queue_position} (estimated wait: ${Math.round(checkData.wait_time || 0)}s)...`
            : 'AI Horde worker is processing the image...',
          'info'
        );
      }
    } catch (e: any) {
      if (e.message?.includes('fault')) throw e;
      // A transient poll failure is retried; do not resubmit the paid/queued job.
    }
  }

  if (!completed) {
    throw new Error(`AI Horde image job ${jobId.slice(0, 8)} is still queued or processing after 6 minutes. It was not resubmitted. Retry later to avoid duplicate jobs.`);
  }

  // Fetch final status only after the check endpoint confirms completion.
  const statusRes = await fetch(`https://aihorde.net/api/v2/generate/status/${jobId}`, {
    headers: { 'Client-Agent': 'mv-director:1.0:web' }
  });

  if (!statusRes.ok) {
    throw new Error(`Failed to retrieve finished image from AI Horde (${statusRes.status}).`);
  }

  const statusData = await statusRes.json();
  const generation = statusData.generations?.[0];

  if (!generation?.img) {
    throw new Error('AI Horde job completed but returned no image data.');
  }

  const imgData = generation.img;

  // img can be a URL or direct base64
  if (imgData.startsWith('http://') || imgData.startsWith('https://')) {
    addLog?.('Fetching rendered image from AI Horde storage...', 'info');
    const imgFetch = await fetch(imgData);
    if (!imgFetch.ok) {
      throw new Error(`Failed to download AI Horde image (HTTP ${imgFetch.status}).`);
    }
    const blob = await imgFetch.blob();
    if (!blob.size) throw new Error('AI Horde returned an empty image download.');
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') resolve(reader.result);
        else reject(new Error('Unable to encode the AI Horde image.'));
      };
      reader.onerror = () => reject(new Error('Unable to read the AI Horde image.'));
      reader.readAsDataURL(blob);
    });
  }

  if (imgData.startsWith('data:')) {
    return imgData;
  }

  // AI Horde normally returns base64-encoded image bytes. Detect common formats
  // so the browser does not try to decode a PNG/JPEG as WebP.
  const mime = imgData.startsWith('iVBOR') ? 'image/png'
    : imgData.startsWith('/9j/') ? 'image/jpeg'
    : imgData.startsWith('R0lGOD') ? 'image/gif'
    : imgData.startsWith('UklGR') ? 'image/webp'
    : 'image/png';
  return `data:${mime};base64,${imgData}`;
}
