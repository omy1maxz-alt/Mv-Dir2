/**
 * Utility functions for capturing screen, video frames, and clipboard images
 * for AI Vision analysis and subtitle translation.
 */

export const isDisplayMediaSupported = (): boolean => {
    return (
        typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function'
    );
};

/**
 * Captures a single frame from the user's screen, active tab, or window
 * using the Screen Capture API (getDisplayMedia).
 * Immediately stops all media stream tracks upon capture to avoid persistent capture indicators.
 */
export const captureScreenFrame = async (): Promise<string> => {
    if (!isDisplayMediaSupported()) {
        throw new Error('Screen capture is not supported in this browser. Please use Screenshot Upload or Paste.');
    }

    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;

    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                // @ts-ignore - displaySurface hint supported by Chromium
                displaySurface: 'browser'
            },
            audio: false
        });

        const videoTrack = stream.getVideoTracks()[0];
        if (!videoTrack) {
            throw new Error('No video track available from screen capture.');
        }

        video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;

        await video.play();

        // Give the video pipeline a moment to render a valid decoded frame
        await new Promise((resolve) => setTimeout(resolve, 350));

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('Could not create 2D canvas context.');
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);

        // Return raw base64 without prefix
        return dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
    } finally {
        if (stream) {
            stream.getTracks().forEach((track) => track.stop());
        }
        if (video) {
            video.srcObject = null;
            video.remove();
        }
    }
};

/**
 * Captures the current visible frame from an HTMLVideoElement onto a canvas.
 */
export const captureVideoElementFrame = (video: HTMLVideoElement): string | null => {
    try {
        if (!video || video.readyState < 2) return null;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 1280;
        canvas.height = video.videoHeight || 720;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
        return dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
    } catch (e) {
        console.error('Failed to capture video element frame:', e);
        return null;
    }
};

/**
 * Reads an image File into raw base64 string.
 */
export const readImageFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.replace(/^data:image\/[a-z]+;base64,/, '');
            resolve(base64);
        };
        reader.onerror = () => reject(new Error('Failed to read image file.'));
        reader.readAsDataURL(file);
    });
};
