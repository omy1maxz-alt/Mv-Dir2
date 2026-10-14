import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, CheckCircle2, CircleHelp, Clock3, Download, Film, Gauge,
  ImagePlus, LoaderCircle, Maximize2, ScanEye, Settings2, ShieldCheck,
  Sparkles, UploadCloud, WandSparkles, X
} from 'lucide-react';

type Scale = 'original' | '1080p' | '1440p' | '4k';
type Strength = 'off' | 'low' | 'medium' | 'high';

export const VideoEnhancerTab: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [scale, setScale] = useState<Scale>('4k');
  const [denoise, setDenoise] = useState<Strength>('low');
  const [sharpen, setSharpen] = useState<Strength>('low');
  const [faceRestore, setFaceRestore] = useState(false);
  const [interpolate, setInterpolate] = useState(false);
  const [preset, setPreset] = useState('faithful');
  const [showSetup, setShowSetup] = useState(false);
  const [error, setError] = useState('');
  const apiConfigured = true; // requests go through the same-origin server gateway
  const [jobState, setJobState] = useState<{ id?: string; status?: string; message?: string; progress?: number; stage?: string; resultUrl?: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const refreshJob = async (jobId: string) => {
    if (!jobId) return;
    try {
      const response = await fetch(`/api/video-enhancer/jobs/${encodeURIComponent(jobId)}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.detail || 'Could not refresh job status.');
      let resultUrl: string | undefined;
      if (data.result_available || data.status === 'completed') {
        resultUrl = `/api/video-enhancer/jobs/${encodeURIComponent(jobId)}/result`;
      }
      setJobState({ id: data.job_id || jobId, status: data.status, message: data.message, progress: data.progress, stage: data.stage, resultUrl });
    } catch (e: any) {
      setError(e?.message || 'Could not refresh job status.');
    }
  };

  const submitJob = async () => {
    if (!file) return;
    setError('');
    setJobState(null);
    setIsSubmitting(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('settings', JSON.stringify({ scale, preset, denoise, sharpen, face_restore: faceRestore, interpolate }));
      const response = await fetch('/api/video-enhancer/jobs', { method: 'POST', body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.detail || `Video submission failed (HTTP ${response.status}).`);
      setJobState({ id: data.job_id, status: data.status, message: data.message, progress: data.progress, stage: data.stage });
      if (data.job_id) await refreshJob(data.job_id);
    } catch (e: any) {
      setError(e?.message || 'Could not submit this video to the worker.');
    } finally {
      setIsSubmitting(false);
    }
  };


  const [jobState, setJobState] = useState<{ id?: string; status?: string; message?: string; progress?: number; stage?: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!file) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const chooseFile = (candidate?: File) => {
    setError('');
    if (!candidate) return;
    if (!candidate.type.startsWith('video/')) {
      setError('Choose a supported video file (MP4, MOV, or WebM).');
      return;
    }
    setFile(candidate);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const selectClass = 'mt-2 w-full rounded-xl border border-white/10 bg-[#111318] px-3 py-3 text-sm text-white outline-none focus:border-violet-400';
  const panelClass = 'rounded-2xl border border-white/10 bg-[#101116] p-4 md:p-5';

  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-[#090a0e] text-white">
      <div className="mx-auto max-w-7xl space-y-6 p-4 pb-24 md:p-8">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[0.22em] text-violet-300">
              <Sparkles className="h-4 w-4" /> Video tools
            </div>
            <h1 className="text-3xl font-black tracking-tight md:text-4xl">AI Video Enhancer</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">
              Upscale and restore existing footage with a faithful, detail-preserving workflow.
            </p>
          </div>
          <div className="flex items-center gap-2 self-start rounded-full border border-amber-300/20 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-200 sm:self-auto">
            <AlertTriangle className="h-4 w-4" /> GPU backend not connected
          </div>
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.65fr)_minmax(300px,0.85fr)]">
          <section className={panelClass}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h2 className="font-bold">Source video</h2>
                <p className="mt-1 text-xs text-white/45">Your original file stays unchanged.</p>
              </div>
              {file && <button onClick={() => { setFile(null); setError(''); }} className="rounded-lg p-2 text-white/50 hover:bg-white/10 hover:text-white" aria-label="Remove video"><X className="h-4 w-4" /></button>}
            </div>

            {previewUrl ? (
              <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
                <video src={previewUrl} controls className="max-h-[460px] w-full bg-black object-contain" />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); chooseFile(e.dataTransfer.files?.[0]); }}
                className="flex min-h-[300px] w-full flex-col items-center justify-center rounded-xl border border-dashed border-white/20 bg-white/[0.025] p-8 text-center transition hover:border-violet-400/70 hover:bg-violet-400/[0.04]"
              >
                <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-400/10 text-violet-300"><UploadCloud className="h-7 w-7" /></span>
                <span className="text-base font-bold">Drop a video here</span>
                <span className="mt-2 text-sm text-white/45">or browse files · MP4, MOV, WebM</span>
                <span className="mt-5 rounded-lg bg-violet-500 px-4 py-2.5 text-sm font-bold text-white">Choose video</span>
              </button>
            )}
            <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm,video/*" className="hidden" onChange={e => chooseFile(e.target.files?.[0])} />
            {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}

            {file && (
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl bg-white/[0.04] p-3"><p className="text-[11px] uppercase tracking-wider text-white/40">File</p><p className="mt-1 truncate text-sm font-semibold" title={file.name}>{file.name}</p></div>
                <div className="rounded-xl bg-white/[0.04] p-3"><p className="text-[11px] uppercase tracking-wider text-white/40">Size</p><p className="mt-1 text-sm font-semibold">{formatSize(file.size)}</p></div>
                <div className="rounded-xl bg-white/[0.04] p-3"><p className="text-[11px] uppercase tracking-wider text-white/40">Type</p><p className="mt-1 truncate text-sm font-semibold">{file.type || 'Video'}</p></div>
              </div>
            )}
          </section>

          <aside className="space-y-5">
            <section className={panelClass}>
              <div className="mb-4 flex items-center gap-2"><Settings2 className="h-5 w-5 text-violet-300" /><h2 className="font-bold">Enhancement settings</h2></div>
              <label className="block text-sm font-medium">Restoration preset
                <select value={preset} onChange={e => setPreset(e.target.value)} className={selectClass}>
                  <option value="faithful">Natural / faithful</option>
                  <option value="old">Old or noisy footage</option>
                  <option value="compressed">Compressed online video</option>
                  <option value="animation">Anime / animation</option>
                  <option value="lowlight">Low-light footage</option>
                </select>
              </label>
              <label className="mt-4 block text-sm font-medium">Output resolution
                <select value={scale} onChange={e => setScale(e.target.value as Scale)} className={selectClass}>
                  <option value="original">Keep original resolution</option>
                  <option value="1080p">1080p Full HD</option>
                  <option value="1440p">1440p QHD</option>
                  <option value="4k">4K UHD</option>
                </select>
              </label>
              <label className="mt-4 block text-sm font-medium">Denoise
                <select value={denoise} onChange={e => setDenoise(e.target.value as Strength)} className={selectClass}>
                  <option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select>
              </label>
              <label className="mt-4 block text-sm font-medium">Deblur / sharpening
                <select value={sharpen} onChange={e => setSharpen(e.target.value as Strength)} className={selectClass}>
                  <option value="off">Off</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
                </select>
               <button
                type="button"
                disabled={!file || isSubmitting || !apiConfigured}
                onClick={submitJob}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-3 text-sm font-bold transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}
                {isSubmitting ? 'Submitting…' : 'Submit enhancement job'}
              </button>
              {!apiConfigured && <p className="mt-3 text-xs leading-5 text-amber-200/80">Worker API URL is not configured. Connect the app server to the private worker before uploading.</p>}
              {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
              {jobState && (
                <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-violet-200">Job status</span>
                    <span className="rounded-full bg-white/10 px-2 py-1 text-xs">{jobState.status || 'submitted'}</span>
                  </div>
                  <p className="mt-2 break-all text-xs text-white/55">{jobState.id || ''}</p>
                  <p className="mt-2 text-sm text-white/75">{jobState.message || jobState.stage || 'Worker accepted the job.'}</p>
                  {jobState.status === 'blocked' && <p className="mt-2 text-xs leading-5 text-amber-200/75">The worker received the upload, but model inference is not installed; no enhanced output exists.</p>}
                  {jobState.resultUrl && <a href={jobState.resultUrl} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3 py-2 text-xs font-bold text-white"><Download className="h-4 w-4" /> Download enhanced video</a>}
                  {jobState.id && !['completed', 'failed', 'cancelled', 'blocked'].includes(jobState.status || '') && <button onClick={() => void refreshJob(jobState.id!)} className="mt-3 flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold hover:bg-white/5"><LoaderCircle className="h-3.5 w-3.5" /> Refresh status</button>}
                </div>
              )}
   headers: { Authorization: `Bearer ${apiKey}`, 'X-Enhancement-Settings': JSON.stringify(settings) },
                      body
                    });
                    const data = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(data.detail || data.message || `Worker request failed (HTTP ${response.status}).`);
                    setJobState({ id: data.job_id, status: data.status, message: data.message, progress: data.progress, stage: data.stage });
                  } catch (e: any) {
                    setError(e?.message || 'Could not submit this video to the worker.');
                  } finally {
                    setIsSubmitting(false);
                  }
                }}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-violet-500 px-4 py-3 text-sm font-bold transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSubmitting ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />} {isSubmitting ? 'Submitting…' : 'Submit enhancement job'}
              </button>
              <p className="mt-3 text-center text-xs leading-5 text-white/40">Submits to the configured worker. Processing only succeeds once a real model adapter is deployed.</p>
              {jobState && (
                <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.04] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-violet-200">Job status</span>
                    <span className="rounded-full bg-white/10 px-2 py-1 text-xs">{jobState.status || 'submitted'}</span>
                  </div>
                  <p className="mt-2 break-all text-xs text-white/55">{jobState.id || ''}</p>
                  <p className="mt-2 text-sm text-white/75">{jobState.message || jobState.stage || 'Worker accepted the job.'}</p>
                </div>
              )}
            </section>
          </aside>
        </div>

        <section className={panelClass}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-white/[0.05] p-3"><Gauge className="h-5 w-5 text-violet-300" /></div>
              <div><h2 className="font-bold">Processing pipeline</h2><p className="mt-1 text-sm text-white/45">Upload → analyze → restore frames → encode → export</p></div>
            </div>
            <button onClick={() => setShowSetup(v => !v)} className="inline-flex items-center gap-2 self-start rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-white/65 hover:bg-white/5"><CircleHelp className="h-4 w-4" /> Backend setup</button>
          </div>
          {showSetup && (
            <div className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/[0.05] p-4">
              <h3 className="font-bold text-amber-100">Cloud GPU backend required</h3>
              <p className="mt-2 text-sm leading-6 text-white/60">This tab currently provides the interface and local preview. To produce a real enhanced video, connect an authenticated API and asynchronous GPU worker. Recommended worker stack: Python/FastAPI, PyTorch, FFmpeg, cloud object storage, and a persistent job queue. No output is fabricated while that service is missing.</p>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-white/60">
                <span className="rounded-lg bg-white/5 px-3 py-2">Real-ESRGAN · upscaling</span>
                <span className="rounded-lg bg-white/5 px-3 py-2">BasicVSR++ · video restoration</span>
                <span className="rounded-lg bg-white/5 px-3 py-2">RIFE · frame interpolation</span>
                <span className="rounded-lg bg-white/5 px-3 py-2">FFmpeg · export</span>
              </div>
            </div>
          )}
        </section>

        <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] p-4 text-xs leading-5 text-white/45">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Uploads go through the app server to keep worker credentials out of browser code. The included worker scaffold explicitly reports when inference is unavailable; no enhanced output is claimed until a real model adapter is deployed.</p>
        </div>
      </div>
    </div>
  );
};
