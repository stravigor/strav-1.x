# Multimodal inputs — images, documents, audio

`@strav/brain` lets apps attach images, PDFs, and audio clips to user messages so multimodal-capable models can process them alongside text. Same `Message.content` shape across every provider; the framework translates to each vendor's native wire format.

Coverage matrix:

|                  | Anthropic | OpenAI | Gemini | DeepSeek | Ollama |
|---|---|---|---|---|---|
| **Images**       | yes (Claude 4.x family) | yes (gpt-5 / gpt-4o family) | yes (Gemini 2.x) | yes on `deepseek-vl` | yes on vision models (`llama3.2-vision`, `llava`, `qwen2.5-vl`) |
| **Documents** (PDF) | yes (native `document` block, with optional `title`) | throws — split to images first | yes (via `inlineData` / `fileData`) | throws (inherits OpenAI) | throws (inherits OpenAI) |
| **Audio**        | throws — Anthropic's SDK doesn't expose audio yet | throws — Whisper preprocessing required | yes (via `inlineData` / `fileData`) | throws | throws |

The "throws" entries surface a `BrainError` with vendor-specific remediation guidance instead of a wire-level 400.

## Images

```ts
import { readFileSync } from 'node:fs'
import type { Message } from '@strav/brain'

const image = readFileSync('./receipt.png').toString('base64')

const message: Message = {
  role: 'user',
  content: [
    { type: 'text', text: 'How much was the tax on this receipt?' },
    { type: 'image', source: { type: 'base64', mediaType: 'image/png', data: image } },
  ],
}

const { text } = await brain.chat([message])
// → "The tax line shows $4.23."
```

URLs work too — same shape, just swap the `source`:

```ts
{ type: 'image', source: { type: 'url', url: 'https://example.com/cat.jpg' } }
```

V1 covers images only; audio and video defer.

## `ImageBlock`

```ts
interface ImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; mediaType: string; data: string }   // inline bytes
    | { type: 'url'; url: string }                          // remote
}
```

**`base64` source.** Inline image bytes — uploads, screenshots, attachments your app already holds. `mediaType` is the IANA MIME (`image/png`, `image/jpeg`, `image/webp`, `image/gif`); `data` is base64-encoded with no `data:` prefix (the provider translation adds it where needed).

**`url` source.** Remote image URL. All four cloud providers accept HTTPS; Gemini also accepts `gs://` URIs. Some providers (historically Anthropic) restrict to allow-listed hosts — if a call 404s on a URL that works elsewhere, fall back to base64.

## Per-provider mapping

| Provider | Wire | Notes |
|---|---|---|
| **Anthropic** | `{ type: 'image', source: { type: 'base64' | 'url', media_type, data | url } }` | Native shape. `media_type` is restricted to `image/jpeg | image/png | image/gif | image/webp`. |
| **OpenAI** | `{ type: 'image_url', image_url: { url } }` inside a multi-part content array. base64 sources become `data:<mime>;base64,<data>` URIs. | Text-only messages stay as plain strings (backward compat). Any image triggers the content-array shape. |
| **Gemini** | base64 → `inlineData: { mimeType, data }`. url → `fileData: { fileUri, mimeType }`. | MIME guessed from URL extension; defaults to `image/jpeg`. `fileData.fileUri` accepts public HTTPS and `gs://`. Private URLs need to be fetched + base64'd by the app. |
| **DeepSeek** | Same as OpenAI (compat path). | Vision works with `deepseek-vl` models; ordinary chat models reject images. |
| **Ollama** | Same as OpenAI (compat path). | Vision works with `llama3.2-vision`, `llava`, `qwen2.5-vl`, and similar; non-vision models reject or ignore. |

## Vision-capable models

Tested picks (early 2026):

| Provider | Recommended | Notes |
|---|---|---|
| Anthropic | `claude-opus-4-7`, `claude-sonnet-4-6` | Whole 4.x family is vision-capable. |
| OpenAI | `gpt-5`, `gpt-4o` family | `gpt-5` is the default. |
| Gemini | `gemini-2.5-pro`, `gemini-2.5-flash` | The whole 2.x line. |
| Ollama | `llama3.2-vision`, `llava`, `qwen2.5-vl` | Pull with `ollama pull llama3.2-vision`. Local + private. |
| DeepSeek | `deepseek-vl` | `deepseek-chat` is text-only. |

Models without vision either reject the call with an error or silently ignore the image. Pick a vision-tuned model when sending images.

## Loading images

**From disk (Node):**

```ts
import { readFileSync } from 'node:fs'

const data = readFileSync('./photo.png').toString('base64')
const block: ImageBlock = {
  type: 'image',
  source: { type: 'base64', mediaType: 'image/png', data },
}
```

**From a `File` / `Blob` (browser / Bun):**

```ts
const buf = await file.arrayBuffer()
const data = Buffer.from(buf).toString('base64')
const block: ImageBlock = {
  type: 'image',
  source: { type: 'base64', mediaType: file.type, data },
}
```

**From a URL** (lets the provider fetch — fewer hops, no base64 overhead):

```ts
const block: ImageBlock = {
  type: 'image',
  source: { type: 'url', url: 'https://cdn.example.com/photo.jpg' },
}
```

URL fetches happen on the provider's side; the framework just forwards the URL. Apps that need cross-provider portability (the URL might be blocked by some vendors) prefer base64.

## Streaming with images

Images affect input only — streaming output is unchanged. `brain.stream(...)` and `brain.streamTools(...)` both work the same way; image blocks live on user-role messages, never assistant turns.

```ts
for await (const event of brain.stream([
  { role: 'user', content: [
    { type: 'text', text: 'Caption' },
    { type: 'image', source: { type: 'url', url: '...' } },
  ]},
])) {
  if (event.type === 'text') process.stdout.write(event.delta)
}
```

## Documents (PDF)

Two providers support PDFs natively: **Anthropic** (native `document` block with optional `title` for multi-doc calls) and **Gemini** (via `inlineData` / `fileData`). OpenAI / DeepSeek / Ollama throw with guidance to split the PDF to images first.

```ts
import { readFileSync } from 'node:fs'
import type { Message } from '@strav/brain'

const pdf = readFileSync('./contract-q1.pdf').toString('base64')

const message: Message = {
  role: 'user',
  content: [
    { type: 'text', text: 'Summarize the termination clauses.' },
    {
      type: 'document',
      source: { type: 'base64', mediaType: 'application/pdf', data: pdf },
      title: 'NDA — 2026 Q1',     // optional; Anthropic surfaces this to the model
    },
  ],
}

const { text } = await brain.chat([message], { provider: 'anthropic' })
```

`DocumentBlock`:

```ts
interface DocumentBlock {
  type: 'document'
  source:
    | { type: 'base64'; mediaType: string; data: string }   // 'application/pdf'
    | { type: 'url'; url: string }
  title?: string                                            // shown to the model on Anthropic
}
```

### Per-provider

| Provider | Wire | Notes |
|---|---|---|
| **Anthropic** | `{ type: 'document', source: { type: 'base64'|'url', media_type: 'application/pdf', data|url }, title? }` | Native shape. `title` is forwarded to the model — helpful for multi-doc calls ("the contract", "the invoice"). |
| **Gemini** | `inlineData: { mimeType: 'application/pdf', data }` (base64) or `fileData: { fileUri, mimeType: 'application/pdf' }` (url). `title` is silently dropped. | URL fetches happen on Gemini's side. |
| **OpenAI / DeepSeek / Ollama** | throws `BrainError`. | Apps that target OpenAI for PDFs preprocess with `pdf-to-image` (or similar) and send each page as an `ImageBlock` on a vision-capable model. |

### Multi-document calls

Anthropic handles multiple `DocumentBlock`s in one turn cleanly. Useful for "compare A vs B" or "extract data from all three":

```ts
{
  role: 'user',
  content: [
    { type: 'text', text: 'Find clauses that differ between these two versions.' },
    { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: v1 }, title: 'Version 1' },
    { type: 'document', source: { type: 'base64', mediaType: 'application/pdf', data: v2 }, title: 'Version 2' },
  ],
}
```

## Audio

**Gemini** is the only V1 provider that accepts audio in its chat API. Anthropic + OpenAI throw with guidance:

- **OpenAI** — preprocess via the Whisper API (`audio.transcriptions.create`) or `gpt-4o-transcribe`, then send the resulting text.
- **Anthropic** — their SDK doesn't expose an audio block type yet. Route audio workloads to Gemini, or transcribe upstream.

```ts
import { readFileSync } from 'node:fs'
import type { Message } from '@strav/brain'

const voice = readFileSync('./meeting.mp3').toString('base64')

const message: Message = {
  role: 'user',
  content: [
    { type: 'text', text: 'Transcribe + extract action items as bullet points.' },
    { type: 'audio', source: { type: 'base64', mediaType: 'audio/mp3', data: voice } },
  ],
}

const { text } = await brain.chat([message], { provider: 'google' })
```

`AudioBlock`:

```ts
interface AudioBlock {
  type: 'audio'
  source:
    | { type: 'base64'; mediaType: string; data: string }   // 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/webm', 'audio/aac'
    | { type: 'url'; url: string }
}
```

Supported audio MIMEs on Gemini: `audio/mp3`, `audio/wav`, `audio/ogg`, `audio/flac`, `audio/webm`, `audio/aac`, `audio/m4a`. URL-source MIMEs are guessed from the file extension.

### Per-provider

| Provider | Behavior |
|---|---|
| **Gemini** | `inlineData` (base64) or `fileData` (url) with audio MIME. Same wire path as images. |
| **Anthropic** | throws `BrainError` — SDK doesn't expose an audio block. |
| **OpenAI / DeepSeek / Ollama** | throws `BrainError` — preprocess via Whisper / model-specific transcription and send text. |

## Local + private

Ollama vision + base64 + the local MCP client gives a fully on-device path — image goes from disk → base64 → local Ollama model, no cloud involved:

```ts
import { readFileSync } from 'node:fs'

const data = readFileSync('./medical-scan.png').toString('base64')

const { text } = await brain.chat(
  [{
    role: 'user',
    content: [
      { type: 'text', text: 'Summarize the visible findings.' },
      { type: 'image', source: { type: 'base64', mediaType: 'image/png', data } },
    ],
  }],
  { provider: 'ollama' },
)
```

The same `brain.chat` call swaps to a cloud provider by changing `{ provider: 'anthropic' }` — useful for the "local for sensitive data, cloud for everything else" pattern.

## What's deferred

- **Video inputs.** Gemini supports video clips; Anthropic supports key-frame extraction. Surface lands when an app needs it.
- **Anthropic audio.** Their SDK doesn't expose an audio block yet; when it does the framework adds the translation.
- **Image generation** as a brain primitive. Apps currently drop down to provider SDKs for DALL-E / Imagen / etc.
- **Multimodal embeddings.** `brain.embed(...)` is text-only in V1. Gemini's `multimodalembedding-001` accepts images; an extension lands when an app needs it.
- **`tool_result` blocks carrying media.** A tool might return a chart, generated image, or audio clip. Currently `tool_result.content` is text-only.
- **PDF on OpenAI via auto-rasterization.** Apps that want one-line PDF→images can wrap a helper in their own code; an opt-in framework helper lands when usage warrants.
