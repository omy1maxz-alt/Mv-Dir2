export interface ExternalImageOptions {
  prompt: string;
  aspectRatio?: string;
  addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

export interface CloudflareOptions extends ExternalImageOptions {
  accountId?: string;
  apiToken?: string;
  model?: string;
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
    case '1:1':
    default: return { width: 512, height: 512 };
  }
};

/**
 * Generate image via Cloudflare Workers AI (FLUX.1 [schnell] or SDXL)
 * Endpoint: https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}
 */
export async function generateImageCloudflare(options: CloudflareOptions): Promise<string> {
  const { prompt, addLog } = options;
  const model = options.model || '@cf/black-forest-labs/flux-1-schnell';

  const storedKeys = (() => {
    try {
      const s = localStorage.getItem('mv_api_keys');
      return s ? JSON.parse(s) : {};
    } catch {
      return {};
    }
  })();

  const accountId = options.accountId || storedKeys.cloudflareAccountId || localStorage.getItem('cf_account_id') || '';
  const apiToken = options.apiToken || storedKeys.cloudflareApiToken || localStorage.getItem('cf_api_token') || '';

  const hasClientCredentials = Boolean(accountId && apiToken);
  if (!hasClientCredentials) {
    addLog?.('No complete client-side Cloudflare credentials found; checking whether the server has securely configured credentials...', 'info');
  }

  addLog?.(`Connecting to Cloudflare Workers AI (${model})...`, 'info');

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  let response: Response | undefined;
  let proxyUnavailable = false;
  try {
    // Prefer the same-origin server route where this full-stack app is deployed.
    // Server environment variables can supply credentials without putting them in the browser.
    const proxyPayload = { accountId, apiToken, model, prompt };
    let proxyResponse: Response | undefined;
    try {
      proxyResponse = await fetch('/api/cloudflare-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(proxyPayload)
      });
    } catch {
      proxyUnavailable = true;
    }

    const proxyType = proxyResponse?.headers.get('content-type') || '';
    const proxyLooksLikeImageApi = Boolean(
      proxyResponse &&
      (proxyType.includes('application/json') || proxyType.startsWith('image/'))
    );
    // Vite/SPA hosting can answer an unknown API path with index.html (HTTP 200).
    // Treat HTML or an unknown route as unavailable instead of misreporting it as an image.
    if (proxyResponse && proxyLooksLikeImageApi && proxyResponse.status !== 404 && proxyResponse.status !== 405) {
      response = proxyResponse;
    } else {
      proxyUnavailable = true;
    }
  } catch {
    proxyUnavailable = true;
  }

  if (!response) {
    if (!hasClientCredentials) {
      throw new Error(
        'Cloudflare credentials are not available in the client, and the same-origin server proxy did not respond as an image API. Configure CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN on a trusted server, or configure both values in Settings -> API Vault.'
      );
    }
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt })
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isNetworkFailure = error instanceof TypeError && /fetch/i.test(message);
      const detail = isNetworkFailure
        ? 'The browser could not read a response. This commonly indicates a CORS restriction, DNS/network failure, or a blocked request. Check the browser Network/Console panel to distinguish them.'
        : message;
      addLog?.(`Cloudflare Workers AI request failed: ${detail}`, 'error');
      throw new Error(`Cloudflare Workers AI request failed before an HTTP response was available. ${detail}`);
    }
  }

  if (!response) {
    throw new Error(proxyUnavailable
      ? 'Cloudflare image request could not reach either the same-origin proxy or Cloudflare API.'
      : 'Cloudflare image request failed without a response.');
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new Error('Cloudflare Workers AI returned invalid JSON.');
    }
    if (typeof data.result?.image === 'string' && data.result.image.length > 0) {
      addLog?.('Cloudflare Workers AI successfully rendered image.', 'success');
      return `data:image/jpeg;base64,${data.result.image}`;
    }
    const providerMessage = typeof data.errors?.[0]?.message === 'string'
      ? data.errors[0].message
      : 'No result.image field was returned.';
    throw new Error(`Cloudflare Workers AI returned an unexpected JSON response: ${providerMessage.slice(0, 300)}`);
  }

  // Direct binary stream (image/png or image/jpeg)
  if (!contentType.startsWith('image/')) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`Cloudflare Workers AI returned an unexpected content type (${contentType || 'unknown'}): ${body}`);
  }

  const blob = await response.blob();
  if (!blob.size) {
    throw new Error('Cloudflare Workers AI returned an empty image response.');
  }
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Unable to encode the Cloudflare image response.'));
    };
    reader.onerror = () => reject(new Error('Unable to read the Cloudflare image response.'));
    reader.readAsDataURL(blob);
  });

  addLog?.('Cloudflare Workers AI successfully rendered image.', 'success');
  return base64;
}

/**
 * Generate image via AI Horde (aihorde.net)
 * Decentralized, crowdsourced volunteer GPU cluster.
 * Uses anonymous key ("0000000000") by default or user API key with kudos for higher priority.
 */
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

  // Poll status
  const maxAttempts = 60; // Up to ~2 minutes
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise((r) => setTimeout(r, 2000));
    attempts++;

    try {
      const checkRes = await fetch(`https://aihorde.net/api/v2/generate/check/${jobId}`, {
        headers: { 'Client-Agent': 'mv-director:1.0:web' }
      });
      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.done) {
          break;
        }
        if (checkData.faulted) {
          throw new Error('AI Horde job reported a fault/error during rendering.');
        }
        if (checkData.queue_position !== undefined && checkData.queue_position > 0) {
          if (attempts % 5 === 0) {
            addLog?.(
              `AI Horde Queue Position: #${checkData.queue_position} (Estimated wait: ${Math.round(checkData.wait_time || 0)}s)...`,
              'info'
            );
          }
        }
      }
    } catch (e: any) {
      if (e.message?.includes('fault')) throw e;
    }
  }

  // Fetch final status
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
    const blob = await imgFetch.blob();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  if (imgData.startsWith('data:')) {
    return imgData;
  }

  return `data:image/webp;base64,${imgData}`;
}
