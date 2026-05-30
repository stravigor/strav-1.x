/**
 * Small utilities shared by `OpenAIBrainDriver` and its subclasses.
 * Kept separate from the message builder / response mapper because
 * these are content-agnostic — SDK request-options forwarding, MIME
 * sniffing, abort-signal probing, and the audio-source upload helper
 * used by `transcribe`.
 */

import { BrainError } from '../../brain_error.ts'
import type { AudioSource } from '../../types.ts'

/** Build the request-options bag forwarded to the SDK. Only `signal` for now. */
export function reqOpts(options: { signal?: AbortSignal }): { signal?: AbortSignal } | undefined {
  return options.signal !== undefined ? { signal: options.signal } : undefined
}

/** Throw a DOMException-shaped abort error if the signal has fired. */
export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

export function extFromMime(mime: string): string {
  const m = mime.split(';')[0]?.trim().toLowerCase() ?? ''
  if (m === 'audio/mp3' || m === 'audio/mpeg' || m === 'audio/mpga') return 'mp3'
  if (m === 'audio/wav' || m === 'audio/x-wav') return 'wav'
  if (m === 'audio/ogg') return 'ogg'
  if (m === 'audio/flac') return 'flac'
  if (m === 'audio/webm') return 'webm'
  if (m === 'audio/aac' || m === 'audio/x-aac' || m === 'audio/mp4' || m === 'audio/m4a') return 'm4a'
  return 'mp3'
}

/**
 * Materialize an `AudioSource` as a `File` the OpenAI SDK's
 * `Uploadable` shape accepts. Base64 → in-memory File; URL →
 * fetch + wrap. The SDK wants a filename; we synthesize one
 * since `AudioSource` doesn't carry one. The extension lets the
 * SDK pick the right content-type for the multipart upload.
 */
export async function audioSourceToFile(audio: AudioSource): Promise<File> {
  if (audio.type === 'base64') {
    const bytes = Buffer.from(audio.data, 'base64')
    const ext = extFromMime(audio.mediaType)
    return new File([bytes], `audio.${ext}`, { type: audio.mediaType })
  }
  const response = await fetch(audio.url)
  if (!response.ok) {
    throw new BrainError(
      `OpenAIBrainDriver.transcribe: failed to fetch audio at ${audio.url}: ${response.status} ${response.statusText}.`,
      { context: { url: audio.url, status: response.status } },
    )
  }
  const buf = await response.arrayBuffer()
  const mime = response.headers.get('content-type') ?? 'audio/mpeg'
  return new File([buf], `audio.${extFromMime(mime)}`, { type: mime })
}
