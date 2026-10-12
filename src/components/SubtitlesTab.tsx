import React, { useState, useRef, useEffect } from 'react';
import { 
    Subtitles, Youtube, ChevronDown, Sparkles, AlertCircle, FileText, Download, Play, Pause, 
    Video, FileAudio, Upload, Layers, Globe, Languages, Link, Check, RefreshCw, Info, ListFilter, 
    ExternalLink
} from 'lucide-react';
import ReactPlayer from 'react-player';
const Player = ReactPlayer as any;
import { generateSRT } from '../services/gemini_srt';
import { SubtitleTimelineEditor } from './SubtitleTimelineEditor';
import { YouTubeSubtitleTimelineEditor } from './YouTubeSubtitleTimelineEditor';
import { ExportModal } from './ExportModal';
import { SubtitleFormatDropdown } from './SubtitleFormatDropdown';
import { YouTubeStreamLinksSelector } from './YouTubeStreamLinksSelector';
import { SubtitleType } from '../types';
import { parseSubtitles, generateSrt as generateSrtString, splitOversizedBlocks } from '../utils/subtitleParser';
import { get, set, del } from 'idb-keyval';
import { 
    normalizeYoutubeUrl, 
    downloadYouTubeMediaStream, 
    extractYouTubeMediaDetails, 
    fetchYouTubeCaptions,
    ExtractedMediaDetails, 
    YouTubeQualityOption, 
    DownloadStreamProgress 
} from '../services/youtube';