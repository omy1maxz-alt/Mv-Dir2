export interface SunoCoverOptions {
    uploadUrl?: string;
    prompt: string;
    style: string;
    title: string;
    apiKey: string;
    model?: string; // 'V6' | 'V6_WILD' | 'V6_MINI' | 'V5_5' | 'V5' | 'V4' | 'V3_5'
    instrumental?: boolean;
    addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
    onStatus?: (msg: string) => void;
    onTaskId?: (taskId: string) => void;
    
    // Additional parameters
    negativeTags?: string;
    vocalGender?: string;
    styleWeight?: number;
    weirdnessConstraint?: number;
    audioWeight?: number;
    personaId?: string;
    personaModel?: string;
    variety?: number;
}

export const extractKieTaskId = (data: any): string | null => {
    if (!data) return null;
    if (typeof data === 'string' && data.trim()) return data.trim();
    if (typeof data.data === 'string' && data.data.trim()) return data.data.trim();
    return (
        data.data?.taskId ||
        data.data?.task_id ||
        data.data?.id ||
        data.data?.jobId ||
        data.data?.job_id ||
        data.taskId ||
        data.task_id ||
        data.id ||
        data.jobId ||
        data.job_id ||
        data.result?.taskId ||
        data.result?.id ||
        null
    );
};

export const extractAudioTracksFromKieResponse = (pollData: any): { name: string; url: string }[] => {
    const tracks: { name: string; url: string }[] = [];
    const seenUrls = new Set<string>();

    const safeParseJson = (val: any) => {
        if (typeof val === 'string') {
            const trimmed = val.trim();
            if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                try {
                    return JSON.parse(trimmed);
                } catch {
                    return val;
                }
            }
        }
        return val;
    };

    const addTrack = (name: string, url: any) => {
        if (typeof url !== 'string') return;
        const cleanUrl = url.trim();
        if (!cleanUrl || !cleanUrl.startsWith('http') || seenUrls.has(cleanUrl)) return;
        seenUrls.add(cleanUrl);
        tracks.push({
            name: name || `Audio Track ${tracks.length + 1}`,
            url: cleanUrl
        });
    };

    const traverse = (node: any, currentTitle?: string, currentId?: string) => {
        if (!node) return;
        node = safeParseJson(node);

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                const item = safeParseJson(node[i]);
                if (typeof item === 'string') {
                    if (item.startsWith('http://') || item.startsWith('https://')) {
                        if (item.match(/\.(mp3|wav|m4a|aac|ogg|mp4|webm)(\?.*)?$/i) || item.includes('suno') || item.includes('audio') || item.includes('music')) {
                            addTrack(currentTitle || `Track ${tracks.length + 1}`, item);
                        }
                    }
                } else if (typeof item === 'object' && item !== null) {
                    const itemTitle = item.title || item.name || item.prompt || currentTitle;
                    const itemId = item.id || item.audio_id || item.audioId || item.clip_id || item.clipId || currentId;
                    traverse(item, itemTitle, itemId);
                }
            }
            return;
        }

        if (typeof node === 'object' && node !== null) {
            const title = node.title || node.name || node.prompt || currentTitle;
            const id = node.id || node.audio_id || node.audioId || node.clip_id || node.clipId || currentId;
            const displayName = id ? `[${id}] ${title || 'Audio Track'}` : (title || 'Audio Track');

            // Check all known direct audio/video properties
            const candidateFields = [
                node.audioUrl,
                node.audio_url,
                node.audio,
                node.url,
                node.stream_url,
                node.streamUrl,
                node.mp3_url,
                node.mp3Url,
                node.download_url,
                node.downloadUrl,
                node.file_url,
                node.fileUrl,
                node.music_url,
                node.musicUrl,
                node.media_url,
                node.mediaUrl,
                node.source_url,
                node.sourceUrl,
                node.video_url,
                node.videoUrl
            ];

            for (const field of candidateFields) {
                if (typeof field === 'string' && (field.startsWith('http://') || field.startsWith('https://'))) {
                    addTrack(displayName, field);
                }
            }

            // Also traverse nested properties (such as response, result, sunoData, data, clips, tracks, output, meta)
            for (const key of Object.keys(node)) {
                // Avoid infinite loops on non-object / circular references
                const child = node[key];
                if (child && (typeof child === 'object' || typeof child === 'string')) {
                    traverse(child, title, id);
                }
            }
        }
    };

    traverse(pollData);
    return tracks;
};

export const checkSunoTaskStatus = async (taskId: string, apiKey: string): Promise<{name: string, url: string}[]> => {
    let pollData: any = null;
    let lastError = '';

    const endpoints = [
        `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`,
        `https://api.kie.ai/api/v1/generate/record-info?taskId=${taskId}`
    ];

    for (const url of endpoints) {
        try {
            const res = await fetch(url, {
                method: "GET",
                headers: { "Authorization": `Bearer ${apiKey}` }
            });
            if (res.ok) {
                const json = await res.json();
                if (json && (json.code === 200 || json.code === 0 || json.data)) {
                    pollData = json;
                    // If tracks already present, we can return immediately
                    const immediateTracks = extractAudioTracksFromKieResponse(json);
                    if (immediateTracks.length > 0) {
                        return immediateTracks;
                    }
                }
            } else {
                const errText = await res.text();
                lastError = `HTTP ${res.status}: ${errText}`;
            }
        } catch (e: any) {
            lastError = e?.message || 'Network error';
        }
    }

    if (pollData && (pollData.data || pollData.response || pollData.result)) {
        const payloadData = pollData.data || pollData;
        const status = (payloadData.status || payloadData.state || pollData.status || '').toUpperCase();
        
        if (status === "SUCCESS" || status === "COMPLETED" || !status) {
            const tracks = extractAudioTracksFromKieResponse(pollData);
            if (tracks.length > 0) {
                return tracks;
            }
            const snippet = JSON.stringify(pollData).slice(0, 400);
            throw new Error(`Task succeeded but no audio URL was found in response. Response: ${snippet}`);
        } else if (status === "FAILED" || status === "FAIL") {
            throw new Error("Generation failed: " + (payloadData.errorMessage || payloadData.error || pollData.msg || 'Unknown error'));
        } else {
            throw new Error(`Task is still processing. Current status: ${status || 'PENDING'}`);
        }
    }

    throw new Error(`Kie AI Polling Error: ${lastError || pollData?.msg || pollData?.message || 'Unknown response'}`);
};

export const generateSunoCoverArt = async (taskId: string, apiKey: string, addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void): Promise<string[]> => {
    addLog?.(`Requesting Suno AI Cover Art for task ${taskId}...`, 'info');

    const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: "ai-music-api/cover-generate",
            input: {
                taskId: taskId,
                callBackUrl: "https://example.com/callback"
            }
        })
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Cover Art Request Error: ${res.status} ${err}`);
    }

    const data = await res.json();
    const coverTaskId = data.data?.taskId || data.data?.task_id || data.taskId || data.id;
    if (!coverTaskId) {
        throw new Error("Could not create cover art task.");
    }

    addLog?.(`Cover art task created (ID: ${coverTaskId}). Rendering artwork...`, 'info');

    let attempts = 0;
    while (attempts < 40) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        attempts++;

        try {
            const pollRes = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${coverTaskId}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${apiKey}` }
            });

            if (pollRes.ok) {
                const pollData = await pollRes.json();
                if ((pollData.code === 200 || pollData.code === 0) && pollData.data) {
                    const status = (pollData.data.status || pollData.data.state || '').toUpperCase();
                    if (status === 'SUCCESS' || status === 'COMPLETED') {
                        const images = pollData.data.result?.images || pollData.data.response?.images || [pollData.data.imageUrl || pollData.data.url].filter(Boolean);
                        if (images && images.length > 0) {
                            addLog?.("Suno Cover Art generated successfully!", 'success');
                            return images;
                        }
                    } else if (status === 'FAILED' || status === 'FAIL') {
                        throw new Error(`Cover art generation failed: ${pollData.data.errorMessage || 'Server error'}`);
                    }
                }
            }
        } catch (e: any) {
            if (e.message?.includes('generation failed')) throw e;
        }
    }

    throw new Error("Cover art generation timed out.");
};

export interface KieImageOptions {
    prompt: string;
    model?: string;
    aspectRatio?: string;
    apiKey: string;
    referenceImageUrls?: string[];
    referenceImages?: Array<{ data: string; description?: string }>;
    addLog?: (msg: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
}

const uploadKieReferenceImage = async (source: string, apiKey: string, index: number): Promise<string> => {
    const trimmed = String(source || '').trim();
    if (!trimmed) throw new Error(`Character reference image ${index + 1} is empty.`);
    const dataUrl = trimmed.startsWith('data:')
        ? trimmed
        : `data:image/png;base64,${trimmed}`;
    const mimeMatch = dataUrl.match(/^data:(image\/[A-Za-z0-9.+-]+);base64,/);
    if (!mimeMatch) throw new Error(`Character reference image ${index + 1} is not a supported base64 image data URL.`);
    const extension = mimeMatch[1].split('/')[1].replace(/[^A-Za-z0-9]/g, '') || 'png';
    const uniqueName = `mv-ref-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}.${extension}`;

    let response: Response;
    try {
        response = await fetch('https://kieai.redpandaai.co/api/file-base64-upload', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                base64Data: dataUrl,
                uploadPath: 'mv-director/character-references',
                fileName: uniqueName
            })
        });
    } catch (error: any) {
        throw new Error(`Could not upload character reference ${index + 1} to KIE AI: ${error?.message || String(error)}`);
    }

    const raw = await response.text();
    let payload: any = {};
    try { payload = JSON.parse(raw); } catch {}
    const downloadUrl = payload?.data?.downloadUrl || payload?.data?.data?.downloadUrl || payload?.result?.downloadUrl;
    if (!response.ok || payload?.success === false || !downloadUrl || typeof downloadUrl !== 'string') {
        const detail = payload?.msg || payload?.message || payload?.error || raw.slice(0, 500);
        throw new Error(`KIE AI could not upload character reference ${index + 1} (HTTP ${response.status}): ${detail || 'No downloadable image URL returned.'}`);
    }
    return downloadUrl;
};

const resolveKieReferenceUrls = async (options: KieImageOptions): Promise<string[]> => {
    const suppliedUrls = (options.referenceImageUrls || []).filter(url => typeof url === 'string' && /^https?:\/\//i.test(url.trim()));
    if (suppliedUrls.length > 14) throw new Error('KIE image generation supports up to 14 reference URLs in this app. Reduce the selected references; no images were silently dropped.');
    if (suppliedUrls.length) return suppliedUrls;
    const allImages = (options.referenceImages || []).filter(image => typeof image?.data === 'string' && image.data.trim());
    if (allImages.length > 14) throw new Error('KIE image generation supports up to 14 reference images in this app. Reduce the selected references; no images were silently dropped.');
    const images = allImages;
    if (!images.length) return [];
    options.addLog?.(`Uploading ${images.length} reference image(s) to KIE AI so the selected model can use the actual image pixels, not only their descriptions...`, 'info');
    const urls: string[] = [];
    for (let index = 0; index < images.length; index++) {
        urls.push(await uploadKieReferenceImage(images[index].data, options.apiKey, index));
    }
    options.addLog?.(`Uploaded ${urls.length} reference image(s) for KIE AI image generation.`, 'success');
    return urls;
};

export const generateKieImage = async (options: KieImageOptions): Promise<string> => {
    const rawModel = options.model?.replace(/^kie:/, '') || 'google/nano-banana-2-1';
    const cleanModel = rawModel.trim() || 'google/nano-banana-2-1';
    
    options.addLog?.(`Connecting to Kie AI (${cleanModel})...`, 'info');

    let ar = options.aspectRatio || '16:9';
    if (ar === '2.35:1' || ar === '21:9') ar = '16:9';
    if (ar === '9:16' || ar === '8:15') ar = '9:16';

    const reqBody: any = {
        model: cleanModel,
        input: {
            prompt: options.prompt,
            aspect_ratio: ar,
            aspectRatio: ar,
        }
    };

    const referenceUrls = await resolveKieReferenceUrls(options);
    if (referenceUrls.length > 0) {
        const normalizedModel = cleanModel.toLowerCase();
        if (normalizedModel.includes('nano-banana-edit')) {
            // KIE's Nano Banana Edit contract names its image list image_urls.
            reqBody.input.image_urls = referenceUrls;
        } else if (normalizedModel.includes('nano-banana-2') || normalizedModel.includes('nano-banana-pro')) {
            // KIE's Nano Banana 2 / Pro contract names reference inputs image_input.
            reqBody.input.image_input = referenceUrls;
        } else {
            throw new Error(`The selected KIE model (${cleanModel}) does not expose a documented reference-image input in this app. Choose KIE Nano Banana 2/Pro or Nano Banana Edit to preserve the selected face reference.`);
        }
        options.addLog?.(`Sending ${referenceUrls.length} visual reference image(s) to KIE AI (${cleanModel}).`, 'info');
    }

    const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${options.apiKey}`
        },
        body: JSON.stringify(reqBody)
    });

    if (!res.ok) {
        const err = await res.text();
        throw new Error(`Kie AI Image API Error: ${res.status} ${err}`);
    }

    const data = await res.json();
    const taskId = extractKieTaskId(data);
    if (!taskId) {
        const directUrl = data.data?.url || data.data?.imageUrl || data.data?.images?.[0] || data.result?.images?.[0];
        if (directUrl) return directUrl;
        throw new Error(`Kie AI Image Error: ${data.msg || data.message || data.error || 'No valid Task ID or image URL returned.'}`);
    }

    options.addLog?.(`Kie AI image task created (ID: ${taskId}). Rendering...`, 'info');

    let attempts = 0;
    while (attempts < 60) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        attempts++;

        try {
            const pollRes = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${taskId}`, {
                method: "GET",
                headers: { "Authorization": `Bearer ${options.apiKey}` }
            });

            if (!pollRes.ok) {
                const altRes = await fetch(`https://api.kie.ai/api/v1/generate/record-info?taskId=${taskId}`, {
                    method: "GET",
                    headers: { "Authorization": `Bearer ${options.apiKey}` }
                });
                if (!altRes.ok) continue;
                const altData = await altRes.json();
                if (altData.code === 200 && altData.data) {
                    const status = (altData.data.status || altData.data.state || '').toUpperCase();
                    if (status === 'SUCCESS' || status === 'COMPLETED') {
                        const imgUrl = altData.data.response?.images?.[0] || altData.data.imageUrl || altData.data.url || altData.data.result?.images?.[0];
                        if (imgUrl) return imgUrl;
                    } else if (status === 'FAILED' || status === 'FAIL') {
                        throw new Error(`Kie AI image generation failed: ${altData.data.errorMessage || altData.msg || 'Unknown error'}`);
                    }
                }
                continue;
            }

            const pollData = await pollRes.json();
            if ((pollData.code === 200 || pollData.code === 0) && pollData.data) {
                const status = (pollData.data.status || pollData.data.state || '').toUpperCase();
                if (status === 'SUCCESS' || status === 'COMPLETED') {
                    const imgUrl = 
                        pollData.data.result?.images?.[0] || 
                        pollData.data.response?.images?.[0] || 
                        pollData.data.result?.image || 
                        pollData.data.imageUrl || 
                        pollData.data.url ||
                        pollData.data.output?.[0];
                    if (imgUrl) {
                        options.addLog?.("Kie AI image generated successfully!", 'success');
                        return imgUrl;
                    }
                    throw new Error("Task succeeded but no image URL was found in response.");
                } else if (status === 'FAILED' || status === 'FAIL') {
                    throw new Error(`Kie AI image generation failed: ${pollData.data.errorMessage || pollData.data.error || pollData.msg || 'Server error'}`);
                } else {
                    if (attempts % 4 === 0) {
                        options.addLog?.(`Kie AI rendering in progress (${status.toLowerCase()})...`, 'info');
                    }
                }
            }
        } catch (pollErr: any) {
            if (pollErr.message?.includes('generation failed')) throw pollErr;
            console.warn("Polling Kie image task warning:", pollErr);
        }
    }

    throw new Error("Kie AI image generation timed out after 3 minutes.");
};

export const generateSunoCover = async (options: SunoCoverOptions): Promise<{name: string, url: string}[]> => {
    const isCoverMode = Boolean(options.uploadUrl && !options.uploadUrl.startsWith('blob:'));
    const selectedModel = options.model || "V6";

    options.onStatus?.(isCoverMode ? "Connecting to Kie AI Suno Cover API..." : "Connecting to Kie AI Suno Music Generator...");
    options.addLog?.(isCoverMode ? `Connecting to Suno Cover API (${selectedModel})...` : `Connecting to Suno Music Generator (${selectedModel})...`, "info");

    const isV4 = selectedModel === "V4";
    const maxStyleChars = isV4 ? 200 : 1000;
    const maxTitleChars = (selectedModel === "V5_5" || selectedModel === "V5" || selectedModel === "V4_5PLUS" || selectedModel === "V4_5") ? 100 : 80;
    const maxLyricsChars = isV4 ? 3000 : 5000;

    const trimmedTitle = (options.title || "").slice(0, maxTitleChars);
    const trimmedStyle = (options.style || "").slice(0, maxStyleChars);
    const trimmedLyrics = (options.prompt || "").slice(0, maxLyricsChars);

    const isInstrumental = Boolean(options.instrumental);

    const reqBody: any = {
        model: selectedModel,
        customMode: true,
        instrumental: isInstrumental,
        title: trimmedTitle,
        style: trimmedStyle,
        negativeTags: options.negativeTags || "",
        personaModel: options.personaModel || "style_persona",
        personaId: options.personaId || "",
        callBackUrl: "playground",
        audioWeight: typeof options.audioWeight === 'number' ? options.audioWeight : 0.65,
        styleWeight: typeof options.styleWeight === 'number' ? options.styleWeight : 0.65,
        weirdnessConstraint: typeof options.weirdnessConstraint === 'number' ? options.weirdnessConstraint : 0.65,
        variety: typeof options.variety === 'number' ? options.variety : 1
    };

    // Documentation rule: If instrumental is true, do not pass lyrics, prompt, or vocalGender!
    if (!isInstrumental) {
        if (trimmedLyrics) {
            reqBody.lyrics = trimmedLyrics;
        }
        if (options.vocalGender) {
            reqBody.vocalGender = options.vocalGender.toLowerCase();
        }
    }

    if (isCoverMode) {
        reqBody.uploadUrl = options.uploadUrl;
    }

    // Endpoints according to docs.kie.ai/old-model/suno-api/
    const candidateEndpoints = isCoverMode
        ? ["https://api.kie.ai/api/v1/generate/upload-cover", "https://api.kie.ai/api/v1/generate"]
        : ["https://api.kie.ai/api/v1/generate/music", "https://api.kie.ai/api/v1/generate"];

    let taskId = '';
    let lastErrorMsg = '';

    for (const ep of candidateEndpoints) {
        if (taskId) break;
        try {
            const createRes = await fetch(ep, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${options.apiKey}`
                },
                body: JSON.stringify(reqBody)
            });

            if (createRes.ok) {
                const data = await createRes.json();
                const extracted = extractKieTaskId(data);
                if (extracted) {
                    taskId = extracted;
                    break;
                } else if (data.code !== 200 && data.code !== 0 && (data.msg || data.message || data.error)) {
                    lastErrorMsg = data.msg || data.message || data.error;
                }
            } else {
                const errText = await createRes.text();
                lastErrorMsg = `HTTP ${createRes.status}: ${errText}`;
            }
        } catch (e: any) {
            lastErrorMsg = e?.message || 'Network error';
        }
    }

    if (!taskId) {
        throw new Error(`Kie AI Suno generation rejected: ${lastErrorMsg || "No valid Task ID returned. Check your API key and parameter limits."}`);
    }

    if (options.onTaskId) {
        options.onTaskId(taskId);
    }

    const pollingMsg = `Suno task created (ID: ${taskId}). Synthesizing audio tracks...`;
    options.addLog?.(pollingMsg, "info");
    options.onStatus?.(pollingMsg);

    // Poll for status
    let attempts = 0;
    while (attempts < 60) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        attempts++;

        try {
            const tracks = await checkSunoTaskStatus(taskId, options.apiKey);
            if (tracks && tracks.length > 0) {
                return tracks;
            }
        } catch (e: any) {
            if (e.message?.includes('Generation failed')) {
                throw e;
            }
            if (attempts % 3 === 0) {
                const waitMsg = `Suno synthesis in progress... (${attempts * 5}s elapsed)`;
                options.addLog?.(waitMsg, "info");
                options.onStatus?.(waitMsg);
            }
        }
    }

    throw new Error("Suno generation timed out after 5 minutes. You can recover it later using the Task ID.");
};
