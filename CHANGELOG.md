## [Unreleased]

### Fixed
- **Max Generator primary-video playback and stale soundtrack preview**: Keep an uploaded video as one primary HTML video source (picture and embedded audio together) in the timeline editor. The View Media companion is only rendered for an audio-only primary source, so an old reference can no longer replace the uploaded video or make it appear as a separate soundtrack player. Timeline-selected media takes precedence over stale source props, while preserving the Max Generator label and Local/YouTube workflow separation.

## [1.1.12] - 2026-08-16
### Fixed
- **Mobile Timeline Drag:** Drastically improved drag smoothness for subtitle blocks and the timeline track by enforcing `touch-action: none`. This prevents mobile browsers from interrupting drags with accidental page swipes or scrolls.
- **Timeline Timecode:** Added an exact timecode display directly above the static red center playhead, matching the CapCut behavior. As you scrub the timeline, you can now see precisely what millisecond the playhead is on.

## [1.1.11] - 2026-08-16
### Fixed
- **Mobile Touch Handling:** Increased the touch target size of the subtitle trim handles to make them much easier to grab on phones.
- **Timeline Preview Sync:** Fixed a critical bug where dragging a subtitle block would update the video preview but desync it from the fixed center playhead. The playhead and preview video now remain correctly synced while you visually move blocks underneath them.
- **Music Player Drag:** Added `touch-action: none` to the soundtrack player drag handle to ensure smooth dragging on mobile browsers without triggering page scrolls.

## [1.1.10] - 2026-08-16
### Fixed
- **Music Player Drag:** Fixed the floating soundtrack player so that only the top header acts as a drag handle. You can now click and interact with the player without accidentally dragging it around the screen.

## [1.1.9] - 2026-07-17
### Fixed
- **CapCut Timeline UI:** Completely redesigned the Subtitle Timeline. The playhead is now fixed in the center, and the entire timeline track slides beneath it when playing or scrubbing. This makes adjusting subtitles by dragging blocks significantly more intuitive.
- **Timeline Fix:** Fixed a major bug where the Subtitle Timeline player wouldn't play due to an internal rendering loop.
- **Session Memory:** The Subtitle Editor now safely auto-saves your imported media and generated subtitles so you don't lose progress when refreshing the page.
- **Studio Chat Persistence:** Migrated Studio Chat history from `localStorage` to `IndexedDB` to prevent the chat from resetting on page refresh when the history contains large image attachments that exceed browser quota limits.
- **Bug Fix:** Fixed an issue where the image generation model would sometimes return a blank text string instead of an image due to a missing modality flag.
- **Bug Fix:** Resolved a critical app crash ("Maximum call stack size exceeded") caused by an infinite recursion loop in the new custom AI model adapter.
- **SRT Subtitle Generation Fix:** Overhauled the auto-subtitle generator to prevent AI timestamp errors (e.g. mixing up MM:SS with HH:MM:SS) and improved translation prompts for more natural, idiomatic captions.
- **API Key Fix:** Resolved an internal bug in the Prompt Generator tab where custom Gemini API keys were occasionally reverting to the fallback key.
- **SRT Format Fix:** Enforced strict timestamp formatting for subtitles (HH:MM:SS,mmm). Added a post-processing filter that automatically corrects unpadded hours and replaces periods with commas to ensure maximum compatibility with video editors and players.

### Added
- **Timeline Scrolling & Scale Fixed:** The timeline editor now allows scrolling on mobile screens again, ensuring you can reach all parts of the app.
- **Accurate Subtitle Scaling:** When zooming out, subtitle blocks now shrink accurately to match the zoom level instead of forcing a fake width, which fixes the overlapping issue.
- **Universal Milliseconds:** All timers, timestamps, and drag tooltips now strictly show precise milliseconds (e.g., `00:01.50`) for complete frame clarity.
- **Ruler Anti-Overlap:** Greatly improved the spacing on the time ruler. Numbers are perfectly centered on their tick lines and spaced widely to never overlap again.
- **Full-Screen Timeline Editor:** The timeline editor now automatically hides the "SRT Subtitle Crafter" headers and output boxes when you switch into it, giving you the entire screen to focus solely on trimming and editing your video.
- **Ultra-Smooth Mobile Timeline Editing:** The timeline drag-and-drop has been completely rewritten from the ground up for mobile! Dragging handles is now silky smooth with 60fps performance and absolutely zero lag.
- **Forgiving Drag Handles:** The invisible grab area around the left and right subtitle edges is now 300% wider. It will instantly lock onto your finger even if you miss the line slightly, making it so much easier to trim videos on a phone screen!
- **Smoother Timeline Dragging:** Fixed an issue on touchscreens where dragging the edges of a subtitle block would sometimes cancel or "let go" (lepas) unexpectedly. It will now firmly lock onto your finger until you let go!
- **Professional Zoom Levels:** Zooming out (the "-" button) now shows exactly 30 seconds of your video on screen at once to help you see the big picture. Zooming in (the "+" button) brings you all the way down to seeing just 0.5 seconds of time for frame-perfect subtitle alignment!
- **Dynamic Time Ruler:** The numbers on the timeline ruler now automatically adjust. If you zoom out, they space out cleanly; if you zoom in, they break down into milliseconds (e.g., 00:03.50) without overlapping.
- **Accurate Timestamps:** The dragging tooltips and time ruler now show two decimal places for milliseconds, making precise edits much easier.
- **Bug Fix:** Fixed an internal React state warning that could occur when dragging and dropping subtitle blocks.
- **Persistent Subtitles:** Fixed a bug where editing the timeline wouldn't save on reload. Subtitle edits now permanently save instantly!
- **Mobile Toolbar Fixed:** The bottom floating action bar (Split, Dup, Delete) has been restructured so no buttons are cut off on small phone screens.
- **Easy Zoom Controls:** Added +/- zoom buttons to the middle toolbar, allowing you to easily zoom in to see specific seconds or zoom out to see the whole video.
- **Live Dragging Timecodes:** When you drag a subtitle handle to stretch or shrink it, you will now see the exact timecode floating above your finger so you know exactly where it's snapping.
- **Mobile Touch Support:** Subtitle blocks can now be easily dragged and resized on mobile devices.
- **Thick Trimming Handles:** When you tap a subtitle block, it now highlights with large, easy-to-grab handles on the left and right edges (just like CapCut) so you can effortlessly stretch or shrink the caption's duration.
- **Interactive Subtitle Editor:** Added a robust new timeline editor for captions! Switch between the AI Generator and Timeline Editor in the Subtitles tab. You can now import .srt/.vtt files, drag blocks on a horizontal timeline, trim edges, edit text inline, and export your polished subtitles.
- **Nano Banana Prompting:** Replaced generic buzzwords in prompt generation with specific physical and cinematic descriptor guidelines.
- **Image Replace Function:** Added a "Replace Image" button to the Reference Editor Modal to easily swap out reference images without deleting and re-creating them.
- **Custom OpenAI Provider Integration:** Added support for external OpenAI-compatible APIs (like those from awesome-freellm-apis). You can now configure a custom Base URL, API Key, and Model in the API Settings Vault to power all text, chat, and director features instead of using Gemini.
- **Studio Chat Updates:** Added the ability to edit or delete any individual message (both user and AI). You can now edit messages "in-place" without triggering a resend, or choose "Save & Resend" to fork the conversation.
- **Scene Card Interactions:** Added a subtle scale and glow hover animation to Scene Cards, improving the visual feedback and tactile feel when browsing the storyboard.
- **Visual Reference Toggle:** Added an eye icon toggle to visual reference cards. You can now temporarily disable specific reference images from being used by the AI generator without deleting them.
- **Core Operating Protocol (Stop Slop):** Injected a new advanced meta-prompt into the Studio Chat Assistant's brain. The Assistant is now explicitly banned from using generic AI filler phrases ("let's dive in"), and runs a silent "Task Observer" to ensure its advice strictly aligns with your current project state and goals without drifting.
- **Master Chat Log Entry:** Saved the 'Core Operating Protocol' prompt template to your Chat Logs so you can easily reference its UI/UX Pro Max and Memory rules for your own AI Studio configurations.
- **Multi-Perspective Review Protocol:** Upgraded the AI Director's cognitive framework. It now internally convenes a panel of experts (Continuity Director, Composition Critic, Prompt Engineer) to silently cross-examine and refine storyboard scenes before outputting them, drastically reducing continuity errors and repetitive prompts.
- **Master Chat Log Entry:** Saved the 'Multi-Perspective Review Protocol' prompt template to your Chat Logs so you can easily copy and reuse it in Google AI Studio for other creative tasks.
- **Batch Edit Tool:** Added a new "Batch Edit" tool in the Lab tab. You can now import multiple local images (drag & drop or via file picker) and apply a single text instruction to automatically edit all of them in bulk using Gemini 3.1 Flash Image.
- **API Reliability:** Added automatic retries for transient "Permission Denied (403)" errors when the app first loads, which prevents generation tasks from failing abruptly on their first attempt.
- **Master Art Style Selection:** Added a "Set as Master Art Style" checkbox on Visual References. When checked, the image generation engines will explicitly use that reference to completely override and guide the final image's aesthetic, rendering technique, color palette, and tone.
- Added a "MASTER ART" indicator to Visual Reference cards in the Project Dashboard.

## [1.1.10] - 2026-07-17
### Added
- **AI Agent Autonomy Expansion:** The AI Director in the Studio Chat can now fully see and edit your project data. It reads your current Director Plan, allows you to add characters directly via chat, and can edit image prompts for specific storyboard scenes.

## [1.1.11] - 2026-07-18
### Added
- **Enhanced Swap Char:** Added an aspect ratio selector to the Swap Char tool. Fixed an issue where the swapped character's head proportions or lighting would become unnatural by refining the backend prompt to strictly preserve the body proportions, head size, and lighting of the original Frame Reference.
- **Image Extension (Outpainting) via Lab Tab:** Added a new "Extend Image" tab in the Lab that allows users to upload an image and outpaint it into a new aspect ratio (16:9, 9:16, 1:1) while preserving the original subject matter, using Gemini 3.1 Flash Image's capabilities.

## [Latest]
- **Lab Character Swap Fix:** Removed the internal `gemini-3.5-flash` auto-description step from the Multi-Swap tool. The highly detailed auto-description of the original frame was creating a strong text anchor that overpowered the `[Character Reference]` tag. By removing the text description, Imagen 3 now natively prioritizes the Character Reference for the subject's identity, resulting in a perfect character swap without regenerating the original image.
- **Cinematic Story Mode:** Gemini has been sent to film school! The AI Director now uses real music video editing theory—understanding A-Roll vs B-Roll, visual pacing, metaphor over literal interpretation, and matching camera framing to the emotional arc of the song.
- **Research Prompt for Gemini:** Added a specialized prompt to the Chat Logs that you can use to extract professional music video editing rules from Gemini Advanced. You can bring the results back to inject them into the AI Director's brain!
- **Algorithmic Cinematography Engine:** The AI Director has received a massive brain upgrade! It now plans your storyboards using professional heuristics for Average Shot Lengths (ASL), focal lengths (telephoto vs wide-angle), frame rates (24fps up to 120fps slow-motion), and advanced visual metaphors. Generative prompts are now indistinguishable from professional Hollywood shot lists.
- **Google AI Studio Research Prompt:** Added a specialized prompt to the Chat Logs that allows you to research the perfect Temperature, Top-K, and Safety Settings configurations for a custom Music Video Director model in AI Studio.
- **Optimized Generative Parameters:** Tuned the AI Director's internal model settings (Temperature to 0.45, Top-K to 40, Top-P to 0.85). This drastically improves its ability to output stable, highly creative cinematic storyboards without breaking its structural formatting.
- **SRT Subtitle Crafter:** Added a dedicated 'Captions' tab! You can now upload audio or video files and generate perfectly formatted .srt files. Choose between original language, dual subtitles (original + translation), or triple subtitles (original + transliteration + translation).
- **Multiple Target Languages for Captions:** The SRT Subtitle Crafter now supports generating multi-lingual tracks simultaneously! You can type multiple languages (e.g., "English, Spanish, French") in the target box and the AI will output all of them stacked in your subtitles. Also updated the UI icon for better clarity.
- **Legacy Model Swap Support:** Fixed an issue where legacy image models (like Gemini 2.5 Flash) would ignore Character References in the Multi-Swap tool and just perfectly regenerate the original frame. For legacy models, we now completely withhold the Frame Reference image from the generation payload. Instead, we dynamically use Gemini 3.5 Flash to write a hyper-detailed text description of the scene's background and pose, and send ONLY the text description and the Character Reference image to the generator. This forces legacy models to synthesize a brand new "similar" image composition while strictly applying the Character Reference, matching expectations. Gemini 3.1 Flash continues to use the modern, flawless tag-based multi-image replacement.
- **Live Agent Toggle:** Added a "Live Agent" toggle button to the settings menu. You can now pause the agent's background polling/syncing if the app is refreshing or booting constantly during edits.
- **Expanded Studio Assistant Capabilities:** The in-app AI Studio Assistant is now fully integrated with your live project state. It can now edit existing characters and save images you upload in the chat directly to your project's Reference Images (Master Art / Character Sheets) using its built-in tools.
- **Download Fix:** Fixed an issue where downloading generated images one by one would sometimes result in corrupted filenames starting with `.pending-` in certain browsers. The downloads now securely process through object URLs to ensure the correct file name is always applied.
- **Settings UI Fix:** Adjusted the API settings vault layout so that the content is scrollable. This prevents the "Save" button from being pushed off-screen when expanding the custom API key options.
- **Image Generation Model Setting:** Added a new setting in the API settings vault (the key icon) to select the Image Generation Model. You can now choose between Gemini 3.1 Flash Image, Gemini 2.5 Flash Image, and Pollinations (a free, text-only fallback) if you are encountering quota limits or long 1-minute timeout timers. Note that Pollinations does not support image-to-image advanced tools like Character Swapping or Outpainting.
- **Lab Extension:** Added the "Original" aspect ratio option to the Multi-Swap, Single Image, and ID Transfer generation tools in the Lab.
- **Studio Chat Assistant:** The assistant has been confirmed to have full access to your project data (characters, scenes, references) and continues to be able to edit your app state using its built-in tools.
\n- **Director Audio Support:** You can now upload a reference song directly in the Director tab! The AI Director (Gemini 1.5 Pro) will natively listen to the audio track alongside your lyrics to generate scenes that perfectly match the song's pacing, musical beats, and emotional tone.
### Fixed
- **Mobile Fix:** Re-architected the Subtitle Timeline Editor to use a responsive inline layout, preventing the edit toolbar from covering the timeline tracks on small screens.
- **Timeline UX:** Added a hold-to-drag haptic gesture for subtitle blocks, making it much easier to scroll the timeline track without accidentally moving subtitles.
- **Bulk Uploads:** Added bulk multi-selection support to character reference inputs to bypass mobile file picker limitations.
- **Subtitle Persistence:** Generating subtitles, splitting blocks, or making timing edits are now instantly saved. Navigating away or refreshing the page will no longer clear your subtitle timeline or disconnect your audio file.

### Fixed
- **Timeline Editor UX:** Completely overhauled the Subtitle Timeline Editor's layout. The text editing box is now a sleek floating modal that only appears when you explicitly click "Edit Text". It floats over the video preview space, ensuring it no longer pushes down or covers the subtitle timeline tracks on smaller screens. 
- **Timeline Toolbar:** The action toolbar (Split, Duplicate, Delete) has been condensed into a single slim row to maximize vertical space for the timeline and video preview.

### Fixed
- **Live Agent Toggle:** Fixed an issue where the "Live Agent" setting would not stay turned off if you refreshed the page. The app now properly remembers your preference.
- **Boot Loop Fix:** Fixed an issue where the app would occasionally get stuck in a "booting" (refreshing) loop when the Live Agent was actively fetching or sending data in the background.

### Fixed
- **Mobile Subtitle UI Layout:** Fixed an issue on mobile devices where the Subtitles tab header ("AI Generator / Timeline Editor") took up too much vertical space by hiding redundant title text and placing the toggles in a single compact row.

### Fixed
- **Timeline Handle Interaction:** Added a dedicated "drag" tab (a small handle that floats directly above a selected subtitle block) for moving the subtitle's position in time. 
- **Timeline Touch Targets:** Removed the confusing "hold-to-drag" haptic delay. Now, touching anywhere inside the block lets you easily scrub/scroll the timeline, while touching the new top-tab handle instantly moves the block. The left and right trim handles have also been made visually thinner to prevent them from taking up the entire block on mobile screens.

### Fixed
- **Timeline Subtitle Collisions:** Fixed an issue where dragging or resizing a subtitle block could cause it to overlap with adjacent subtitle blocks. The editor now uses collision detection, clamping the movement or resize action so that a block can never be pushed past the end of the previous block or the start of the next block.

### Fixed
- **Gemini 3.1 Character Swapping:** Fixed an issue where the Multi-Swap tool with Gemini 3.1 Flash Image would fail to apply the character identity. Removed negative constraints (e.g., "DO NOT copy style") which were confusing the model, correctly formatted the reference tags (`[Character Reference]` and `[Frame Reference]` without trailing colons), and positioned the instructions before the images to ensure Imagen 3 correctly reads the structural references.

### Fixed
- **Gemini 3.1 Swap Quality:** Fixed an issue where the Gemini 3.1 Flash Image model was blending the character's face with the original frame's subject, resulting in a fake or uncanny appearance. Updated the multi-image reference syntax to use the official Imagen 3 tags (`[Scene Reference]` and `[Subject Reference]`) and strengthened the prompt instruction to enforce a hard replacement of the subject's identity rather than a soft blend.

### Fixed
- **Organic Character Swaps:** Completely overhauled the Gemini 3.1 character swapping engine. Previously, passing both the scene image and the character image directly to the model caused an unnatural "cut and paste" effect where the face lighting didn't match the background, or the model just regenerated the original frame. We now use a two-step AI pipeline: first, a vision model conducts a rigorous pixel-perfect analysis of the original frame (pose, clothing, lighting, background), then the image generator synthesizes a *brand new*, 100% organic photograph using that description combined with your Character Reference. This ensures the lighting, shadows, and skin texture match perfectly, eliminating the "photoshopped" look!

### Fixed
- **Gemini 3.1 Exact Scene Recreation:** Re-enabled passing the exact Scene Reference image to the Gemini 3.1 engine to preserve complex physics (like splashing coffee or exact background details) that couldn't be captured by textual auto-description alone. Adjusted the prompting to instruct an explicit "Image Editing" task for flawless integration.

### Added
- **Gemini 3.7 Support:** Added support for the newly released Gemini 3.7 Pro and Gemini 3.7 Flash models. Gemini 3.7 Flash is now the default text model for generating director plans and enhancing prompts, offering faster generation and better reasoning.

### Added
- **Subtitle Generation Time:** Added a display in the Subtitles tab to show the exact time it took to generate the subtitles. The generation time is shown at the top of the tab for both the AI Subtitle Generator and the Timeline Editor views.

### Fixed
- **Timeline Zoom Accuracy:** Fixed an issue in the Subtitle Editor where caption boxes appeared to overlap into incorrect times when zoomed out. Boxes now accurately scale to their exact millisecond duration regardless of the zoom level.
- **Timeline Performance:** Drastically improved the performance of the timeline editor when zooming in and out by virtualizing the background grid markers, preventing browser lag with long videos.

### Fixed
- **Timeline Zoom Drift:** Fixed a critical bug where zooming in or out on the timeline would cause subtitle boxes to drift away from the central playhead, making them appear out of sync with the video time. The timeline now mathematically locks the current time to the exact center of the screen during all zoom operations.

### Added
- **Pinch-to-Zoom:** The timeline editor now fully supports pinch-to-zoom on mobile and trackpads. You can smoothly zoom in and out of the timeline track by pinching with two fingers on mobile devices or using trackpad pinch gestures (or Ctrl+Scroll) on desktops.

### Added
- **Keyframe Analyzer:** Added a new "Keyframes" tab. This module allows you to upload a short video, automatically extract 30 high-resolution frames, and send the full sequence to Gemini 1.5 Pro to analyze motion, detect duplicates, and identify keyframes.

### Added
- **Bulk Frame Download:** Added a "Download All (ZIP)" button to the Keyframes tab. You can now extract frames and download all 30 high-resolution images instantly in a single `.zip` file, which is perfect for manual frame-by-frame rotoscoping or image editing workflows.

### Added
- **Export as Grid:** Added an "Export Grid" button to the Keyframes tab. This dynamically stitches your extracted frames into a single, high-resolution grid image (e.g., 6x5 or 4x4 depending on frame count) and downloads it instantly. This is perfect for the 2-4 frame "AI Image grid hack."

### Changed
- **Dynamic FPS Extraction:** Upgraded the Keyframe Analyzer to allow dynamic frame extraction based on frames-per-second (FPS) instead of a hardcoded 30 frames. You can now select standard framerates (8, 12, 15, 24, or 30 FPS). The app will calculate the exact number of frames based on the video's duration and extract every single frame perfectly in sync.

### Added
- **Frame Scrub & Save:** Added a "Save Frame" button to the Captions tab. When you have a video uploaded and are scrubbing the timeline to sync subtitles, you can now pause at any perfect moment and instantly save that exact frame as a high-resolution image.

### Added
- **Caption Styling:** Added a "Caption Style" settings button to the Video Preview in the Captions tab. You can now dynamically adjust the font size and the vertical position (Y-axis) of your subtitles overlaying the video in real-time.

### Fixed
- **Caption Preview Overlay:** Fixed a bug where the new "Caption Style" settings (font size and vertical position) failed to update the visual caption overlay on the video. The settings now perfectly update the preview in real-time, allowing precise placement of captions over your video scenes.

### Changed
- **Video Player UI:** Upgraded the subtitle editor video player to a cleaner "Pro" layout. The "Caption Settings" and "Save Frame" buttons have been moved from the video overlay into the bottom timeline toolbar.
- **Fullscreen Mode:** Added a "Watch in Fullscreen" button to the timeline toolbar (and double-click on the video) to expand the player and your customized subtitles to the full screen.

### Added
- **Long Video Subtitles (>30 mins):** Upgraded the AI subtitle engine to use the Gemini File API. The app now natively supports generating subtitles for massive video and audio files (up to 2GB) without crashing your browser. It automatically switches to a resumable cloud upload for large files.

### Fixed & Added
- **Caption Style Menu Fix:** Fixed a layout issue where the subtitle style settings menu could get cut off at the bottom of the screen. It now opens safely as a centered modal.
- **Subtitle Synchronization:** Added a new "Sync" button (clock icon) to the subtitle editor toolbar. If an imported SRT is out of sync with your audio/video, you can now shift all captions forward or backward in time (e.g., +500ms or -500ms) with a single click to perfectly align them.

### Changed
- **Millisecond Timeline Precision:** The timeline timecode displays (current playhead time, block drag handles, and grid markers) now show exact 3-digit milliseconds (e.g., \`01:23.456\`) instead of rounding to hundredths of a second. This provides perfect exact-frame timing visibility when syncing subtitles!

### Added
- **Visual Drag-to-Sync:** You can now visually synchronize your entire subtitle track! Simply grab and drag the **very first subtitle block** on the timeline left or right. The entire timeline of subtitles will automatically lock onto it and shift by the exact same amount, allowing you to visually sync the first spoken word and have the rest follow suit perfectly. (Dragging any other block behaves normally).

### Added
- **Global Video Scrubber:** Added a full-width timeline slider immediately below the video player. You can now grab this slider and instantly fast-forward, rewind, or scrub to any scene in your video, making it much easier to jump between distant subtitles.

### Fixed
- **Playback Interruption Error:** Fixed an underlying browser error (`The play() request was interrupted by a call to pause()`) that would occur if you quickly scrubbed the timeline or clicked pause immediately after playing the video. The player now gracefully handles rapid play/pause inputs without throwing background errors.

### Fixed
- **Drag-to-Sync Reliability:** Fixed an issue where dragging the first subtitle block to the right to sync the track could sometimes feel "stuck" or stop responding. The visual sync mechanism has been completely rewritten to perfectly track your mouse 1:1, making it perfectly smooth and reliable in both directions.

### Fixed
- **Sync Modal Visibility:** Fixed a confusing behavior where the Sync Subtitles menu would stay open after you clicked "Apply" or a preset button (+0.5s). It now automatically closes the moment you apply a change, allowing you to instantly see the timeline shift beneath it. You can also now just press the "Enter" key after typing a custom millisecond offset!

### Changed
- **Sync Custom Input Unit:** The custom input in the Sync Subtitles menu now expects **Seconds** instead of Milliseconds to be much more intuitive (and to match the preset buttons). You can now simply type `9.6` and hit Enter, and it will correctly shift by 9.6 seconds!

### Changed
- **Drag Color Feedback:** When you click and drag a subtitle block (or its resize handles) on the timeline, the block now turns Green to give you clear visual feedback that it is actively being manipulated.

### Added
- **Ripple Sync Drag Mode:** You can now choose exactly how you want to drag your subtitles! When you click on a subtitle box, you'll see a split handle on top:
    - **Amber Side (Normal Drag):** Moves only the specific subtitle box you are dragging.
    - **Indigo Side (Sync Drag):** Moves the dragged box **AND all subtitles that come after it**. This is perfect for instantly fixing the sync for the rest of your video without messing up the captions before it!

### Fixed
- **Video Playback Bug:** Fixed an issue where the Play button could become stuck or require a double-click to work if the video had reached the end of its timeline during a sync operation.

### Changed
- **Drag by Body!** Based on your feedback, those tiny top drag handles have been completely removed. You can now **grab and drag the body of the subtitle box directly** to move it around!
- **Global Drag Mode Toggle:** Since you can now drag the box directly, I added a new toggle switch to the timeline toolbar (next to Import/Export). You can click it to switch between **Normal Drag** (moves one box) and **Sync Drag** (moves the box and everything after it). 

### Fixed
- **Preview Sync on Click:** When you click a subtitle box, the video preview now instantly jumps to that exact moment so you can see the frame it corresponds to! (It won't jump if you are dragging the box, to make sure dragging stays smooth).

### Added
- **Reset Zoom Button:** Added a "Fit Zoom" button (the scanner icon next to the Zoom Out button). Clicking this instantly resets your timeline to a comfortable 10-second default zoom level.

### Fixed
- **Preview Drag Sync:** A massive improvement to editing flow! When you grab and drag a subtitle box, the video preview now actively updates frame-by-frame to match where you are dragging it. The timeline stays anchored while the playhead line perfectly follows your mouse.
- **Crowded Controls:** Fixed the main timeline toolbar buttons overlapping or getting pushed off-screen. They now live in a clean, horizontally scrollable row on smaller screens.
- **Diagnostics:** Added internal debug tracking to monitor media playback states to investigate the video start/stop issues.

### Fixed
- **Timeline Scrubbing:** Tapping the timeline area to start dragging no longer causes the video to abruptly jump to where your finger landed. You can now smoothly grab anywhere on the timeline and drag it left/right, just like a mobile video editor!

### Added
- **Timeline Center Mark:** Added a permanent red center anchor line to the timeline. When you drag a subtitle block and the white playhead moves away to show the preview frame, the red line stays locked in the middle so you don't lose your place.

### Fixed
- **Massive Performance Boost for Dragging:** Dragging subtitle boxes and trim handles on the timeline is now butter-smooth! Previously, forcing the video to update 60 times a second during a drag was causing the browser to lock up. The UI now updates instantly while the video preview updates at a more comfortable ~12fps during the drag, snapping perfectly to the final frame when you release.

### Fixed
- **Timeline Scrub Snapping:** Fixed an issue where sliding the timeline (or dropping a subtitle box) would snap everything back to the beginning when you let go. It will now properly stay exactly where you dropped it.

### Fixed
- **Mobile Drag Dropping:** Completely fixed the issue where the drag handle or moving a box would fail and feel like you "released your finger" prematurely. This was caused by the mobile browser secretly trying to scroll the page behind the scenes, which was interrupting the drag. The timeline is now completely locked from background scrolling during use.
- **Visual Timeline Desync (6s vs 8s):** Fixed a critical layout bug where the timeline visuals (the grid and the red center line) could get mathematically out of sync with the video's actual time if your phone screen resized (like when the address bar hides). The timeline now uses a highly precise `ResizeObserver` to guarantee the subtitle boxes perfectly align with the video preview.
- **Dynamic Timeline Grid:** The timeline time markers (ticks) now adjust intelligently based on how much you are zoomed in! Instead of always showing a tick every 10 seconds, it will now smoothly scale down to show 5-second, 2-second, and even 1-second grid lines so you don't have to guess the exact time.

### Changed
- **Dedicated Move Mode:** Based on feedback, the ability to simply grab and drag a subtitle box has been removed, as it made it too easy to accidentally move a subtitle out of sync when you just wanted to select it. Instead, there is now a dedicated **Move (Arrows)** button in the subtitle edit menu! Clicking this button locks the subtitle into "Move Mode" (it turns red), allowing you to safely drag it around.
- **Drag Stability (Hallucination Fix):** Added further protections to the trim handles to prevent the mobile browser from confusing a drag adjustment with a "drag-and-drop image" action, which was causing the drag to abruptly cancel and release on its own.
### Changed
- **Character Realism Constraints:** Adjusted the realism constraints in the character image generation prompts to prevent characters from looking overly textured or harsh. The prompts now favor a 'naturally smooth, clean, and flattering' look while still explicitly avoiding purely plastic/CGI AI appearances.
### Fixed
- **SRT Generation Permission Error:** Fixed a `PERMISSION_DENIED (403)` error when generating subtitles. The SRT generator and auto-captioner were previously hardcoded to use a specific model (Gemini 3.5 Flash) that may not be available to all API keys. They now correctly use whatever text model you currently have selected in your API Settings.
### Fixed
- **INVALID_ARGUMENT on Subtitle Generation:** Fixed an obscure bug that caused the SRT Subtitle Generation to fail with an `INVALID_ARGUMENT (400)` error for some files/browsers. This was caused by the browser secretly attaching incompatible file headers during the upload. The upload engine now bypasses the browser completely and sends raw binary data directly to the AI!
### Fixed
- **Large File Upload Crash:** Completely resolved the stubborn `INVALID_ARGUMENT (400)` error when uploading large videos for subtitle generation. The upload engine now uses Google's official native SDK which automatically breaks massive files into smaller, safe chunks behind the scenes instead of trying to force the browser to send it all at once!
### Changed
- **Subtitle Sentence Chunking:** Improved the AI prompt for generating subtitles so it no longer packs multiple sentences into a single, massive subtitle block. It will now properly break down long speeches into shorter, highly readable chunks that span across multiple frames instead of overwhelming the screen.
### Fixed
- **Media Player Icon Crash:** Fixed an application crash (Uncaught ReferenceError: Video is not defined) caused by a missing video icon import in the media player toolbar.
### Fixed
- **Media Player Crash:** Fixed an unhandled `DOMException` error ("The play() request was interrupted because the media was removed") that occurred when quickly clearing or swapping the active soundtrack. The audio player now safely catches playback interruptions instead of crashing the app.
### Added
- **Password Protection:** Added a secure `<PasswordGate>` layer. When you share this application, visitors will be required to enter a password to access it. The password can be set in the AI Studio Secrets panel using the `VITE_APP_PASSWORD` variable.
### Added
- **Asset Xplorer Tab:** Inspired by X-plore file manager, this new tab allows you to view and search all files currently loaded in the project's IndexedDB (Audio, Reference Images, and Generated Scene Media) through a clean, dual-pane-like UI.
### Added
- **Audio/Video Processing Modes for Subtitles:** You can now explicitly choose whether Gemini should "Listen Only" (process just the audio track, saving tokens and speeding up generation) or "Watch & Listen" (process the video frames to read lips, action, and text for better context).

### Added
- **Dual Translated Subtitle Format:** Added a new "Dual Translated" option in the SRT Subtitle Crafter. This generates a two-line caption where the top line is English and the bottom line is your target language, completely skipping the native language transcription.
### Added
- **On-Screen Text & Emotion Captions:** When using the "Watch & Listen (Video)" mode for subtitle generation, Gemini is now explicitly instructed to extract and include floating text, emotion markers, and stylized action graphics (like '看' or '靠近') into the subtitle blocks using bracket formatting (e.g., `[Action: approaches]`).
### Changed
- **On-Screen Text Formatting:** Removed the explicit "Text:" and "Action:" prefixes from bracketed on-screen text in subtitles. The AI will now just output the clean text, like `[看]` instead of `[Text: 看]`.
### Fixed
- **Timeline Playback Bug:** Suppressed an unexpected error popup (`The play() request was interrupted by a call to pause()`) that occurred when rapidly scrubbing, pausing, or clicking the timeline in the Subtitle Editor while the media was still attempting to play.
### Added
- **Resume / Start Time Feature:** Added a new "Resume / Start From" input field in the subtitle generator settings! If the AI ever crashes or cuts off halfway through a massive video, you can now input the exact timestamp where it stopped (e.g. `00:52:00`). The AI will ignore everything before that time and seamlessly continue generating the rest of the video!
- **Undo/Redo & Clear Subtitles:** You can now safely undo and redo all your subtitle edits! Added standard Undo and Redo arrows to the timeline toolbar, along with a "Clear All" trash icon to quickly wipe the timeline and start over.

### Changed
- **Timeline Timer Format:** Updated the timer display in the Subtitle Editor to always show the full `Hours:Minutes:Seconds.Milliseconds` format (e.g., `01:14:59.744`). Previously, it hid the hours (showing `74:59.744`), which caused confusion when copying and pasting timestamps into other tools.
- **Ripple Sync Trimming:** The "Sync Mode" in the Subtitle Editor just got a major upgrade! Previously, you could only push/pull other clips when dragging the middle of a subtitle block. Now, resizing the left or right edges (trimming) while in Sync Mode will automatically push or pull all adjacent subtitles to make room, perfectly preserving your timeline's timing, just like a professional video editor!
- **Cleaner Subtitles (No Periods):** Added a new instruction forcing the AI to drop trailing periods (full stops) at the end of generated subtitle lines to keep the video aesthetic clean and cinematic.

### Fixed
- **Resume Feature Wiping Timeline:** Fixed an issue where using the new "Resume / Start From" feature would accidentally wipe out the existing subtitles on your timeline. Now, the app intelligently keeps all your existing subtitles up to the resume time, and seamlessly stitches the newly generated subtitles onto the end!
- **Skipped Subtitle Gaps:** Fixed an issue where the AI would occasionally skip large chunks of audio (sometimes jumping 7-8 minutes) during long videos to compress the timeline. Added a new strict rule to the AI to enforce continuous, gapless transcription of every spoken sentence.
### Added
- **Language Autocomplete:** Source and Target Language input boxes in the Subtitles Tab now include browser-native dropdown suggestions (e.g. English, Spanish, Japanese, Auto-detect) while still letting you type any custom language.
- **Persistent Subtitle Settings:** All your subtitle preferences (format type, languages, styling, and processing mode) are now automatically saved to your browser! They will instantly reload the next time you open the application.
- **Custom Context Instructions:** Added a dedicated "Context / Instructions" text box to the Subtitle Generator! You can now pass explicit notes to the AI before generating (e.g., "The character's name is Kael", "Use casual tone", "This is a medical drama") to vastly improve transcription accuracy for specialized videos.

### Fixed
- **App Crashing on Load (White Screen):** Fixed a critical "app keep crash" issue that caused the application to show a complete white screen / connection refused error. This was caused by the underlying developer server getting stuck on port 3000, forcing the preview to fail. The server has been successfully rebooted.
- **Strict Storage Protection:** Wrapped all persistent local storage variables in strict fallback protections to prevent the application from totally crashing if you use an Incognito tab or a browser that forcibly blocks third-party cookies/storage.
- **INVALID_ARGUMENT on Subtitle Generation (Gemini 3.7):** Fixed a critical `INVALID_ARGUMENT (400)` API error that caused SRT Generation to fail when using the new Gemini 3.7 Flash model. The app was incorrectly attempting to force a "MINIMAL" thinking mode config which is not supported by the standard Flash model variant.

### Added
- **Gemini 3.8 Support:** Added full support for the next-generation **Gemini 3.8 Flash** and **Gemini 3.8 Pro** models! You can now select them directly from the API settings dropdown.

### Changed
- **Dynamic Vision AI:** Hardcoded legacy model dependencies have been removed from the video analysis features. Agentic Video analysis (like "Vision Fix") and frame analysis will now seamlessly use whatever cutting-edge model you have selected (3.7 or 3.8) rather than forcing an older model.
- **Reference Video Playback (MP3 Workaround):** Fixed a bug with the Timeline Editor's "Upload Track" button. You can now generate your subtitles rapidly using a small MP3 file, and then inside the timeline editor, use the "Upload Track" button to attach your heavy MP4 video file. The editor will instantly swap the audio player for the video player so you can match lip-syncing perfectly, all without having to upload the heavy MP4 to the AI!
- **Vision AI on Local Videos:** Fixed a bug where advanced video features (like "Vision Fix" and taking screenshots) would disappear or break if you used the "Upload Track" button to swap your MP3 for a video file. The editor now correctly unlocks all AI video tools the moment a video is detected in the player!
- **Dedicated "Swap Media" Button:** The Timeline Editor now has a direct, top-level "Swap Media" button on the main toolbar. You no longer have to dig into the Audio Alignment settings to swap your MP3 for an MP4! 
- **Silky Smooth Timeline Scrubbing:** Rewrote the timeline panning engine to use imperative, zero-latency direct DOM transformations. Dragging the timeline background is now perfectly locked to your cursor at 120fps with zero visual lag.
- **Smart Edge-Tracking Auto-Pan:** When dragging a long subtitle block, the timeline will now intelligently pan if the *edge* of the subtitle box reaches the side of the screen, instead of only triggering when your mouse cursor reaches the edge.
- **Punctuation Cleanups:** Instructed the AI to strictly avoid trailing periods (.) at the end of subtitle blocks for a cleaner, modern look. The app now also aggressively post-processes all generated and imported SRT files to strip out accidental trailing periods.
- **Vision Fix Translation:** Improved the Agentic Video Vision Fix prompt to strictly enforce translation. If it detects hardcoded on-screen text (like Chinese graphics) but your current subtitles are in English, it will now properly translate the on-screen text into your target language instead of transcribing the native characters.
- **Subtitle Splitting Limits:** Enforced a strict maximum duration rule (max 5 seconds per block) on the Auto-Subtitle generator. It will now properly chop up long sentences instead of generating massive 10-second subtitle blocks.
- **On-Screen Graphics Recognition:** Updated the Auto-Subtitle generator's system prompt to explicitly respect user instructions requesting transcription of silent on-screen graphics or emotion tags (like [Curious]), ensuring it doesn't skip visual cues when nobody is speaking.
- **Vision Fix Placeholder Overrides:** Fixed a bug where creating a blank/new caption block and running the Vision Fix would sometimes do nothing because the AI didn't know what language to translate the visual context into. It now automatically detects placeholders (like "New Caption") and aggressively writes fresh English captions for on-screen context.
- **Vision Fix UI Improvements:** Added explicit loading states ("Uploading..." and "Analyzing...") to the Vision Fix button. This clarifies why the tool takes 15-20 seconds (video files must be temporarily cached on Gemini's API servers before the Vision models can deeply analyze the timeline).
- **Advanced Subtitle Analysis Pipeline:** Upgraded the Auto-Subtitle generator's system prompt by incorporating a multi-stage analysis pipeline. It now explicitly considers scene segmentation, speaker identification, and word-level audio alignment before generating text, ensuring subtitles don't bleed across camera cuts and timing matches acoustic realities rather than just textual sentence length.
- **Vision Fix Error Handling:** Improved error handling when uploading video files to Gemini's servers. If a video fails to process (e.g., due to an unsupported codec or corruption), the app will now surface the exact error message from Google's backend instead of a generic failure message. Also ensured that the file's MIME type is explicitly sent to Gemini during upload to prevent format confusion.
- **Subtitling Sync Fix:** Fixed an issue where the AI would sometimes generate two separate subtitle blocks that occur at the exact same time (resulting in overlapping text UI glitches). The AI is now strictly instructed to combine overlapping speech into a single subtitle block (e.g., separating the two speakers with dashes on two lines) and is mathematically forbidden from outputting overlapping timestamps.
- **Emotional & Expression Tagging:** The AI Subtitle Engine is now explicitly instructed to read visual facial expressions and acoustic tones of voice to inject emotional tags (like `[Surprised]`, `[Crying]`, `[Shyly]`, `[Laughing]`) into the generated subtitles.
- **Phantom Timing Fix:** The Subtitle AI now strictly separates non-verbal vocalizations (like "woah", "ah", or gasps) from the main sentence block. It is now forbidden from starting a subtitle's timecode early during a vocalization unless it actually transcribes that exact vocalization sound.
- **Hear Fix (Agentic Audio):** Added a new "Hear Fix" button next to "Vision Fix" inside the subtitle text editor. It acts as an Agentic Audio analyzer that listens closely to the exact timestamp of the subtitle to correct misspelled words or misheard dialogue based on tone and pronunciation.
- **Editor UI Fix:** Fixed a UI bug where the text editor would abruptly close automatically when selecting a block to edit.
- **UI Overflow Fix:** Adjusted the action button row in the subtitle editor to support wrapping (`flex-wrap`). The "Hear Fix" button will no longer push the "Done" button off-screen on smaller devices.
- **Vision/Hear Fix Speed Optimization:** Fixed an issue where the Agentic Video and Audio analyzers would take a very long time to process even short segments. The analyzers now inject explicit `videoMetadata` offsets into the API call so that the Google backend only processes the exact 3-second clip being edited, rather than extracting frames from the entire 5-minute video file on every click.
- **Sync Trans Upgrade:** The "Sync Trans" button can now be used on single-line subtitles! It reads your globally selected Subtitle Format (Bilingual, Triple, etc.) and Target Language from the sidebar, and will automatically generate the missing translations/romanizations underneath your text.
- **Realistic Progress Times:** Updated the in-app notifications for "Vision Fix" and "Hear Fix" to properly reflect Google's 1-3 minute backend processing times.
- **Two-Pass AI Subtitling:** Overhauled the core Gemini subtitle generation pipeline. It now runs in two distinct passes: Pass 1 strictly analyzes audio to generate perfect timestamps (acting as a stopwatch), and Pass 2 handles all complex translations and formatting without modifying the timing. This dramatically reduces timestamp drift when generating translated or multi-layered subtitles!
- **Two-Pass AI Subtitling:** Overhauled the core Gemini subtitle generation pipeline. It now runs in two distinct passes: Pass 1 strictly analyzes audio to generate perfect timestamps (acting as a stopwatch), and Pass 2 handles all complex translations and formatting without modifying the timing. This dramatically reduces timestamp drift when generating translated or multi-layered subtitles!
- **Bug Fix:** Fixed an issue where the "Swap Media" / "Swap Video" button on the Timeline Editor control bar would fail to open the file selection window because the hidden input element was conditionally unmounted.
- **Bulk Text Tools:** Added a new dedicated "Bulk Text Tools" popup to the Timeline Editor.
  - You can now instantly clean bilingual subtitles by stripping away Line 1 or Line 2 across all blocks.
  - You can instantly swap the positions of Line 1 and Line 2 for dual-language setups.
  - You can paste a list of text/translations and map them to overwrite specific lines in your existing subtitle blocks chronologically!
