/**
 * Diagnostic User-Agent Configuration & Engine Override Service
 * 
 * Provides runtime inspection and configuration for the in-app browsing engine:
 * - Default: Native browser / Android WebView UA
 * - Mobile Chrome: Standard Mobile Chrome on Android without WebView tokens
 * - Desktop Chrome: Standard Desktop Chrome on Windows/Linux
 * - Custom: User-defined UA string
 * 
 * Persists user choice in localStorage and applies prototype overrides so scripts
 * and DOM inquiries see the selected profile.
 */

export type UserAgentMode = 'default' | 'mobile-chrome' | 'desktop-chrome' | 'custom';

export interface UserAgentProfile {
  mode: UserAgentMode;
  name: string;
  uaString: string;
  description: string;
  isWebView: boolean;
}

export const PRESET_MOBILE_CHROME_UA = 
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Mobile Safari/537.36';

export const PRESET_DESKTOP_CHROME_UA = 
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

const STORAGE_MODE_KEY = 'mv_browser_ua_mode_v1';
const STORAGE_CUSTOM_KEY = 'mv_browser_custom_ua_v1';

// Capture pristine native User-Agent on module initialization
let nativeOriginalUA = typeof navigator !== 'undefined' ? navigator.userAgent : 'NodeJS/Environment';

export function getNativeOriginalUserAgent(): string {
  return nativeOriginalUA;
}

export function getUserAgentMode(): UserAgentMode {
  if (typeof localStorage === 'undefined') return 'default';
  try {
    const saved = localStorage.getItem(STORAGE_MODE_KEY) as UserAgentMode;
    if (saved === 'default' || saved === 'mobile-chrome' || saved === 'desktop-chrome' || saved === 'custom') {
      return saved;
    }
  } catch {}
  return 'default';
}

export function getCustomUserAgentString(): string {
  if (typeof localStorage === 'undefined') return PRESET_MOBILE_CHROME_UA;
  try {
    const saved = localStorage.getItem(STORAGE_CUSTOM_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch {}
  return PRESET_MOBILE_CHROME_UA;
}

export function getEffectiveUserAgent(): string {
  const mode = getUserAgentMode();
  switch (mode) {
    case 'mobile-chrome':
      return PRESET_MOBILE_CHROME_UA;
    case 'desktop-chrome':
      return PRESET_DESKTOP_CHROME_UA;
    case 'custom':
      return getCustomUserAgentString();
    case 'default':
    default:
      return nativeOriginalUA;
  }
}

export function isWebViewUserAgent(ua: string): boolean {
  if (!ua) return false;
  // Android WebViews include '; wv' or 'Version/4.0' or 'Version/X.X Chrome/'
  return /; wv\b/i.test(ua) || /\bVersion\/[0-9.]+\s+Chrome\//i.test(ua);
}

export function isMobileUserAgent(ua: string): boolean {
  if (!ua) return false;
  return /Android|Mobile|iPhone|iPad|iPod/i.test(ua);
}

export function setUserAgentSettings(mode: UserAgentMode, customString?: string): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_MODE_KEY, mode);
      if (customString !== undefined) {
        localStorage.setItem(STORAGE_CUSTOM_KEY, customString);
      }
    } catch {}
  }

  // Apply override to navigator
  applyUserAgentOverride();

  // Notify active browser components
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('mv:useragent-changed', {
      detail: {
        mode,
        effectiveUA: getEffectiveUserAgent()
      }
    }));
  }
}

/**
 * Applies the User-Agent override directly to the browser runtime's navigator object.
 * Affects scripts and feature detection querying navigator.userAgent / navigator.appVersion.
 */
export function applyUserAgentOverride(): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;

  const effective = getEffectiveUserAgent();
  const isDefault = getUserAgentMode() === 'default';

  try {
    const navProto = Object.getPrototypeOf(navigator) || navigator;

    // Override navigator.userAgent
    Object.defineProperty(navProto, 'userAgent', {
      get: () => (isDefault ? nativeOriginalUA : effective),
      configurable: true,
      enumerable: true
    });

    // Override navigator.appVersion
    Object.defineProperty(navProto, 'appVersion', {
      get: () => (isDefault ? nativeOriginalUA : effective),
      configurable: true,
      enumerable: true
    });

    // Override navigator.platform if switching between desktop and mobile
    const isDesktop = getUserAgentMode() === 'desktop-chrome';
    if (isDesktop) {
      Object.defineProperty(navProto, 'platform', {
        get: () => 'Win32',
        configurable: true,
        enumerable: true
      });
      Object.defineProperty(navProto, 'maxTouchPoints', {
        get: () => 0,
        configurable: true,
        enumerable: true
      });
    }
  } catch (err) {
    console.warn('[UA Service] Could not override navigator properties:', err);
  }
}
