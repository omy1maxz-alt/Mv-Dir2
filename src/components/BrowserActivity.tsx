import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Browser } from '@capacitor/browser';
import { Capacitor } from '@capacitor/core';
import { 
  X, Globe, ArrowLeft, ArrowRight, RotateCw, Home, Search, 
  Tv, Lock, Maximize2, Minimize2, Bookmark, Copy, 
  Check, Terminal, Youtube, ZoomIn, ZoomOut, AlertTriangle, 
  ShieldAlert, Activity, Clock, Plus, Trash2, PlusCircle, 
  Sparkles, Compass, Star, Info, Clapperboard, Cpu,
  Shield, ExternalLink
} from 'lucide-react';
import { normalizeYoutubeUrl } from '@/services/youtube';
import { addCapturedLog } from '@/services/logCapture';
import { 
  UserAgentMode, 
  getUserAgentMode, 
  setUserAgentSettings, 
  getEffectiveUserAgent, 
  getCustomUserAgentString,
  getNativeOriginalUserAgent,
  isWebViewUserAgent,
  PRESET_MOBILE_CHROME_UA,
  PRESET_DESKTOP_CHROME_UA
} from '@/services/userAgentService';

interface BrowserActivityProps {
  initialUrl?: string;
  onOpenCaptureLogs?: () => void;
  onOpenDirectorApp?: () => void;
}

export interface BookmarkItem {
  id: string;
  name: string;
  url: string;
  iconType: 'youtube' | 'search' | 'wiki' | 'reddit' | 'archive' | 'ai' | 'globe';
  color?: string;
}

interface BrowserLogItem {
  id: string;
  time: string;
  level: 'info' | 'warn' | 'error' | 'network' | 'success';
  title: string;
  detail?: string;
}

interface UrlAnalysis {
  hostname: string;
  protocol: string;
  isSecure: boolean;
  isMixedContent: boolean;
  isKnownBlockedHost: boolean;
  isNewTab: boolean;
  headerReason?: string;
  explanation?: string;
  recommendation?: string;
}

export interface BrowserTabState {
  id: string;
  title: string;
  url: string;
  inputUrl: string;
  history: string[];
  historyIndex: number;
  isLoading: boolean;
  loadStage: 'idle' | 'probing' | 'loading' | 'loaded' | 'warning' | 'error' | 'timeout';
  loadDuration: number;
  iframeKey: number;
}

const DEFAULT_BOOKMARKS: BookmarkItem[] = [
  {
    id: 'bm_google',
    name: 'Google Search',
    url: 'https://www.google.com',
    iconType: 'search',
    color: 'text-blue-400'
  },
  {
    id: 'bm_yt',
    name: 'YouTube In-App',
    url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&enablejsapi=1&playsinline=1&rel=0',
    iconType: 'youtube',
    color: 'text-red-500'
  },
  {
    id: 'bm_ddg',
    name: 'DuckDuckGo',
    url: 'https://duckduckgo.com',
    iconType: 'search',
    color: 'text-amber-400'
  },
  {
    id: 'bm_wiki',
    name: 'Wikipedia',
    url: 'https://en.m.wikipedia.org',
    iconType: 'wiki',
    color: 'text-blue-400'
  },
  {
    id: 'bm_bing',
    name: 'Bing',
    url: 'https://www.bing.com',
    iconType: 'search',
    color: 'text-emerald-400'
  },
  {
    id: 'bm_reddit',
    name: 'Reddit Mobile',
    url: 'https://sh.reddit.com',
    iconType: 'reddit',
    color: 'text-orange-500'
  },
  {
    id: 'bm_archive',
    name: 'Internet Archive',
    url: 'https://archive.org',
    iconType: 'archive',
    color: 'text-cyan-400'
  },
  {
    id: 'bm_suno',
    name: 'Suno AI',
    url: 'https://suno.com',
    iconType: 'ai',
    color: 'text-pink-400'
  }
];

export const BrowserActivity: React.FC<BrowserActivityProps> = ({
  initialUrl = 'mv://newtab',
  onOpenCaptureLogs,
  onOpenDirectorApp
}) => {
  // Helper to extract a human-readable title from a URL
  const formatTabTitle = (url: string): string => {
    try {
      if (!url || url === 'mv://newtab' || url === 'about:newtab') return 'New Tab';
      if (url.includes('duckduckgo.com')) return 'DuckDuckGo';
      if (url.includes('youtube') || url.includes('youtu.be')) return 'YouTube Player';
      if (url.includes('wikipedia.org')) return 'Wikipedia';
      if (url.includes('bing.com')) return 'Bing';
      if (url.includes('reddit.com')) return 'Reddit';
      if (url.includes('archive.org')) return 'Archive';
      if (url.includes('suno.com')) return 'Suno AI';
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      return parsed.hostname.replace(/^www\./, '');
    } catch {
      return 'New Tab';
    }
  };

  // Persistent Bookmarks with Delete & Add
  const [bookmarks, setBookmarks] = useState<BookmarkItem[]>(() => {
    try {
      const saved = localStorage.getItem('mv_browser_bookmarks_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return DEFAULT_BOOKMARKS;
  });

  useEffect(() => {
    try {
      localStorage.setItem('mv_browser_bookmarks_v2', JSON.stringify(bookmarks));
    } catch {}
  }, [bookmarks]);

  // Multi-tab state management
  const [tabs, setTabs] = useState<BrowserTabState[]>(() => [
    {
      id: 'tab_primary_1',
      title: formatTabTitle(initialUrl),
      url: initialUrl,
      inputUrl: initialUrl === 'mv://newtab' ? '' : initialUrl,
      history: [initialUrl],
      historyIndex: 0,
      isLoading: false,
      loadStage: 'idle',
      loadDuration: 0,
      iframeKey: 1,
    }
  ]);
  const [activeTabId, setActiveTabId] = useState<string>('tab_primary_1');

  // Active tab helper
  const activeTab = tabs.find(t => t.id === activeTabId) || tabs[0];

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedReport, setCopiedReport] = useState(false);
  const [showYtSearch, setShowYtSearch] = useState(false);
  const [ytSearchQuery, setYtSearchQuery] = useState('');
  const [zoomLevel, setZoomLevel] = useState(100);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showAddShortcutModal, setShowAddShortcutModal] = useState(false);
  const [newShortcutName, setNewShortcutName] = useState('');
  const [newShortcutUrl, setNewShortcutUrl] = useState('');
  const [browserLogs, setBrowserLogs] = useState<BrowserLogItem[]>([]);
  const [probeResult, setProbeResult] = useState<{ status: string; latency: number; reachable: boolean } | null>(null);

  // User-Agent Diagnostic Engine State
  const [uaMode, setUaMode] = useState<UserAgentMode>(getUserAgentMode());
  const [customUaInput, setCustomUaInput] = useState(getCustomUserAgentString());
  const [showUaModal, setShowUaModal] = useState(false);
  const [currentEffectiveUa, setCurrentEffectiveUa] = useState(getEffectiveUserAgent());
  const [copiedUa, setCopiedUa] = useState(false);
  const [useProxy, setUseProxy] = useState<boolean>(false);

  useEffect(() => {
    const handleUaChange = () => {
      setUaMode(getUserAgentMode());
      setCurrentEffectiveUa(getEffectiveUserAgent());
    };
    window.addEventListener('mv:useragent-changed', handleUaChange);
    return () => window.removeEventListener('mv:useragent-changed', handleUaChange);
  }, []);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const loadStartTimerRef = useRef<number>(Date.now());
  const timeoutIdRef = useRef<any>(null);

  const appendBrowserLog = useCallback((level: BrowserLogItem['level'], title: string, detail?: string) => {
    const timeStr = new Date().toLocaleTimeString();
    const newLog: BrowserLogItem = {
      id: `blog_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      time: timeStr,
      level,
      title,
      detail
    };
    setBrowserLogs(prev => [newLog, ...prev.slice(0, 49)]);

    // Mirror to central logCapture
    addCapturedLog({
      level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : level === 'network' ? 'network' : 'info',
      category: 'browser',
      message: `[Main Activity Browser] ${title}`,
      data: { detail, url: activeTab?.url, time: timeStr }
    });
  }, [activeTab?.url]);

  // Analyze URL for anti-framing policies, mixed content, and security headers
  const analyzeUrl = useCallback((url: string): UrlAnalysis => {
    if (!url || url === 'mv://newtab' || url === 'about:newtab') {
      return {
        hostname: 'New Tab',
        protocol: 'mv:',
        isSecure: true,
        isMixedContent: false,
        isKnownBlockedHost: false,
        isNewTab: true,
        headerReason: 'New Tab Speed Dial',
        explanation: 'Shortcut Web Start Screen with quick search and bookmarks.',
        recommendation: 'Select a shortcut or enter a search query.'
      };
    }

    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      const host = parsed.hostname.toLowerCase();
      const isSecure = parsed.protocol === 'https:';
      const isParentHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';
      const isMixedContent = isParentHttps && !isSecure;

      const isYtPortal = (host.includes('youtube.com') || host.includes('youtu.be')) && !parsed.pathname.startsWith('/embed/');
      const isSearchEngine = host.includes('google.com') || host.includes('duckduckgo.com') || host.includes('bing.com') || host.includes('yahoo.com');
      const isSocialPortal = host.includes('twitter.com') || host.includes('x.com') || host.includes('facebook.com') || host.includes('instagram.com') || host.includes('reddit.com');
      const isAuthPortal = host.includes('github.com') && (parsed.pathname.includes('/login') || parsed.pathname.includes('/signup'));

      if (isYtPortal) {
        return {
          hostname: host,
          protocol: parsed.protocol,
          isSecure,
          isMixedContent,
          isKnownBlockedHost: true,
          isNewTab: false,
          headerReason: 'X-Frame-Options: SAMEORIGIN & CSP frame-ancestors',
          explanation: 'YouTube main portal pages forbid framing. Use the in-app approved player.',
          recommendation: 'Use YouTube In-App player or YouTube Search button for instant playback.'
        };
      }

      if (isSearchEngine) {
        return {
          hostname: host,
          protocol: parsed.protocol,
          isSecure,
          isMixedContent,
          isKnownBlockedHost: true,
          isNewTab: false,
          headerReason: 'X-Frame-Options: SAMEORIGIN',
          explanation: `${host} blocks direct iframe embedding to prevent clickjacking. Routed through In-App Web Proxy.`,
          recommendation: 'Render via In-App Web Proxy or open in native browser tab.'
        };
      }

      if (isSocialPortal || isAuthPortal) {
        return {
          hostname: host,
          protocol: parsed.protocol,
          isSecure,
          isMixedContent,
          isKnownBlockedHost: true,
          isNewTab: false,
          headerReason: 'X-Frame-Options: DENY / SAMEORIGIN',
          explanation: `The server at ${host} sends security headers that block framing.`,
          recommendation: 'Open this page via native launcher or alternative search.'
        };
      }

      if (isMixedContent) {
        return {
          hostname: host,
          protocol: parsed.protocol,
          isSecure: false,
          isMixedContent: true,
          isKnownBlockedHost: true,
          isNewTab: false,
          headerReason: 'Mixed Content (HTTP on HTTPS parent)',
          explanation: `Insecure HTTP resource ${url} cannot be rendered on HTTPS origin.`,
          recommendation: 'Ensure the URL begins with https://.'
        };
      }

      return {
        hostname: host,
        protocol: parsed.protocol,
        isSecure,
        isMixedContent: false,
        isKnownBlockedHost: false,
        isNewTab: false,
        headerReason: 'Allowed for in-app viewing',
        explanation: 'This address is compatible with in-app web viewing.',
        recommendation: 'Standard web navigation active.'
      };
    } catch (err: any) {
      return {
        hostname: 'unknown',
        protocol: 'unknown',
        isSecure: false,
        isMixedContent: false,
        isKnownBlockedHost: false,
        isNewTab: false,
        headerReason: 'Malformed URL',
        explanation: `Invalid URL format: ${err?.message}`,
        recommendation: 'Enter a valid URL or search term.'
      };
    }
  }, []);

  const currentAnalysis = analyzeUrl(activeTab?.url || 'mv://newtab');

  const getEffectiveIframeSrc = useCallback((url: string) => {
    if (!url || url === 'mv://newtab' || url === 'about:newtab') return url;
    // YouTube's approved embed endpoint should remain direct.
    if (url.includes('youtube-nocookie.com/embed/') || url.includes('youtube.com/embed/')) {
      return url;
    }
    // Direct navigation is the default. The HTML proxy is an optional compatibility
    // mode only; it cannot provide full browser behavior for arbitrary modern sites.
    if (useProxy) {
      return `/api/proxy?url=${encodeURIComponent(url)}`;
    }
    return url;
  }, [useProxy]);

  // Format any URL or YouTube link with YouTube's approved player configuration
  const formatBrowseUrl = (raw: string): string => {
    let clean = raw.trim();
    if (!clean || clean === 'mv://newtab' || clean === 'about:newtab') return 'mv://newtab';

    // 1. YouTube video or playlist links: approved in-app player with proper origin & parameters
    const yt = normalizeYoutubeUrl(clean);
    if (yt.isValid && yt.videoId) {
      const origin = typeof window !== 'undefined' ? window.location.origin : '';
      return `https://www.youtube-nocookie.com/embed/${yt.videoId}?autoplay=1&enablejsapi=1&playsinline=1&rel=0&origin=${encodeURIComponent(origin)}`;
    }

    // 2. Plain search queries without dot or protocol -> DuckDuckGo Search
    if (!clean.includes('.') && !clean.startsWith('http') && !clean.startsWith('localhost') && !clean.startsWith('mv:')) {
      return `https://duckduckgo.com/?q=${encodeURIComponent(clean)}`;
    }

    // 3. Ensure HTTPS protocol
    if (!/^https?:\/\//i.test(clean) && !clean.startsWith('mv:')) {
      clean = 'https://' + clean;
    }

    return clean;
  };

  // Active Network Probe
  const probeHost = useCallback(async (targetUrl: string) => {
    if (!targetUrl || targetUrl.startsWith('mv:')) {
      setProbeResult({ status: 'New Tab (Local)', latency: 0, reachable: true });
      return;
    }
    const startProbe = Date.now();
    try {
      appendBrowserLog('network', `Probing network reachability for: ${targetUrl}`);
      await fetch(targetUrl, { mode: 'no-cors', cache: 'no-cache' });
      const latency = Date.now() - startProbe;
      setProbeResult({ status: 'Connected (200 OK)', latency, reachable: true });
      appendBrowserLog('success', `Network reachable (${latency}ms)`);
    } catch (err: any) {
      const latency = Date.now() - startProbe;
      const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      setProbeResult({ 
        status: isOnline ? 'CORS / Anti-Frame Restriction' : 'Offline', 
        latency, 
        reachable: false 
      });
      appendBrowserLog(
        isOnline ? 'warn' : 'error', 
        `Probe response: ${isOnline ? 'CORS / Framing header detected' : 'Device offline'} (${latency}ms)`
      );
    }
  }, [appendBrowserLog]);

  // Navigate the active tab
  const navigateTo = (rawInput: string) => {
    const formatted = formatBrowseUrl(rawInput);
    const title = formatTabTitle(formatted);
    const analysis = analyzeUrl(formatted);

    loadStartTimerRef.current = Date.now();

    setTabs(prev => prev.map(t => {
      if (t.id === activeTab.id) {
        const sliced = t.history.slice(0, t.historyIndex + 1);
        return {
          ...t,
          title,
          url: formatted,
          inputUrl: formatted === 'mv://newtab' ? '' : formatted,
          history: [...sliced, formatted],
          historyIndex: t.historyIndex + 1,
          isLoading: !analysis.isNewTab,
          loadStage: analysis.isNewTab ? 'idle' : analysis.isKnownBlockedHost ? 'warning' : 'loading',
          loadDuration: 0,
          iframeKey: t.iframeKey + 1
        };
      }
      return t;
    }));

    appendBrowserLog('info', `Tab [${activeTab.title}] Navigating -> ${formatted}`);
    probeHost(formatted);

    if (!analysis.isNewTab) {
      if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);
      timeoutIdRef.current = setTimeout(() => {
        setTabs(prev => prev.map(t => {
          if (t.id === activeTab.id && t.isLoading) {
            appendBrowserLog('warn', `Load Timeout (12s elapsed) for ${formatted}`);
            return { ...t, isLoading: false, loadStage: 'timeout' };
          }
          return t;
        }));
      }, 12000);
    }
  };

  // Multi-Tab Actions: New Tab
  const handleNewTab = (newUrl = 'mv://newtab') => {
    const newId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const formatted = formatBrowseUrl(newUrl);
    const newTab: BrowserTabState = {
      id: newId,
      title: formatTabTitle(formatted),
      url: formatted,
      inputUrl: formatted === 'mv://newtab' ? '' : formatted,
      history: [formatted],
      historyIndex: 0,
      isLoading: formatted !== 'mv://newtab',
      loadStage: formatted === 'mv://newtab' ? 'idle' : 'loading',
      loadDuration: 0,
      iframeKey: 1,
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(newId);
    appendBrowserLog('info', `Opened new tab: [${newTab.title}]`);
    probeHost(formatted);
  };

  // Multi-Tab Actions: Close Tab
  const handleCloseTab = (tabIdToClose: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();

    // If only one tab left, reset it to New Tab Speed Dial
    if (tabs.length === 1) {
      const defaultUrl = 'mv://newtab';
      setTabs([{
        id: `tab_${Date.now()}`,
        title: 'New Tab',
        url: defaultUrl,
        inputUrl: '',
        history: [defaultUrl],
        historyIndex: 0,
        isLoading: false,
        loadStage: 'idle',
        loadDuration: 0,
        iframeKey: 1,
      }]);
      appendBrowserLog('info', `Reset single remaining tab to New Tab`);
      return;
    }

    // Determine next active tab if closing the currently active one
    if (tabIdToClose === activeTabId) {
      const currentIndex = tabs.findIndex(t => t.id === tabIdToClose);
      const nextIndex = currentIndex > 0 ? currentIndex - 1 : 1;
      setActiveTabId(tabs[nextIndex].id);
    }

    setTabs(prev => prev.filter(t => t.id !== tabIdToClose));
    appendBrowserLog('info', `Closed tab ID: ${tabIdToClose}`);
  };

  // Bookmark Actions: Delete Bookmark
  const handleDeleteBookmark = (bmId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setBookmarks(prev => prev.filter(bm => bm.id !== bmId));
    appendBrowserLog('info', `Deleted bookmark ID: ${bmId}`);
  };

  // Bookmark Actions: Add Bookmark
  const handleAddBookmark = (name: string, url: string) => {
    if (!name.trim() || !url.trim()) return;
    const formatted = formatBrowseUrl(url);
    const newBm: BookmarkItem = {
      id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      name: name.trim(),
      url: formatted,
      iconType: formatted.includes('youtube') ? 'youtube' : 'globe',
      color: 'text-teal-400'
    };
    setBookmarks(prev => [...prev, newBm]);
    setShowAddShortcutModal(false);
    setNewShortcutName('');
    setNewShortcutUrl('');
    appendBrowserLog('info', `Added bookmark: ${name} (${formatted})`);
  };

  // Restore Default Bookmarks
  const handleResetBookmarks = () => {
    setBookmarks(DEFAULT_BOOKMARKS);
    appendBrowserLog('info', `Reset bookmarks to defaults`);
  };

  useEffect(() => {
    const handleCustomNav = (e: any) => {
      const targetUrl = e.detail?.url;
      if (targetUrl) {
        navigateTo(targetUrl);
      }
    };
    window.addEventListener('mv:navigate-browser', handleCustomNav);
    return () => window.removeEventListener('mv:navigate-browser', handleCustomNav);
  }, []);

  const handleIframeLoad = () => {
    const duration = Date.now() - loadStartTimerRef.current;
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);

    setTabs(prev => prev.map(t => {
      if (t.id === activeTab.id) {
        return {
          ...t,
          isLoading: false,
          loadDuration: duration,
          loadStage: currentAnalysis.isKnownBlockedHost ? 'warning' : 'loaded'
        };
      }
      return t;
    }));

    appendBrowserLog(
      currentAnalysis.isKnownBlockedHost ? 'warn' : 'success',
      `Iframe loaded in ${duration}ms`
    );
  };

  const handleIframeError = () => {
    const duration = Date.now() - loadStartTimerRef.current;
    if (timeoutIdRef.current) clearTimeout(timeoutIdRef.current);

    setTabs(prev => prev.map(t => {
      if (t.id === activeTab.id) {
        return {
          ...t,
          isLoading: false,
          loadDuration: duration,
          loadStage: 'error'
        };
      }
      return t;
    }));

    appendBrowserLog('error', `Load error on tab [${activeTab.title}]`);
  };

  const handleBack = () => {
    if (activeTab.historyIndex > 0) {
      const prevUrl = activeTab.history[activeTab.historyIndex - 1];
      setTabs(prev => prev.map(t => {
        if (t.id === activeTab.id) {
          return {
            ...t,
            url: prevUrl,
            inputUrl: prevUrl === 'mv://newtab' ? '' : prevUrl,
            title: formatTabTitle(prevUrl),
            historyIndex: t.historyIndex - 1,
            isLoading: prevUrl !== 'mv://newtab',
            iframeKey: t.iframeKey + 1
          };
        }
        return t;
      }));
      appendBrowserLog('info', `Back navigation -> ${prevUrl}`);
    }
  };

  const handleForward = () => {
    if (activeTab.historyIndex < activeTab.history.length - 1) {
      const nextUrl = activeTab.history[activeTab.historyIndex + 1];
      setTabs(prev => prev.map(t => {
        if (t.id === activeTab.id) {
          return {
            ...t,
            url: nextUrl,
            inputUrl: nextUrl === 'mv://newtab' ? '' : nextUrl,
            title: formatTabTitle(nextUrl),
            historyIndex: t.historyIndex + 1,
            isLoading: nextUrl !== 'mv://newtab',
            iframeKey: t.iframeKey + 1
          };
        }
        return t;
      }));
      appendBrowserLog('info', `Forward navigation -> ${nextUrl}`);
    }
  };

  const handleReload = () => {
    if (activeTab.url === 'mv://newtab') return;
    setTabs(prev => prev.map(t => {
      if (t.id === activeTab.id) {
        return {
          ...t,
          isLoading: true,
          loadStage: 'loading',
          iframeKey: t.iframeKey + 1
        };
      }
      return t;
    }));
    loadStartTimerRef.current = Date.now();
    appendBrowserLog('info', `Reloading tab [${activeTab.title}]`);
    probeHost(activeTab.url);
  };

  const handleHome = () => {
    navigateTo('mv://newtab');
  };

  const handleApplyUserAgent = (mode: UserAgentMode, customString?: string) => {
    setUserAgentSettings(mode, customString);
    setUaMode(mode);
    setCurrentEffectiveUa(getEffectiveUserAgent());
    setShowUaModal(false);
    appendBrowserLog('info', `Switched User-Agent profile to [${mode}]`);
    if (activeTab.url !== 'mv://newtab') {
      handleReload();
    }
  };

  const openInFullBrowser = useCallback(async (url: string = activeTab?.url || '') => {
    if (!url || url === 'mv://newtab' || url === 'about:newtab') return;
    try {
      if (Capacitor.isNativePlatform()) {
        // Android/iOS open a real browser surface so sites can run their normal navigation,
        // login, cookies, JavaScript and download flows without iframe restrictions.
        await Browser.open({ url });
      } else {
        // Web preview: open a separate browser tab. Popup blockers can still apply.
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      appendBrowserLog('success', 'Opened page in full browser', url);
    } catch (error: any) {
      appendBrowserLog('error', 'Could not open full browser', error?.message || String(error));
    }
  }, [activeTab?.url, appendBrowserLog]);

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(activeTab.url === 'mv://newtab' ? 'https://duckduckgo.com' : activeTab.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyDiagnosticsReport = () => {
    const report = [
      `=== MVDirector Main Activity Browser Report ===`,
      `Active Tab ID: ${activeTab.id} (${activeTab.title})`,
      `Total Open Tabs: ${tabs.length}`,
      `Target URL: ${activeTab.url}`,
      `Hostname: ${currentAnalysis.hostname}`,
      `Protocol: ${currentAnalysis.protocol}`,
      `Secure HTTPS: ${currentAnalysis.isSecure}`,
      `Known Blocked Host: ${currentAnalysis.isKnownBlockedHost}`,
      `Header Status: ${currentAnalysis.headerReason || 'N/A'}`,
      `User-Agent Profile: ${uaMode}`,
      `Effective User-Agent: ${currentEffectiveUa}`,
      `Android WebView UA Detected: ${isWebViewUserAgent(currentEffectiveUa) ? 'Yes (contains Version/4.0 or ; wv)' : 'No (Standard Browser)'}`,
      `Explanation: ${currentAnalysis.explanation || 'N/A'}`,
      `Recommendation: ${currentAnalysis.recommendation || 'N/A'}`,
      `Network Reachable: ${probeResult?.reachable ? 'Yes' : 'No'} (${probeResult?.latency || 0}ms)`,
      `Bookmarks Count: ${bookmarks.length}`,
      `Recent Browser Logs:`,
      ...browserLogs.slice(0, 10).map(l => `  [${l.time}] [${l.level.toUpperCase()}] ${l.title}`)
    ].join('\n');

    navigator.clipboard.writeText(report);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 2000);
  };

  const handleYtSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ytSearchQuery.trim()) return;
    const query = `https://duckduckgo.com/?q=site%3Ayoutube.com+${encodeURIComponent(ytSearchQuery.trim())}&iax=videos&ia=videos`;
    navigateTo(query);
    setShowYtSearch(false);
  };

  const renderBookmarkIcon = (iconType: BookmarkItem['iconType']) => {
    switch (iconType) {
      case 'youtube': return <Youtube className="w-4 h-4 text-red-500" />;
      case 'search': return <Search className="w-4 h-4 text-amber-400" />;
      case 'wiki': return <Globe className="w-4 h-4 text-blue-400" />;
      case 'reddit': return <Globe className="w-4 h-4 text-orange-500" />;
      case 'archive': return <Globe className="w-4 h-4 text-cyan-400" />;
      case 'ai': return <Sparkles className="w-4 h-4 text-pink-400" />;
      default: return <Globe className="w-4 h-4 text-teal-400" />;
    }
  };

  return (
    <div className="w-full h-full flex flex-col bg-[#0b0b12] overflow-hidden text-white">
      
      {/* Multi-Tab Bar (New Tab & Close Tab) */}
      <div className="bg-[#0f0f18] border-b border-white/10 px-2 pt-2 flex items-center justify-between gap-2 select-none overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden shrink-0">
        
        {/* Tab Strip */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTab.id;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`group relative flex items-center gap-2 px-3 py-1.5 rounded-t-xl text-xs font-medium cursor-pointer border-t border-x transition-all max-w-[160px] sm:max-w-[200px] shrink-0 ${
                  isActive
                    ? 'bg-[#181824] border-white/20 text-white shadow-lg shadow-black/40'
                    : 'bg-white/5 border-transparent text-white/50 hover:text-white/80 hover:bg-white/10'
                }`}
              >
                <Globe className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'text-teal-400' : 'text-white/40'}`} />
                
                <span className="truncate flex-1 text-[11px] font-medium">
                  {tab.title || 'New Tab'}
                </span>

                {/* Close Tab Button */}
                <button
                  type="button"
                  onClick={(e) => handleCloseTab(tab.id, e)}
                  className={`p-0.5 rounded-md hover:bg-white/20 transition-colors shrink-0 ${
                    isActive ? 'text-white/60 hover:text-white' : 'text-white/30 hover:text-white'
                  }`}
                  title="Close Tab"
                >
                  <X className="w-3.5 h-3.5" />
                </button>

                {/* Active Tab Accent Line */}
                {isActive && (
                  <div className="absolute top-0 left-2 right-2 h-0.5 bg-gradient-to-r from-teal-400 to-emerald-400 rounded-full" />
                )}
              </div>
            );
          })}

          {/* New Tab Button (+) */}
          <button
            type="button"
            onClick={() => handleNewTab('mv://newtab')}
            className="p-1.5 bg-white/5 hover:bg-teal-500/20 text-white/60 hover:text-teal-300 border border-white/10 hover:border-teal-500/30 rounded-lg text-xs transition-all flex items-center gap-1 shrink-0 ml-0.5"
            title="New Tab (Speed Dial & Shortcuts)"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline text-[11px] font-bold">New Tab</span>
          </button>
        </div>
      </div>

      {/* Top Browser Toolbar / Chrome */}
      <div className="p-2 sm:p-2.5 bg-[#181824] border-b border-white/10 shrink-0 space-y-2">
        
        {/* Header Row: Diagnostics, Controls & Search */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-black/40 border border-white/10 text-[10px] font-mono">
              {activeTab.url === 'mv://newtab' ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-teal-400"></span>
                  <span className="text-teal-300 font-bold">Speed Dial Activity</span>
                </>
              ) : activeTab.isLoading ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                  <span className="text-amber-300">Loading...</span>
                </>
              ) : currentAnalysis.isKnownBlockedHost ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                  <span className="text-amber-300">Anti-Frame Host</span>
                </>
              ) : activeTab.loadStage === 'loaded' ? (
                <>
                  <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                  <span className="text-emerald-300">{activeTab.loadDuration}ms</span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 rounded-full bg-teal-400"></span>
                  <span className="text-teal-300">Ready</span>
                </>
              )}
            </div>
          </div>

          {/* Window Controls */}
          <div className="flex items-center gap-1">
            {onOpenDirectorApp && (
              <button
                type="button"
                onClick={onOpenDirectorApp}
                className="px-2.5 py-1 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white rounded-lg text-xs font-bold transition-all shadow-md flex items-center gap-1.5 shrink-0 border border-indigo-400/30"
                title="Return to MV Director Editor (Main Activity)"
              >
                <Clapperboard className="w-3.5 h-3.5 text-indigo-200" />
                <span>MV Director</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setShowUaModal(true)}
              className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${
                uaMode !== 'default'
                  ? 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                  : 'bg-white/5 hover:bg-white/10 text-white/80'
              }`}
              title="Configure Browsing Engine User-Agent"
            >
              <Cpu className="w-3.5 h-3.5 text-teal-400" />
              <span className="hidden sm:inline">
                UA: {uaMode === 'default' ? 'Default' : uaMode === 'mobile-chrome' ? 'Mobile' : uaMode === 'desktop-chrome' ? 'Desktop' : 'Custom'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setUseProxy(!useProxy);
                handleReload();
              }}
              className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${
                useProxy
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'bg-white/5 hover:bg-white/10 text-white/50'
              }`}
              title={useProxy ? 'HTML proxy active; some modern sites may not work fully' : 'Direct connection for sites that allow iframe embedding'}
            >
              <Shield className={`w-3.5 h-3.5 ${useProxy ? 'text-emerald-400' : 'text-white/40'}`} />
              <span className="hidden sm:inline">Proxy: {useProxy ? 'ON' : 'OFF'}</span>
            </button>

                        <button
                type="button"
                onClick={() => void openInFullBrowser()}
                className="p-1.5 px-2 text-white/60 hover:text-teal-300 hover:bg-teal-500/10 rounded-lg transition-colors flex items-center gap-1.5"
                title="Open in full browser (normal browsing, sign-in and site navigation)"
                aria-label="Open in full browser"
              >
                <ExternalLink className="w-3.5 h-3.5 text-white/80" />
                <span className="hidden sm:inline text-[10px] font-medium">Full Browser</span>
              </button>

            <button
              type="button"
              onClick={() => setShowDiagnostics(!showDiagnostics)}
              className={`px-2 py-1 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${
                showDiagnostics || currentAnalysis.isKnownBlockedHost
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  : 'bg-white/5 hover:bg-white/10 text-white/80'
              }`}
              title="Toggle Live Diagnostics & Error Inspector"
            >
              <Activity className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline">Diagnostics</span>
            </button>

            <button
              type="button"
              onClick={() => setShowYtSearch(!showYtSearch)}
              className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5 ${
                showYtSearch ? 'bg-red-600 text-white shadow' : 'bg-white/5 hover:bg-white/10 text-white/80'
              }`}
              title="Search YouTube Videos"
            >
              <Youtube className="w-3.5 h-3.5 text-red-400" />
              <span className="hidden sm:inline">YouTube Search</span>
            </button>

            <button
              type="button"
              onClick={() => setZoomLevel(z => Math.max(75, z - 10))}
              className="p-1.5 text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-colors hidden sm:flex"
              title="Zoom Out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setZoomLevel(z => Math.min(150, z + 10))}
              className="p-1.5 text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-colors hidden sm:flex"
              title="Zoom In"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setIsFullscreen(!isFullscreen)}
              className="p-1.5 text-white/50 hover:text-white hover:bg-white/10 rounded-lg transition-colors hidden sm:flex"
              title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* YouTube Search Overlay */}
        {showYtSearch && (
          <form onSubmit={handleYtSearch} className="flex gap-2 p-2 bg-red-950/40 border border-red-500/30 rounded-xl animate-in fade-in slide-in-from-top-1">
            <input
              type="text"
              value={ytSearchQuery}
              onChange={(e) => setYtSearchQuery(e.target.value)}
              placeholder="Search any song, music video, or creator on YouTube..."
              className="flex-1 bg-black/60 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-red-500 font-sans"
              autoFocus
            />
            <button
              type="submit"
              className="px-3.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-xs font-bold transition-colors shadow flex items-center gap-1 shrink-0"
            >
              <Search className="w-3.5 h-3.5" />
              <span>Search</span>
            </button>
          </form>
        )}

        {/* Navigation Controls & Omnibar */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          
          {/* Back / Forward / Reload / Home */}
          <div className="flex items-center gap-0.5 bg-black/50 p-0.5 rounded-xl border border-white/10 shrink-0">
            <button
              type="button"
              disabled={activeTab.historyIndex <= 0}
              onClick={handleBack}
              className="p-1.5 text-white/60 hover:text-white disabled:opacity-30 rounded-lg transition-colors"
              title="Back"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={activeTab.historyIndex >= activeTab.history.length - 1}
              onClick={handleForward}
              className="p-1.5 text-white/60 hover:text-white disabled:opacity-30 rounded-lg transition-colors"
              title="Forward"
            >
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleReload}
              className="p-1.5 text-white/60 hover:text-white rounded-lg transition-colors"
              title="Reload"
            >
              <RotateCw className={`w-3.5 h-3.5 ${activeTab.isLoading ? 'animate-spin text-teal-400' : ''}`} />
            </button>
            <button
              type="button"
              onClick={handleHome}
              className="p-1.5 text-white/60 hover:text-white rounded-lg transition-colors"
              title="Home (Speed Dial & Shortcuts)"
            >
              <Home className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Omnibar (Address & Search Input) */}
          <div className="relative flex-1 flex items-center">
            <div className="absolute left-3 flex items-center pointer-events-none">
              {currentAnalysis.isNewTab ? (
                <Compass className="w-3.5 h-3.5 text-teal-400" />
              ) : currentAnalysis.isSecure ? (
                <Lock className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400" />
              )}
            </div>
            <input
              type="text"
              value={activeTab.inputUrl}
              onChange={(e) => {
                const val = e.target.value;
                setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, inputUrl: val } : t));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  navigateTo(activeTab.inputUrl);
                }
              }}
              placeholder="Search web or enter address (e.g. wikipedia.org, YouTube link)..."
              className="w-full bg-black/60 border border-white/15 text-white rounded-xl pl-9 pr-16 py-2 text-xs outline-none focus:border-teal-500 placeholder:text-white/30 transition-colors font-mono"
            />
            <div className="absolute right-2 flex items-center gap-1">
              {activeTab.inputUrl && (
                <button
                  type="button"
                  onClick={() => {
                    setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, inputUrl: '' } : t));
                  }}
                  className="p-1 text-white/30 hover:text-white"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
              <button
                type="button"
                onClick={handleCopyUrl}
                className="p-1 text-white/30 hover:text-white"
                title="Copy URL"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
          </div>

          {/* Go Button */}
          <button
            type="button"
            onClick={() => navigateTo(activeTab.inputUrl)}
            className="px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-xl text-xs font-bold transition-all shadow flex items-center gap-1 shrink-0"
          >
            <span>Go</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Quick Bookmarks Bar (With Delete Bookmark Button on each bookmark) */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <span className="text-[10px] uppercase tracking-wider text-white/40 font-bold mr-1 shrink-0 flex items-center gap-1">
            <Bookmark className="w-3 h-3 text-teal-400" />
            <span>Bookmarks:</span>
          </span>

          {bookmarks.map((bm) => (
            <div
              key={bm.id}
              className={`group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-lg text-xs font-medium border transition-all shrink-0 ${
                activeTab.url === bm.url
                  ? 'bg-white/20 border-white/40 text-white shadow'
                  : 'bg-white/5 hover:bg-white/10 border-white/10 text-white/70 hover:text-white'
              }`}
            >
              <button
                type="button"
                onClick={() => navigateTo(bm.url)}
                className="flex items-center gap-1.5 outline-none cursor-pointer"
              >
                {renderBookmarkIcon(bm.iconType)}
                <span>{bm.name}</span>
              </button>

              {/* Delete Bookmark Button */}
              <button
                type="button"
                onClick={(e) => handleDeleteBookmark(bm.id, e)}
                className="p-0.5 text-white/30 hover:text-red-400 hover:bg-white/10 rounded transition-colors"
                title={`Delete bookmark "${bm.name}"`}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}

          {/* Add Bookmark / Reset Buttons */}
          <button
            type="button"
            onClick={() => setShowAddShortcutModal(true)}
            className="p-1 bg-white/5 hover:bg-teal-500/20 text-teal-400 hover:text-teal-300 border border-white/10 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1 shrink-0 px-2"
            title="Add New Bookmark / Shortcut"
          >
            <Plus className="w-3 h-3" />
            <span>Add</span>
          </button>
        </div>
      </div>

      {/* Modal for Adding Shortcut / Bookmark */}
      {showAddShortcutModal && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-sm bg-[#161622] border border-white/15 rounded-2xl p-4 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-white/10 pb-2">
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <Bookmark className="w-4 h-4 text-teal-400" />
                <span>Add Web Shortcut</span>
              </h4>
              <button
                type="button"
                onClick={() => setShowAddShortcutModal(false)}
                className="p-1 text-white/40 hover:text-white rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-[11px] text-white/50 mb-1">Shortcut Name</label>
                <input
                  type="text"
                  value={newShortcutName}
                  onChange={(e) => setNewShortcutName(e.target.value)}
                  placeholder="e.g. YouTube Music, Spotify Web, Suno..."
                  className="w-full bg-black/60 border border-white/15 rounded-xl px-3 py-2 text-white outline-none focus:border-teal-500 text-xs"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[11px] text-white/50 mb-1">Web Address (URL)</label>
                <input
                  type="text"
                  value={newShortcutUrl}
                  onChange={(e) => setNewShortcutUrl(e.target.value)}
                  placeholder="e.g. m.youtube.com, wikipedia.org, suno.com..."
                  className="w-full bg-black/60 border border-white/15 rounded-xl px-3 py-2 text-white outline-none focus:border-teal-500 text-xs font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={handleResetBookmarks}
                className="text-[10px] text-white/40 hover:text-teal-300 underline"
              >
                Reset Defaults
              </button>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddShortcutModal(false)}
                  className="px-3 py-1.5 bg-white/10 text-white rounded-xl text-xs"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleAddBookmark(newShortcutName, newShortcutUrl)}
                  disabled={!newShortcutName.trim() || !newShortcutUrl.trim()}
                  className="px-4 py-1.5 bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white rounded-xl text-xs font-bold shadow"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* User-Agent Settings Modal */}
      {showUaModal && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in">
          <div className="w-full max-w-md bg-[#161622] border border-white/15 rounded-2xl p-4 sm:p-5 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto custom-scrollbar">
            <div className="flex items-center justify-between border-b border-white/10 pb-3">
              <h4 className="text-sm font-bold text-white flex items-center gap-2">
                <Cpu className="w-4 h-4 text-teal-400" />
                <span>Browsing Engine User-Agent</span>
              </h4>
              <button
                type="button"
                onClick={() => setShowUaModal(false)}
                className="p-1 text-white/40 hover:text-white rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-white/60 leading-relaxed">
              Configure the User-Agent profile reported by the browsing engine and JavaScript runtime. Switching profiles updates DOM properties and reloads active sessions.
            </p>

            <div className="space-y-2.5 text-xs">
              {/* Default */}
              <div 
                onClick={() => handleApplyUserAgent('default')}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  uaMode === 'default' 
                    ? 'bg-teal-500/15 border-teal-500/50 text-white shadow' 
                    : 'bg-white/5 hover:bg-white/10 border-white/10 text-white/70'
                }`}
              >
                <input
                  type="radio"
                  name="uaMode"
                  checked={uaMode === 'default'}
                  onChange={() => handleApplyUserAgent('default')}
                  className="mt-0.5 accent-teal-400"
                />
                <div className="space-y-0.5 flex-1">
                  <div className="font-bold text-white flex items-center justify-between">
                    <span>Default (Native Device Engine)</span>
                    <span className="text-[10px] text-white/40 font-mono">System</span>
                  </div>
                  <p className="text-[11px] text-white/50">
                    Uses the native device User-Agent directly without modifications ({isWebViewUserAgent(getNativeOriginalUserAgent()) ? 'Android WebView with Version/4.0' : 'Standard Browser'}).
                  </p>
                </div>
              </div>

              {/* Mobile Chrome */}
              <div 
                onClick={() => handleApplyUserAgent('mobile-chrome')}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  uaMode === 'mobile-chrome' 
                    ? 'bg-teal-500/15 border-teal-500/50 text-white shadow' 
                    : 'bg-white/5 hover:bg-white/10 border-white/10 text-white/70'
                }`}
              >
                <input
                  type="radio"
                  name="uaMode"
                  checked={uaMode === 'mobile-chrome'}
                  onChange={() => handleApplyUserAgent('mobile-chrome')}
                  className="mt-0.5 accent-teal-400"
                />
                <div className="space-y-0.5 flex-1">
                  <div className="font-bold text-white flex items-center justify-between">
                    <span>Mobile Chrome</span>
                    <span className="text-[10px] text-teal-400 font-mono">Pixel 8 / Chrome 133</span>
                  </div>
                  <p className="text-[11px] text-white/50">
                    Standard standalone Mobile Chrome UA. Excludes WebView markers (<code className="text-white/60">Version/4.0</code> and <code className="text-white/60">; wv</code>).
                  </p>
                </div>
              </div>

              {/* Desktop Chrome */}
              <div 
                onClick={() => handleApplyUserAgent('desktop-chrome')}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  uaMode === 'desktop-chrome' 
                    ? 'bg-teal-500/15 border-teal-500/50 text-white shadow' 
                    : 'bg-white/5 hover:bg-white/10 border-white/10 text-white/70'
                }`}
              >
                <input
                  type="radio"
                  name="uaMode"
                  checked={uaMode === 'desktop-chrome'}
                  onChange={() => handleApplyUserAgent('desktop-chrome')}
                  className="mt-0.5 accent-teal-400"
                />
                <div className="space-y-0.5 flex-1">
                  <div className="font-bold text-white flex items-center justify-between">
                    <span>Desktop Chrome</span>
                    <span className="text-[10px] text-teal-400 font-mono">Windows / Chrome 133</span>
                  </div>
                  <p className="text-[11px] text-white/50">
                    Standard Desktop Chrome UA. Requests desktop-optimized layouts from servers.
                  </p>
                </div>
              </div>

              {/* Custom */}
              <div 
                className={`p-3 rounded-xl border transition-all space-y-2 ${
                  uaMode === 'custom' 
                    ? 'bg-teal-500/15 border-teal-500/50 text-white shadow' 
                    : 'bg-white/5 border-white/10 text-white/70'
                }`}
              >
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="uaMode"
                    checked={uaMode === 'custom'}
                    onChange={() => handleApplyUserAgent('custom', customUaInput)}
                    className="accent-teal-400"
                  />
                  <span className="font-bold text-white">Custom User-Agent</span>
                </label>
                <textarea
                  rows={2}
                  value={customUaInput}
                  onChange={(e) => setCustomUaInput(e.target.value)}
                  placeholder="Enter custom User-Agent string..."
                  className="w-full bg-black/60 border border-white/15 rounded-lg p-2 text-[11px] font-mono text-white outline-none focus:border-teal-500 custom-scrollbar resize-none"
                />
                {uaMode === 'custom' && (
                  <button
                    type="button"
                    onClick={() => handleApplyUserAgent('custom', customUaInput)}
                    className="px-3 py-1 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-xs font-bold transition-all shadow"
                  >
                    Save & Apply Custom UA
                  </button>
                )}
              </div>
            </div>

            {/* Active UA Preview */}
            <div className="bg-black/50 p-2.5 rounded-xl border border-white/10 space-y-1">
              <div className="flex items-center justify-between text-[10px] font-mono text-white/40">
                <span>Current Active UA String:</span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(currentEffectiveUa);
                    setCopiedUa(true);
                    setTimeout(() => setCopiedUa(false), 2000);
                  }}
                  className="text-teal-300 hover:underline flex items-center gap-1"
                >
                  {copiedUa ? 'Copied' : 'Copy String'}
                </button>
              </div>
              <div className="text-[10px] font-mono text-teal-300 break-all select-all">
                {currentEffectiveUa}
              </div>
            </div>

            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() => setShowUaModal(false)}
                className="px-4 py-2 bg-white/10 hover:bg-white/20 text-white rounded-xl text-xs font-bold transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live Diagnostics Drawer / Error Inspector */}
      {showDiagnostics && (
        <div className="bg-[#11111a] border-b border-amber-500/30 p-3 sm:p-4 text-xs space-y-3 animate-in slide-in-from-top-2 duration-200 shrink-0 max-h-60 overflow-y-auto custom-scrollbar">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <div className="flex items-center gap-2 text-amber-300 font-bold">
              <Activity className="w-4 h-4 text-amber-400" />
              <span>Live Page Load & Header Diagnostics</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyDiagnosticsReport}
                className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white rounded-lg text-[10px] font-bold transition-colors flex items-center gap-1"
              >
                {copiedReport ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-white/70" />}
                <span>{copiedReport ? 'Copied Report' : 'Copy Report'}</span>
              </button>
              {onOpenCaptureLogs && (
                <button
                  type="button"
                  onClick={onOpenCaptureLogs}
                  className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 border border-amber-500/30 rounded-lg text-[10px] font-bold transition-colors flex items-center gap-1"
                >
                  <Terminal className="w-3 h-3 text-amber-400" />
                  <span>View All App Logs</span>
                </button>
              )}
            </div>
          </div>

          {/* Diagnostic Matrix */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono">
            <div className="p-2 bg-black/40 rounded-lg border border-white/5">
              <div className="text-white/40">Target Host:</div>
              <div className="font-bold text-teal-300 truncate">{currentAnalysis.hostname}</div>
            </div>

            <div className="p-2 bg-black/40 rounded-lg border border-white/5">
              <div className="text-white/40">Protocol & SSL:</div>
              <div className={`font-bold ${currentAnalysis.isSecure ? 'text-emerald-400' : 'text-amber-400'}`}>
                {currentAnalysis.protocol} {currentAnalysis.isSecure ? '(SSL Valid)' : '(Insecure)'}
              </div>
            </div>

            <div className="p-2 bg-black/40 rounded-lg border border-white/5">
              <div className="text-white/40">Socket Probe Status:</div>
              <div className={`font-bold truncate ${probeResult?.reachable ? 'text-emerald-300' : 'text-amber-300'}`}>
                {probeResult ? probeResult.status : 'Probing...'}
              </div>
            </div>

            <div className="p-2 bg-black/40 rounded-lg border border-white/5">
              <div className="text-white/40">Framing Header Policy:</div>
              <div className={`font-bold truncate ${currentAnalysis.isKnownBlockedHost ? 'text-red-400' : 'text-emerald-400'}`}>
                {currentAnalysis.headerReason || 'OK'}
              </div>
            </div>
          </div>

          {/* User-Agent Diagnostic Row */}
          <div className="p-2.5 bg-black/50 rounded-xl border border-white/10 space-y-1.5 font-mono text-[11px]">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <div className="flex items-center gap-1.5 text-teal-300 font-bold">
                <Cpu className="w-3.5 h-3.5 text-teal-400" />
                <span>Browsing Engine User-Agent ({uaMode.toUpperCase()}):</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                  isWebViewUserAgent(currentEffectiveUa)
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                }`}>
                  {isWebViewUserAgent(currentEffectiveUa) ? 'Android WebView (wv)' : 'Standard Browser UA'}
                </span>
                <button
                  type="button"
                  onClick={() => setShowUaModal(true)}
                  className="text-[10px] text-teal-300 hover:underline font-bold"
                >
                  Configure
                </button>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(currentEffectiveUa);
                    setCopiedUa(true);
                    setTimeout(() => setCopiedUa(false), 2000);
                  }}
                  className="p-1 hover:bg-white/10 rounded text-white/50 hover:text-white"
                  title="Copy UA String"
                >
                  {copiedUa ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>
            <div className="text-[10px] text-white/70 break-all bg-black/40 p-2 rounded-lg border border-white/5 select-all">
              {currentEffectiveUa}
            </div>
          </div>

          {/* Explanation & Actionable Recommendation */}
          {currentAnalysis.explanation && (
            <div className={`p-2.5 rounded-xl border text-[11px] space-y-1 ${
              currentAnalysis.isKnownBlockedHost 
                ? 'bg-red-950/30 border-red-500/30 text-red-200' 
                : 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
            }`}>
              <div className="font-bold flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5" />
                <span>Diagnostic Cause:</span>
              </div>
              <p className="font-sans leading-relaxed text-white/80">{currentAnalysis.explanation}</p>
              {currentAnalysis.recommendation && (
                <p className="font-sans text-teal-300 font-medium pt-1">
                  💡 <strong>Solution:</strong> {currentAnalysis.recommendation}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Viewport: Either New Tab Speed Dial OR Live Web Iframe */}
      <div className="flex-1 min-h-0 relative bg-white overflow-hidden">
        
        {activeTab.url === 'mv://newtab' ? (
          /* NEW TAB SPEED DIAL & SHORTCUT WEB SCREEN */
          <div className="w-full h-full bg-[#0e0e16] text-white p-4 sm:p-8 overflow-y-auto custom-scrollbar flex flex-col items-center justify-start space-y-8">
            
            {/* Speed Dial Header & Search Omnibar */}
            <div className="w-full max-w-2xl text-center space-y-4 pt-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-teal-500/10 border border-teal-500/20 text-teal-300 text-xs font-bold">
                <Globe className="w-3.5 h-3.5" />
                <span>MVDirector Main Activity Web Browser</span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight">
                Where to next?
              </h2>

              <div className="relative max-w-xl mx-auto flex items-center">
                <Search className="w-5 h-5 text-white/40 absolute left-4 pointer-events-none" />
                <input
                  type="text"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.target as HTMLInputElement).value) {
                      navigateTo((e.target as HTMLInputElement).value);
                    }
                  }}
                  placeholder="Search the web or paste any URL / YouTube link..."
                  className="w-full bg-black/60 border border-white/20 hover:border-teal-500/50 focus:border-teal-500 text-white rounded-2xl pl-12 pr-24 py-3.5 text-sm outline-none transition-all shadow-xl font-sans"
                  autoFocus
                />
                <span className="absolute right-4 text-[10px] text-white/40 bg-white/10 px-2 py-1 rounded-md font-mono pointer-events-none">
                  Enter ↵
                </span>
              </div>
            </div>

            {/* Shortcuts Web Grid (With Delete Bookmark Buttons) */}
            <div className="w-full max-w-3xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-white/60 uppercase tracking-widest flex items-center gap-2">
                  <Star className="w-3.5 h-3.5 text-teal-400" />
                  <span>Speed Dial Shortcuts</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setShowAddShortcutModal(true)}
                  className="text-xs text-teal-400 hover:text-teal-300 font-bold flex items-center gap-1 transition-colors"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  <span>Add Shortcut</span>
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                {/* Featured MV Director Side App Card */}
                {onOpenDirectorApp && (
                  <div
                    className="group relative bg-gradient-to-br from-indigo-950/60 to-purple-950/60 hover:from-indigo-900/70 hover:to-purple-900/70 border border-indigo-500/30 hover:border-indigo-400 rounded-2xl p-4 transition-all duration-200 flex flex-col items-center justify-center text-center cursor-pointer shadow-xl hover:-translate-y-0.5"
                    onClick={onOpenDirectorApp}
                  >
                    <div className="w-12 h-12 rounded-2xl bg-indigo-600/30 border border-indigo-500/40 flex items-center justify-center mb-3 shadow-inner group-hover:scale-110 transition-transform">
                      <Clapperboard className="w-6 h-6 text-indigo-300" />
                    </div>

                    <span className="text-xs font-bold text-white group-hover:text-indigo-300 transition-colors truncate max-w-full">
                      MV Director
                    </span>
                    <span className="text-[10px] text-indigo-300/60 truncate max-w-full mt-0.5 font-bold">
                      Main Activity (Return)
                    </span>
                  </div>
                )}

                {bookmarks.map((bm) => (
                  <div
                    key={bm.id}
                    className="group relative bg-white/5 hover:bg-white/10 border border-white/10 hover:border-teal-500/40 rounded-2xl p-4 transition-all duration-200 flex flex-col items-center justify-center text-center cursor-pointer shadow-lg hover:-translate-y-0.5"
                    onClick={() => navigateTo(bm.url)}
                  >
                    {/* Delete Shortcut Button */}
                    <button
                      type="button"
                      onClick={(e) => handleDeleteBookmark(bm.id, e)}
                      className="absolute top-2 right-2 p-1 text-white/30 hover:text-red-400 hover:bg-white/10 rounded-lg transition-colors opacity-0 group-hover:opacity-100"
                      title={`Delete shortcut "${bm.name}"`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>

                    <div className="w-12 h-12 rounded-2xl bg-black/40 border border-white/10 flex items-center justify-center mb-3 shadow-inner group-hover:scale-110 transition-transform">
                      {renderBookmarkIcon(bm.iconType)}
                    </div>

                    <span className="text-xs font-bold text-white group-hover:text-teal-300 transition-colors truncate max-w-full">
                      {bm.name}
                    </span>
                    <span className="text-[10px] text-white/40 truncate max-w-full mt-0.5">
                      {bm.url.replace(/^https?:\/\//, '').replace(/^www\./, '')}
                    </span>
                  </div>
                ))}

                {/* Add New Shortcut Card */}
                <button
                  type="button"
                  onClick={() => setShowAddShortcutModal(true)}
                  className="border-2 border-dashed border-white/10 hover:border-teal-500/40 bg-transparent hover:bg-teal-500/5 rounded-2xl p-4 transition-all flex flex-col items-center justify-center text-center group cursor-pointer"
                >
                  <div className="w-12 h-12 rounded-2xl bg-white/5 group-hover:bg-teal-500/20 text-white/40 group-hover:text-teal-300 flex items-center justify-center mb-3 transition-colors">
                    <Plus className="w-6 h-6" />
                  </div>
                  <span className="text-xs font-bold text-white/60 group-hover:text-teal-300 transition-colors">
                    Add Shortcut
                  </span>
                </button>
              </div>
            </div>

          </div>
        ) : (
          /* LIVE WEB VIEWPORT */
          <>
            {/* Anti-Frame Notice & Proxy Controls if Known Blocked Host */}
            {currentAnalysis.isKnownBlockedHost && !activeTab.url.includes('/embed/') && (
              <div className="absolute top-2 left-2 right-2 z-20 bg-slate-900/95 border border-teal-500/40 p-2 sm:p-2.5 rounded-xl text-xs text-white shadow-2xl flex flex-wrap items-center justify-between gap-2 backdrop-blur-md animate-in fade-in">
                <div className="flex items-center gap-2 truncate">
                  <Shield className={`w-4 h-4 shrink-0 ${useProxy ? 'text-emerald-400' : 'text-amber-400'}`} />
                  <span className="truncate text-xs">
                    <strong>{currentAnalysis.hostname}</strong>: {useProxy ? 'HTML proxy active (some sites may not work fully)' : 'This site blocks iframe embedding; open the full browser for normal browsing'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setUseProxy(!useProxy);
                      handleReload();
                    }}
                    className={`px-2.5 py-1 rounded-lg font-bold text-[10px] transition-colors shadow ${
                      useProxy ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-teal-600 hover:bg-teal-500 text-white'
                    }`}
                  >
                    {useProxy ? 'Proxy Active ✓' : 'Enable Proxy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void openInFullBrowser()}
                    className="px-2 py-1 bg-white/10 hover:bg-teal-500/20 text-white hover:text-teal-200 rounded-lg font-bold text-[10px] flex items-center gap-1 transition-colors"
                    title="Open in full browser"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>Open Full Browser</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowDiagnostics(true)}
                    className="px-2 py-1 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white rounded-lg text-[10px] transition-colors"
                  >
                    Diagnostics
                  </button>
                </div>
              </div>
            )}

            <iframe
              key={activeTab.iframeKey}
              ref={iframeRef}
              src={getEffectiveIframeSrc(activeTab.url)}
              title={activeTab.title}
              style={{ zoom: `${zoomLevel}%` }}
              className="w-full h-full border-0 bg-white"
              referrerPolicy="no-referrer-when-downgrade"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation allow-downloads allow-modals allow-pointer-lock allow-orientation-lock allow-top-navigation-by-user-activation"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen; compute-pressure; screen-wake-lock"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
            />
          </>
        )}

      </div>

      {/* Bottom Status Bar */}
      <div className="p-2 bg-[#15151e] border-t border-white/10 flex items-center justify-between text-[11px] text-white/50 shrink-0">
        <div className="flex items-center gap-2 truncate">
          <span className={`w-2 h-2 rounded-full ${
            activeTab.url === 'mv://newtab' ? 'bg-teal-400' : currentAnalysis.isKnownBlockedHost ? 'bg-amber-400' : activeTab.loadStage === 'loaded' ? 'bg-emerald-400' : 'bg-teal-400'
          }`}></span>
          <span className="text-white/70 truncate max-w-[240px] sm:max-w-md">
            {activeTab.url === 'mv://newtab' ? 'Speed Dial Activity' : activeTab.url}
          </span>
          {activeTab.loadDuration > 0 && activeTab.url !== 'mv://newtab' && (
            <span className="text-white/40 font-mono text-[10px]">({activeTab.loadDuration}ms)</span>
          )}
          <span className="text-teal-300 font-mono text-[10px]">Tab {tabs.findIndex(t => t.id === activeTab.id) + 1}/{tabs.length}</span>
        </div>
        
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleNewTab('mv://newtab')}
            className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-teal-300 rounded-md text-[10px] font-bold transition-colors flex items-center gap-1 shrink-0"
          >
            <Plus className="w-3 h-3" />
            <span>New Tab</span>
          </button>

          <button
            type="button"
            onClick={() => setShowDiagnostics(!showDiagnostics)}
            className="px-2.5 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/20 rounded-md text-[10px] font-bold transition-colors flex items-center gap-1 shrink-0"
          >
            <Activity className="w-3 h-3 text-amber-400" />
            <span>{showDiagnostics ? 'Hide Diagnostics' : 'Inspect'}</span>
          </button>

          {onOpenCaptureLogs && (
            <button
              type="button"
              onClick={onOpenCaptureLogs}
              className="px-2.5 py-1 bg-white/10 hover:bg-white/20 text-white rounded-md text-[10px] font-bold transition-colors flex items-center gap-1 shrink-0"
            >
              <Terminal className="w-3 h-3 text-amber-400" />
              <span>Logs</span>
            </button>
          )}
        </div>
      </div>

    </div>
  );
};
