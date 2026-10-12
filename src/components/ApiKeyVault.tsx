import React, { useState, useEffect } from 'react';
import { ApiKeys, ApiKeySource } from '@/types';
import { X, Key, Shield, Check, AlertCircle, LogOut, User as UserIcon, Loader2, Search, SearchX, ChevronDown, ChevronUp, MessageSquareText, Image as ImageIcon, Cpu } from 'lucide-react';
import { signInWithGoogle, signOutGoogle, listenAuthState, isNativeEnvironment } from '@/services/auth';
import { APP_ENV } from '@/services/environment';
import type { User } from 'firebase/auth';


type ModelOption = { value: string; label: string };
type ModelOptionGroup = { label: string; options: ModelOption[] };
type CloudflareCatalogModel = {
  id: string;
  name: string;
  description: string;
  task: string;
  source: string;
  properties: string[];
  tags: string[];
};

const SearchableModelPicker: React.FC<{
  label: string;
  value: string;
  groups: ModelOptionGroup[];
  onChange: (value: string) => void;
  accent: 'indigo' | 'emerald';
}> = ({ label, value, groups, onChange, accent }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [openUpward, setOpenUpward] = useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const selected = groups.flatMap(group => group.options).find(option => option.value === value);
  const visibleGroups = groups.map(group => ({
    ...group,
    options: group.options.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase()))
  })).filter(group => group.options.length > 0);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  const accentText = accent === 'indigo' ? 'text-indigo-300' : 'text-emerald-300';
  const accentBorder = accent === 'indigo' ? 'focus:border-indigo-400' : 'focus:border-emerald-400';
  const activeBg = accent === 'indigo' ? 'bg-indigo-500/15' : 'bg-emerald-500/15';

  return (
    <div className="relative w-full" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={label}
        onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); const spaceBelow = window.innerHeight - rect.bottom; setOpenUpward(spaceBelow < Math.min(420, window.innerHeight * 0.48) && rect.top > spaceBelow); setIsOpen(open => !open); setQuery(''); }}
        className={`w-full min-w-0 flex items-center gap-3 rounded-xl border border-white/10 bg-black/40 px-3.5 py-3 text-left transition-colors hover:border-white/20 hover:bg-white/[0.04] focus:outline-none focus:ring-2 focus:ring-white/10 ${isOpen ? accentBorder : ''}`}
      >
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] ${accentText}`}>
          {label.startsWith('Text') ? <MessageSquareText className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-white">{selected?.label || 'Choose a model'}</span>
          <span className="mt-0.5 block truncate text-[11px] text-white/45">{selected?.value || 'Select a provider and model'}</span>
        </span>
        <span className="shrink-0 text-white/50">{isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
      </button>

      {isOpen && (
        <div className={`absolute left-0 right-0 z-[130] overflow-hidden rounded-2xl border border-white/10 bg-[#151515] shadow-2xl shadow-black/60 ${openUpward ? 'bottom-full mb-2' : 'top-full mt-2'}`}>
          <div className="border-b border-white/10 bg-[#191919] p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                className={`w-full rounded-lg border border-white/10 bg-black/40 py-2.5 pl-9 pr-3 text-sm text-white outline-none placeholder:text-white/30 ${accentBorder}`}
              />
            </div>
            <div className="mt-2 text-[10px] uppercase tracking-[0.14em] text-white/35">
              {visibleGroups.reduce((count, group) => count + group.options.length, 0)} models • grouped by provider
            </div>
          </div>
          <div role="listbox" aria-label={label} className="max-h-[min(42dvh,360px)] overflow-y-auto overscroll-contain p-2">
            {visibleGroups.length ? visibleGroups.map(group => (
              <div key={group.label} className="mb-2 last:mb-0">
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-[#151515]/95 px-2 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-white/45 backdrop-blur">
                  <span className={`h-1.5 w-1.5 rounded-full ${group.label.toLowerCase().includes('cloudflare') ? 'bg-orange-400' : group.label.toLowerCase().includes('kie') ? 'bg-indigo-400' : group.label.toLowerCase().includes('google') ? 'bg-emerald-400' : group.label.toLowerCase().includes('horde') ? 'bg-teal-400' : 'bg-white/40'}`} />
                  <span>{group.label}</span>
                </div>
                {group.options.map(option => {
                  const isSelected = option.value === value;
                  const provider = group.label.split(/[—(]/)[0].trim();
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      key={option.value}
                      onClick={() => { onChange(option.value); setIsOpen(false); setQuery(''); }}
                      className={`flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${isSelected ? activeBg : 'hover:bg-white/[0.05]'}`}
                    >
                      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${isSelected ? 'border-white/15 bg-white/10 text-white' : 'border-white/5 bg-white/[0.03] text-white/35'}`}>
                        {isSelected ? <Check className="h-3.5 w-3.5" /> : <Cpu className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs font-medium leading-relaxed ${isSelected ? 'text-white' : 'text-white/80'}`}>{option.label}</span>
                        <span className="mt-0.5 block text-[10px] text-white/35">{provider} · {option.value}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )) : (
              <div className="px-4 py-8 text-center">
                <SearchX className="mx-auto h-5 w-5 text-white/25" />
                <div className="mt-2 text-xs text-white/55">No matching models</div>
                <div className="mt-1 text-[10px] text-white/30">Try a different model name or provider</div>
              </div>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-white/10 px-3 py-2 text-[10px] text-white/35">
            <span>Tap a model to select it</span>
            <button type="button" onClick={() => setIsOpen(false)} className="rounded-md px-2 py-1 text-white/50 hover:bg-white/5 hover:text-white">Close</button>
          </div>
        </div>
      )}
    </div>
  );
};

interface ApiKeyVaultProps {
  isOpen: boolean;
  onClose: () => void;
  currentKeys: ApiKeys;
  currentSource: ApiKeySource;
  currentTextModel: string;
  currentImageModel: string;
  onSave: (keys: ApiKeys, source: ApiKeySource, textModel: string, imageModel: string) => void;
}

export const ApiKeyVault: React.FC<ApiKeyVaultProps> = ({ isOpen, onClose, currentKeys, currentSource, currentTextModel, currentImageModel, onSave }) => {
  const [source, setSource] = useState<ApiKeySource>(currentSource);
  const [cloudflareCatalog, setCloudflareCatalog] = useState<CloudflareCatalogModel[]>([]);
  const [catalogState, setCatalogState] = useState<{ kind: 'idle' | 'loading' | 'success' | 'error'; message: string }>({ kind: 'idle', message: '' });
  const [keys, setKeys] = useState<ApiKeys>(currentKeys);
  const [textModel, setTextModel] = useState<string>(currentTextModel);
  const [imageModel, setImageModel] = useState<string>(currentImageModel);
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [proxyTest, setProxyTest] = useState<{ kind: 'success' | 'error' | 'testing'; message: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSource(currentSource);
      setKeys(currentKeys);
      setTextModel(currentTextModel);
      setImageModel(currentImageModel);
      setAuthError(null);
      setProxyTest(null);
    }
  }, [isOpen, currentKeys, currentSource, currentTextModel, currentImageModel]);

  useEffect(() => {
    if (!isOpen) return;
    const proxyUrl = String(keys.cloudflareWorkerProxyUrl || '').trim();
    const proxyToken = String(keys.cloudflareWorkerProxyToken || '').trim();
    if (!proxyUrl || !proxyToken) {
      setCloudflareCatalog([]);
      setCatalogState({ kind: 'idle', message: 'Enter the Worker URL and proxy access token, then refresh to load the live catalog.' });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setCatalogState({ kind: 'loading', message: 'Loading Cloudflare model catalog…' });
    const baseUrl = proxyUrl.replace(/\/+$/, '');
    const headers = { Authorization: 'Bearer ' + proxyToken, Accept: 'application/json' };
    Promise.all([
      fetch(baseUrl + '?task=text-generation', { headers, signal: controller.signal, cache: 'no-store' }),
      fetch(baseUrl + '?task=text-to-image', { headers, signal: controller.signal, cache: 'no-store' })
    ]).then(async responses => {
      const payloads = await Promise.all(responses.map(async response => ({
        response,
        data: await response.json().catch(() => ({}))
      })));
      const failed = payloads.find(({ response, data }) => !response.ok || !data.success || !Array.isArray(data.models));
      if (failed) throw new Error(failed.data.error || 'Cloudflare catalog failed (HTTP ' + failed.response.status + ').');
      if (cancelled) return;
      const unique = new Map<string, CloudflareCatalogModel>();
      payloads.flatMap(item => item.data.models as CloudflareCatalogModel[]).forEach(model => {
        if (typeof model.id === 'string' && model.id.startsWith('@cf/')) unique.set(model.id, model);
      });
      setCloudflareCatalog(Array.from(unique.values()));
      setCatalogState({ kind: 'success', message: 'Loaded ' + unique.size + ' current Cloudflare models from the Worker catalog.' });
    }).catch(error => {
      if (cancelled || error?.name === 'AbortError') return;
      setCatalogState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [isOpen, keys.cloudflareWorkerProxyUrl, keys.cloudflareWorkerProxyToken]);

  useEffect(() => {
    const unsubscribe = listenAuthState((user) => {
      setAuthUser(user);
    });
    return () => unsubscribe();
  }, []);

  if (!isOpen) return null;

  const handleGoogleLogin = async () => {
    setIsAuthLoading(true);
    setAuthError(null);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      if (err?.code !== 'auth/popup-closed-by-user') {
        setAuthError(err?.message || 'Failed to sign in with Google');
      }
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleGoogleLogout = async () => {
    setIsAuthLoading(true);
    try {
      await signOutGoogle();
    } catch (err: any) {
      console.warn('Logout error:', err);
    } finally {
      setIsAuthLoading(false);
    }
  };

  const handleSave = () => {
    onSave(keys, source, textModel, imageModel);
    onClose();
  };

  const normalizedTask = (model: CloudflareCatalogModel) => String(model.task || '').toLowerCase().replace(/[_ ]+/g, '-');
  const cloudflareTextGroup: ModelOptionGroup = (() => {
    const supportedText = cloudflareCatalog.filter(model => {
      const task = normalizedTask(model);
      return task.includes('text-generation') && model.id.toLowerCase().includes('llama') && /llama-3\.3-70b-instruct-fp8-fast/.test(model.id);
    });
    const fallback: ModelOption[] = [{ value: 'cloudflare-text:@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Cloudflare Llama 3.3 70B (Worker Proxy recommended)' }];
    const options = supportedText.map(model => ({
      value: 'cloudflare-text:' + model.id,
      label: (model.name || model.id) + (model.description ? ' — ' + model.description.slice(0, 90) : '')
    }));
    return { label: 'Cloudflare Workers AI — Text Generation' + (catalogState.kind === 'success' ? ' (Live Catalog)' : ' (Fallback List)'), options: options.length ? options : fallback };
  })();
  const cloudflareImageGroup: ModelOptionGroup = (() => {
    const supportedTasks = ['text-to-image'];
    const supportedImages = cloudflareCatalog.filter(model => {
      const id = model.id.toLowerCase();
      const task = normalizedTask(model);
      return supportedTasks.includes(task) && [
        '@cf/leonardo/lucid-origin',
        '@cf/leonardo/phoenix-1.0',
        '@cf/black-forest-labs/flux-1-schnell',
        '@cf/lykon/dreamshaper-8-lcm',
        '@cf/stabilityai/stable-diffusion-xl-base-1.0',
        '@cf/bytedance/stable-diffusion-xl-lightning'
      ].includes(id);
    });
    const existing = [
      { value: 'cloudflare:@cf/leonardo/lucid-origin', label: 'Lucid Origin — Best for prompt adherence, detailed cinematic art & specific direction' },
      { value: 'cloudflare:@cf/leonardo/phoenix-1.0', label: 'Phoenix 1.0 — Strong prompt adherence, stylized concepts & coherent text' },
      { value: 'cloudflare:@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 [schnell] — Fast drafts & iteration' },
      { value: 'cloudflare:@cf/lykon/dreamshaper-8-lcm', label: 'DreamShaper 8 LCM — Photorealistic / stylized exploration' },
      { value: 'cloudflare:@cf/stabilityai/stable-diffusion-xl-base-1.0', label: 'Stable Diffusion XL 1.0 — General-purpose image generation' },
      { value: 'cloudflare:@cf/bytedance/stable-diffusion-xl-lightning', label: 'Stable Diffusion XL Lightning — Fast drafts' }
    ];
    const existingById = new Map(existing.map(option => [option.value.slice('cloudflare:'.length), option]));
    const options = supportedImages.map(model => ({
      value: 'cloudflare:' + model.id,
      label: existingById.get(model.id)?.label || (model.name || model.id)
    }));
    return { label: 'Cloudflare Workers AI (Live Catalog' + (catalogState.kind === 'success' ? '' : ' / Fallback') + ')', options: options.length ? options : existing };
  })();

  const refreshCloudflareCatalog = async () => {
    const proxyUrl = String(keys.cloudflareWorkerProxyUrl || '').trim();
    const proxyToken = String(keys.cloudflareWorkerProxyToken || '').trim();
    if (!proxyUrl || !proxyToken) {
      setCatalogState({ kind: 'error', message: 'Enter the Worker URL and proxy access token before refreshing the catalog.' });
      return;
    }
    setCatalogState({ kind: 'loading', message: 'Refreshing Cloudflare model catalog…' });
    setCloudflareCatalog([]);
    const baseUrl = proxyUrl.replace(/\/+$/, '');
    try {
      const headers = { Authorization: 'Bearer ' + proxyToken, Accept: 'application/json' };
      const responses = await Promise.all([
        fetch(baseUrl + '?task=text-generation', { headers, cache: 'no-store' }),
        fetch(baseUrl + '?task=text-to-image', { headers, cache: 'no-store' })
      ]);
      const payloads = await Promise.all(responses.map(async response => ({
        response,
        data: await response.json().catch(() => ({}))
      })));
      const failed = payloads.find(({ response, data }) => !response.ok || !data.success || !Array.isArray(data.models));
      if (failed) throw new Error(failed.data.error || 'Cloudflare catalog failed (HTTP ' + failed.response.status + ').');
      const unique = new Map<string, CloudflareCatalogModel>();
      payloads.flatMap(item => item.data.models as CloudflareCatalogModel[]).forEach(model => {
        if (typeof model.id === 'string' && model.id.startsWith('@cf/')) unique.set(model.id, model);
      });
      setCloudflareCatalog(Array.from(unique.values()));
      setCatalogState({ kind: 'success', message: 'Loaded ' + unique.size + ' catalog models. Only known-supported model adapters are selectable.' });
    } catch (error) {
      setCatalogState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  // Tests browser-to-Worker CORS/routing using a deliberately invalid token.
  // The Worker should answer 401 before contacting Workers AI, so this uses no AI credits.
  const handleTestCloudflareProxy = async () => {
    const proxyUrl = String(keys.cloudflareWorkerProxyUrl || '').trim();
    if (!proxyUrl) {
      setProxyTest({ kind: 'error', message: 'Enter the Cloudflare Worker Proxy URL first.' });
      return;
    }
    try {
      const parsed = new URL(proxyUrl);
      if (parsed.protocol !== 'https:') {
        setProxyTest({ kind: 'error', message: 'Use the HTTPS workers.dev URL.' });
        return;
      }
    } catch {
      setProxyTest({ kind: 'error', message: 'The Worker URL is not a valid URL.' });
      return;
    }

    setProxyTest({ kind: 'testing', message: 'Testing browser access and CORS preflight…' });
    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer mv-director-routing-test-invalid-token',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          action: 'image',
          model: '@cf/black-forest-labs/flux-1-schnell',
          input: { prompt: 'routing test only' }
        }),
        cache: 'no-store'
      });
      if (response.status === 401) {
        setProxyTest({ kind: 'success', message: 'Connection and CORS are working. The expected HTTP 401 confirms the Worker received the test request. No image was generated.' });
      } else if (response.status === 403) {
        setProxyTest({ kind: 'error', message: 'The Worker returned HTTP 403. Check Worker-side access rules or deployment routing.' });
      } else if (response.status >= 500) {
        const detail = (await response.text()).slice(0, 180);
        setProxyTest({ kind: 'error', message: `The Worker responded with HTTP ${response.status}. Check its configuration. ${detail}` });
      } else {
        setProxyTest({ kind: 'success', message: `The browser reached the Worker and completed CORS preflight (HTTP ${response.status}). This test does not generate an image.` });
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      setProxyTest({
        kind: 'error',
        message: `The browser could not complete the request. This usually means a CORS/preflight, URL, or network issue. Verify the saved Worker URL and retry. Details: ${detail}`
      });
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[100] p-3 sm:p-4 pt-safe pb-safe pl-safe pr-safe">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 flex flex-col max-h-[88dvh]">
        <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-semibold text-white">API & Account Settings</h2>
          </div>
          <button onClick={onClose} className="p-2 text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto">
          {/* Google Account Section */}
          <div className="p-4 rounded-xl bg-gradient-to-b from-white/[0.07] to-white/[0.02] border border-white/10 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-white/70">Google Account</span>
              {authUser && (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-medium bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span> Connected
                </span>
              )}
            </div>

            {authUser ? (
              <div className="flex items-center justify-between gap-3 bg-black/40 p-3 rounded-lg border border-white/5">
                <div className="flex items-center gap-3 min-w-0">
                  {authUser.photoURL ? (
                    <img src={authUser.photoURL} alt={authUser.displayName || 'User'} className="w-9 h-9 rounded-full border border-white/20 shrink-0" />
                  ) : (
                    <div className="w-9 h-9 rounded-full bg-indigo-600 flex items-center justify-center text-white text-sm font-bold shrink-0">
                      {(authUser.displayName || authUser.email || 'U')[0].toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-white truncate">{authUser.displayName || 'Google User'}</div>
                    <div className="text-xs text-white/50 truncate">{authUser.email}</div>
                  </div>
                </div>
                <button 
                  onClick={handleGoogleLogout} 
                  disabled={isAuthLoading}
                  className="px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg border border-red-500/20 transition-colors flex items-center gap-1.5 shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out</span>
                </button>
              </div>
            ) : APP_ENV.isStandalone ? (
              <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/20 space-y-2 text-xs">
                <div className="flex items-center justify-between text-amber-300 font-bold">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <span>{APP_ENV.environmentLabel}</span>
                  </div>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                    Outside Studio Sandbox
                  </span>
                </div>
                <p className="text-[11px] text-white/70 leading-relaxed">
                  Operating in standalone mode directly on your device with persistent storage ({APP_ENV.storageDescription}).
                </p>
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[11px] font-medium leading-relaxed">
                  ✨ <strong>Full Access Enabled:</strong> All AI generation features (Director, Suno Music, Subtitles, Storyboard, Keyframes) run with 100% functionality via the <strong>Built-in API Key</strong> or your <strong>Custom API Keys</strong> below!
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  onClick={handleGoogleLogin}
                  disabled={isAuthLoading}
                  className="w-full flex items-center justify-center gap-3 py-2.5 px-4 bg-white hover:bg-zinc-100 text-zinc-900 font-medium text-sm rounded-xl transition-all shadow-sm active:scale-[0.98] disabled:opacity-50"
                >
                  {isAuthLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-zinc-700" />
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
                    </svg>
                  )}
                  <span>Sign in with Google</span>
                </button>
                <div className="text-[11px] text-white/40 text-center">
                  Sign in with your Google Account for seamless authentication.
                </div>
              </div>
            )}

            {authError && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
                <div className="text-[10px] text-white/50 pl-6 border-t border-white/5 pt-1.5 leading-relaxed">
                  💡 <strong>No sign-in required:</strong> You can select <strong>"Custom API Keys"</strong> below and enter your Google Gemini or Kie.ai API keys to direct videos and generate music immediately without needing to log in.
                </div>
              </div>
            )}
          </div>

          <div className="space-y-4">
            <label className="flex items-start gap-3 p-3 rounded-xl border border-white/10 cursor-pointer hover:bg-white/5 transition-colors">
              <input 
                type="radio" 
                name="apiSource" 
                checked={source === 'builtin'} 
                onChange={() => setSource('builtin')}
                className="mt-1"
              />
              <div>
                <div className="text-sm font-medium text-white">Use Built-in API Key</div>
                <div className="text-xs text-white/50 mt-1">Use the default platform-provided API key. Some advanced features (like Veo video generation) may require your own paid key.</div>
              </div>
            </label>

            <label className="flex items-start gap-3 p-3 rounded-xl border border-white/10 cursor-pointer hover:bg-white/5 transition-colors">
              <input 
                type="radio" 
                name="apiSource" 
                checked={source === 'custom'} 
                onChange={() => setSource('custom')}
                className="mt-1"
              />
              <div>
                <div className="text-sm font-medium text-white">Use Custom API Key</div>
                <div className="text-xs text-white/50 mt-1">Provide your own API keys to bypass limits and access paid models.</div>
              </div>
            </label>
          </div>

          {source === 'custom' && (
            <div className="space-y-4 animate-in slide-in-from-top-2">
              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Google Gemini API Key</label>
                <input 
                  type="password" 
                  value={keys.google || ''} 
                  onChange={(e) => setKeys({ ...keys, google: e.target.value })}
                  placeholder="AIzaSy..."
                  className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
              
              <div className="space-y-2">
                <label className="text-xs font-medium text-white/70">Kie AI API Key (For KIE Chat Models & Suno AI Covers)</label>
                <input 
                  type="password" 
                  value={keys.kie || ''} 
                  onChange={(e) => setKeys({ ...keys, kie: e.target.value })}
                  placeholder="sk-..."
                  className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>

              
              <div className="pt-4 border-t border-white/10 space-y-4">
                <div className="text-sm font-medium text-white flex items-center gap-2">
                  <span>Custom OpenAI-Compatible Provider (Optional)</span>
                </div>
                <div className="text-xs text-white/50">
                  Use community free APIs (like those from awesome-freellm-apis) instead of Gemini. Leave blank to use Gemini.
                </div>
                
                <div className="space-y-2">
                  <label className="text-xs font-medium text-white/70">Base URL</label>
                  <input 
                    type="text" 
                    value={keys.openaiBaseUrl || ''} 
                    onChange={(e) => setKeys({ ...keys, openaiBaseUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-white/70">API Key</label>
                  <input 
                    type="password" 
                    value={keys.openaiApiKey || ''} 
                    onChange={(e) => setKeys({ ...keys, openaiApiKey: e.target.value })}
                    placeholder="sk-..."
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-white/10 space-y-4">
                <div className="text-sm font-medium text-white flex items-center gap-2">
                  <span className="text-orange-400 font-semibold">Cloudflare Workers AI (Optional)</span>
                </div>
                <div className="text-xs text-white/50">
                  Generate cinematic storyboard images with Cloudflare Workers AI. Model availability and usage cost depend on your Cloudflare account and the selected model; check current Neuron usage in Cloudflare Dashboard.
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-white/70">Cloudflare Account ID</label>
                  <input 
                    type="text" 
                    value={keys.cloudflareAccountId || ''} 
                    onChange={(e) => setKeys({ ...keys, cloudflareAccountId: e.target.value })}
                    placeholder="e.g. 9a8b7c6d5e4f3a2b1c..."
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-white/70">Workers AI API Token</label>
                  <input 
                    type="password" 
                    value={keys.cloudflareApiToken || ''} 
                    onChange={(e) => setKeys({ ...keys, cloudflareApiToken: e.target.value })}
                    placeholder="Workers AI token with Run permissions"
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-white/70">Cloudflare Worker Proxy URL (Recommended for AI Studio)</label>
                  <input
                    type="url"
                    value={keys.cloudflareWorkerProxyUrl || ''}
                    onChange={(e) => setKeys({ ...keys, cloudflareWorkerProxyUrl: e.target.value.trim() })}
                    placeholder="https://your-image-proxy.your-subdomain.workers.dev"
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                  <div className="text-[10px] text-white/40">
                    Cloudflare's REST API may be blocked by browser CORS in the AI Studio iframe. Deploy the included worker proxy and paste its URL here.
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={refreshCloudflareCatalog}
                      disabled={catalogState.kind === 'loading'}
                      className="inline-flex items-center gap-2 rounded-lg border border-orange-500/20 bg-orange-500/10 px-3 py-2 text-xs font-medium text-orange-200 transition-colors hover:bg-orange-500/15 disabled:cursor-wait disabled:opacity-50"
                    >
                      {catalogState.kind === 'loading' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                      Refresh Model Catalog
                    </button>
                    <button
                      type="button"
                      onClick={handleTestCloudflareProxy}
                      disabled={proxyTest?.kind === 'testing'}
                      className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
                    >
                      {proxyTest?.kind === 'testing' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
                      Test Worker Connection
                    </button>
                    <span className="text-[10px] text-white/35">Uses a dummy token; does not generate an image or use AI credits.</span>
                  </div>
                  {catalogState.message && (
                    <div
                      role="status"
                      className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                        catalogState.kind === 'success'
                          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                          : catalogState.kind === 'error'
                            ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                            : 'border-white/10 bg-white/[0.04] text-white/60'
                      }`}
                    >
                      {catalogState.message}
                    </div>
                  )}
                  {proxyTest && (
                    <div
                      role="status"
                      className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
                        proxyTest.kind === 'success'
                          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200'
                          : proxyTest.kind === 'error'
                            ? 'border-rose-500/20 bg-rose-500/10 text-rose-200'
                            : 'border-white/10 bg-white/[0.04] text-white/60'
                      }`}
                    >
                      {proxyTest.message}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium text-white/70">Cloudflare Worker Proxy Access Token</label>
                  <input
                    type="password"
                    value={keys.cloudflareWorkerProxyToken || ''}
                    onChange={(e) => setKeys({ ...keys, cloudflareWorkerProxyToken: e.target.value })}
                    placeholder="The PROXY_ACCESS_TOKEN secret configured on your Worker"
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
              </div>

              <div className="pt-4 border-t border-white/10 space-y-4">
                <div className="text-sm font-medium text-white flex items-center gap-2">
                  <span className="text-teal-400 font-semibold">AI Horde (Optional)</span>
                </div>
                <div className="text-xs text-white/50">
                  Decentralized, crowdsourced volunteer GPU cluster. Leave blank for free anonymous access ("0000000000"), or enter your key for priority kudos.
                </div>
                <div className="space-y-2">
                  <label className="text-xs font-medium text-white/70">AI Horde API Key</label>
                  <input 
                    type="password" 
                    value={keys.aiHordeApiKey || ''} 
                    onChange={(e) => setKeys({ ...keys, aiHordeApiKey: e.target.value })}
                    placeholder="Leave blank for anonymous 0000000000"
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
              </div>

              <div className="flex items-center gap-1.5 text-[10px] text-white/40">
                <Shield className="w-3 h-3" />
                <span>Provider settings are stored locally. A configured Cloudflare Worker receives only its proxy access token; keep the Cloudflare API token in the Worker secret store.</span>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-white/10 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-white/70">Text Generation Model</label>
              {textModel.startsWith('kie:') && (
                <span className="text-[10px] text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20 font-medium">
                  KIE AI Routing Active
                </span>
              )}
              {textModel.startsWith('cloudflare-text:') && (
                <span className="text-[10px] text-orange-300 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20 font-medium">
                  Cloudflare Workers AI Text
                </span>
              )}
              {textModel === 'aihorde-text' && (
                <span className="text-[10px] text-teal-300 bg-teal-500/10 px-2 py-0.5 rounded border border-teal-500/20 font-medium">
                  AI Horde Text
                </span>
              )}
            </div>
            <SearchableModelPicker
              label="Text Generation Model"
              value={textModel}
              onChange={setTextModel}
              accent="indigo"
              groups={[{"label":"Google Gemini Models (Direct / Native)","options":[{"value":"gemini-3.8-pro","label":"Gemini 3.8 Pro (Next Gen Reasoning)"},{"value":"gemini-3.8-flash","label":"Gemini 3.8 Flash (Next Gen Fast)"},{"value":"gemini-3.7-pro","label":"Gemini 3.7 Pro (Ultimate Reasoning)"},{"value":"gemini-3.7-flash","label":"Gemini 3.7 Flash (Latest Fast)"},{"value":"gemini-3.6-flash","label":"Gemini 3.6 Flash"},{"value":"gemini-3.5-flash","label":"Gemini 3.5 Flash (Balanced)"},{"value":"gemini-3.1-pro-preview","label":"Gemini 3.1 Pro (Legacy Reasoning)"},{"value":"gemini-3.1-flash-lite","label":"Gemini 3.1 Flash Lite (Highest Quota)"}], cloudflareTextGroup]},{"label":"KIE AI — Anthropic Claude","options":[{"value":"kie:claude-sonnet-5-5","label":"KIE Claude Sonnet 5.5 (Frontier Flagship • 30%+ Faster)"},{"value":"kie:claude-opus-5-5","label":"KIE Claude Opus 5.5 (Frontier Intelligence & Reasoning)"},{"value":"kie:claude-haiku-5-5","label":"KIE Claude Haiku 5.5 (1M Context • Ultra Fast)"},{"value":"kie:claude-fable-5-1","label":"KIE Claude Fable 5.1 (Mythos-Class Agentic)"},{"value":"kie:claude-sonnet-5","label":"KIE Claude Sonnet 5 (Frontier Reasoning & Nuance)"},{"value":"kie:claude-opus-5","label":"KIE Claude Opus 5 (Deep Thought & Prose)"},{"value":"kie:claude-sonnet-4-6","label":"KIE Claude Sonnet 4.6 (Clear Writing & Code)"},{"value":"kie:claude-haiku-4-5","label":"KIE Claude Haiku 4.5 (Ultra Fast)"},{"value":"kie:claude-fable-5","label":"KIE Claude Fable 5 (Creative & Scripting)"}]},{"label":"KIE AI — OpenAI & Codex","options":[{"value":"kie:gpt-6-1-sol","label":"KIE GPT-6.1 Sol (Frontier Flagship • 1M Context)"},{"value":"kie:gpt-6-sol","label":"KIE GPT-6 Sol (Frontier Reasoning & Coding)"},{"value":"kie:gpt-6-luna","label":"KIE GPT-6 Luna (High Speed & Scale)"},{"value":"kie:gpt-6-astra","label":"KIE GPT-6 Astra (Frontier Codex)"},{"value":"kie:gpt-5-6-sol","label":"KIE GPT-5.6 Sol (Codex Flagship Tier)"},{"value":"kie:gpt-5-6-terra","label":"KIE GPT-5.6 Terra (Balanced Scale)"},{"value":"kie:gpt-5-6-luna","label":"KIE GPT-5.6 Luna (Fast & Affordable)"},{"value":"kie:gpt-5-5","label":"KIE GPT-5.5 (High Intelligence)"},{"value":"kie:gpt-5-4","label":"KIE GPT-5.4 (Multimodal Reasoning)"},{"value":"kie:gpt-5-2","label":"KIE GPT-5.2 (Multimodal Reasoning)"},{"value":"kie:codex","label":"KIE OpenAI Codex (Code Synthesis)"}]},{"label":"KIE AI — Google Gemini","options":[{"value":"kie:gemini-3.8-flash","label":"KIE Gemini 3.8 Flash (Advanced Coding & Agents)"},{"value":"kie:gemini-3.7-flash","label":"KIE Gemini 3.7 Flash (Hybrid Reasoning)"},{"value":"kie:gemini-3.6-flash","label":"KIE Gemini 3.6 Flash (High Throughput)"},{"value":"kie:gemini-3.5-flash","label":"KIE Gemini 3.5 Flash (Fast Agentic)"},{"value":"kie:gemini-3.1-pro","label":"KIE Gemini 3.1 Pro (Deep Analysis)"},{"value":"kie:gemini-3-pro","label":"KIE Gemini 3 Pro (Deep Reasoning)"},{"value":"kie:gemini-2.5-pro","label":"KIE Gemini 2.5 Pro (Massive Context)"}]},{"label":"KIE AI — xAI, DeepSeek & Moonshot","options":[{"value":"kie:grok-4-7","label":"KIE Grok 4.7 (500K Context • SWE 71% Reasoning)"},{"value":"kie:grok-4-6","label":"KIE Grok 4.6 (Fast Interactive)"},{"value":"kie:grok-4-5","label":"KIE Grok 4.5 (Coding & Logic)"},{"value":"kie:grok-4-3","label":"KIE Grok 4.3 (Speed & Chat)"},{"value":"kie:deepseek-v4-1-flash","label":"KIE DeepSeek V4.1 Flash (Fast Open Reasoning)"},{"value":"kie:deepseek-r1","label":"KIE DeepSeek R1 (Reasoning Engine)"},{"value":"kie:deepseek-v3","label":"KIE DeepSeek V3 (671B MoE)"},{"value":"kie:kimi-k3","label":"KIE Moonshot Kimi K3 (1M Context)"},{"value":"kie:custom","label":"KIE Custom Model (Specify below)"}]},{...cloudflareTextGroup},{"label":"AI Horde — Text Generation (Volunteer Workers)","options":[{"value":"aihorde-text","label":"AI Horde Text (Anonymous / priority with personal key)"}]},{"label":"Custom Provider","options":[{"value":"custom-openai","label":"Custom OpenAI Provider (Set above)"}]}]}
            />

            {textModel.startsWith('kie:') && (
              <div className="p-3 rounded-xl bg-indigo-950/20 border border-indigo-500/20 space-y-2 mt-2 animate-in fade-in">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-indigo-300">KIE AI API Key</span>
                  <span className="text-[10px] text-white/50">Required for KIE models</span>
                </div>
                <input 
                  type="password" 
                  value={keys.kie || ''} 
                  onChange={(e) => setKeys({ ...keys, kie: e.target.value })}
                  placeholder="sk-..."
                  className="w-full bg-black/50 border border-indigo-500/30 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-400 transition-colors"
                />
                <div className="text-[10px] text-white/50">
                  This model will be used across Story Mode director plans, prompt enhancements, Studio chat, and translations via KIE's high-speed API.
                </div>

                {textModel === 'kie:custom' && (
                  <div className="pt-2 border-t border-indigo-500/20 space-y-1">
                    <label className="text-xs font-medium text-indigo-200">Custom KIE Model ID</label>
                    <input 
                      type="text" 
                      value={keys.kieCustomModel || ''} 
                      onChange={(e) => setKeys({ ...keys, kieCustomModel: e.target.value })}
                      placeholder="e.g. meta-llama/llama-3.3-70b-instruct or mistral-large"
                      className="w-full bg-black/50 border border-indigo-500/30 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-400 transition-colors"
                    />
                  </div>
                )}
              </div>
            )}

            {textModel === 'custom-openai' && (
                <div className="space-y-2 mt-2 animate-in fade-in">
                  <label className="text-xs font-medium text-white/70">Custom Model Name</label>
                  <input 
                    type="text" 
                    value={keys.openaiModel || ''} 
                    onChange={(e) => setKeys({ ...keys, openaiModel: e.target.value })}
                    placeholder="e.g. meta-llama/llama-3-8b-instruct"
                    className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-indigo-500 transition-colors"
                  />
                </div>
            )}

            <div className="text-[10px] text-white/40 mb-4">
              Select the model used for director plans, chat, prompt enhancement, and subtitle translation. Cloudflare text in the AI Studio iframe needs the Worker Proxy URL and access token configured above. AI Horde text uses volunteer workers and may queue.
            </div>
            
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-white/70">Image Generation Model</label>
              {imageModel.startsWith('kie:') ? (
                <span className="text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20 font-medium">
                  KIE AI Routing Active
                </span>
              ) : imageModel.startsWith('cloudflare:') ? (
                <span className="text-[10px] text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded border border-orange-500/20 font-medium">
                  Cloudflare Workers AI
                </span>
              ) : imageModel === 'aihorde' ? (
                <span className="text-[10px] text-teal-400 bg-teal-500/10 px-2 py-0.5 rounded border border-teal-500/20 font-medium">
                  AI Horde (Crowdsourced)
                </span>
              ) : imageModel.startsWith('gemini-') || imageModel.startsWith('imagen-') ? (
                <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 font-medium">
                  Google Gemini Direct
                </span>
              ) : null}
            </div>
            <SearchableModelPicker
              label="Image Generation Model"
              value={imageModel}
              onChange={setImageModel}
              accent="emerald"
              groups={[{"label":"Google Gemini Direct (Native @google/genai / AI Studio)","options":[{"value":"gemini-nano-banana-2.1","label":"Gemini Nano Banana 2.1 (Google Flagship — 4K / Multi-Reference / Consistent Characters)"},{"value":"gemini-3.1-flash-lite-image","label":"Gemini 3.1 Flash-Lite Image (Google Official Default — Fast & Multimodal)"},{"value":"gemini-3-pro-image","label":"Gemini 3 Pro Image (Nano Banana Pro — 4K / Deep Reasoning)"},{"value":"gemini-3.1-flash-image","label":"Gemini 3.1 Flash Image (AI Studio Direct Alias)"},{"value":"gemini-2.5-flash-image","label":"Gemini 2.5 Flash Image (Legacy Direct GCP)"},{"value":"imagen-3.0-generate-002","label":"Imagen 3.0 (Direct GCP / Vertex AI Dedicated Photorealistic Image Model)"}], cloudflareImageGroup]},{"label":"KIE AI — Google Nano Banana (Uses Kie AI API Key)","options":[{"value":"kie:google/nano-banana-2-1","label":"KIE Nano Banana 2.1 (Gemini 3.1 Flash Image — 4K / Multi-Reference)"},{"value":"kie:google/nano-banana-2","label":"KIE Nano Banana 2 (Gemini 3.1 Flash Image — High Quality)"},{"value":"kie:google/nano-banana-pro","label":"KIE Nano Banana Pro (Gemini 3.0 Pro Image — 4K / Production)"},{"value":"kie:google/nano-banana","label":"KIE Nano Banana (Gemini 2.5 Flash Image — Fast)"},{"value":"kie:google/nano-banana-2-lite","label":"KIE Nano Banana 2 Lite (Gemini 3.1 Flash-Lite Image)"},{"value":"kie:google/nano-banana-edit","label":"KIE Nano Banana Edit (Prompt Image Editing)"}]},{"label":"KIE AI — OpenAI & xAI Image (Uses Kie AI API Key)","options":[{"value":"kie:gpt-image-2-5","label":"KIE GPT Image 2.5 (OpenAI Multimodal / Image Generation & Editing)"},{"value":"kie:grok-imagine-image-2","label":"KIE Grok Imagine Image 2.0 (xAI Generation & Editing)"}]},{...cloudflareImageGroup},{"label":"AI Horde (Decentralized Volunteer GPUs • Crowdsourced Free)","options":[{"value":"aihorde","label":"AI Horde (Crowdsourced Volunteer Cluster • Free / 0-Key or Priority Kudos)"}]},{"label":"Free Public Providers (No API Key Required)","options":[{"value":"pollinations","label":"Pollinations (Free Public API, No Key)"}]}]}
            />
            <div className="text-[10px] text-white/40">
              {imageModel.startsWith('kie:') 
                ? "Powered by Kie.ai Image API. Uses your Kie AI API key to generate images without GCP billing."
                : imageModel.startsWith('cloudflare:')
                ? "Powered by Cloudflare Workers AI. Uses your Cloudflare Account ID & Workers AI API Token."
                : imageModel === 'aihorde'
                ? "Powered by AI Horde crowdsourced volunteer GPUs. 100% free with anonymous key or priority with user key."
                : imageModel.startsWith('gemini-') || imageModel.startsWith('imagen-')
                ? "Direct Google Gemini API. Requires a valid Google Gemini API Key."
                : "Select the model used for generating scene images."}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-white/10 flex justify-end gap-2 bg-black/20 shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm font-medium text-white/70 hover:text-white transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} className="px-4 py-2 text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors flex items-center gap-2">
            <Check className="w-4 h-4" />
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
};
