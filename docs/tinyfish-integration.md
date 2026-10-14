# TinyFish integration

TinyFish is used as an optional live-web context provider for Studio Chat and as a research helper in the subtitle workflow. It does not transcribe uploaded audio/video or create timed captions by itself.

## Configuration

Set the following secret in the deployment environment for the Express server:

```env
TINYFISH_API_KEY=your_tinyfish_api_key
```

Do not prefix this secret with `VITE_`: it must never be bundled into browser JavaScript. `.env.example` documents the variable, but the real key belongs in the deployment's secret manager/environment.

## Features

- `GET /api/tinyfish/health`: returns whether the server has a TinyFish key configured.
- `POST /api/tinyfish/context`: accepts `{ "query": "...", "purpose": "chat" | "caption" }` and returns a small set of web search sources.
- Studio Chat has an independent TinyFish toggle. When enabled, results are included as untrusted research context and source links are appended to the assistant response.
- The Subtitle Generator has a TinyFish Caption Research panel for names, slang, idioms, cultural context, and translation questions. Results are displayed as source links; users can decide how to use them in context instructions.

## Security and behavior

The API key is only read by the Express server and sent to TinyFish in the `X-API-Key` header. The context route requires a same-origin browser request, limits query length, uses a request timeout, and returns only normalized HTTP(S) sources. Retrieved web content is untrusted and must not be treated as instructions.

TinyFish provides web search/context here, not direct media transcription. Keep the existing configured transcription model for audio/video transcription, timestamp generation, and SRT export. The endpoint requires a valid TinyFish account/API key; without one the UI shows the server's configuration error.
