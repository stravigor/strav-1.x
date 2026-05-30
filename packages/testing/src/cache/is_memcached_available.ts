/**
 * Cheap connection probe over Bun's TCP socket — opens a connection,
 * sends `version\r\n`, expects a `VERSION ...\r\n` reply. Cached for
 * the lifetime of the test process.
 *
 * Returns `false` if `MEMCACHED_HOST` / `MEMCACHED_PORT` are missing
 * OR the probe fails. Pair with
 * `describe.skipIf(!await isMemcachedAvailable())`.
 */

let cachedAvailability: boolean | null = null

export async function isMemcachedAvailable(): Promise<boolean> {
  if (cachedAvailability !== null) return cachedAvailability
  const host = process.env['MEMCACHED_HOST']
  const portStr = process.env['MEMCACHED_PORT']
  if (host === undefined || host === '' || portStr === undefined || portStr === '') {
    cachedAvailability = false
    return false
  }
  const port = Number(portStr)
  if (!Number.isFinite(port) || port <= 0) {
    cachedAvailability = false
    return false
  }
  try {
    cachedAvailability = await probe(host, port)
  } catch {
    cachedAvailability = false
  }
  return cachedAvailability
}

function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const timeout = setTimeout(() => finish(false), 2_000)
    void Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          socket.write('version\r\n')
        },
        data(socket, chunk) {
          const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          const text = new TextDecoder().decode(bytes)
          const ok = text.startsWith('VERSION')
          // Settle before closing — `socket.end()` synchronously fires
          // the `close` callback, which would beat `finish(ok)` to the
          // settle line and report a false negative.
          clearTimeout(timeout)
          finish(ok)
          socket.end()
        },
        error(_socket, _error) {
          clearTimeout(timeout)
          finish(false)
        },
        close() {
          clearTimeout(timeout)
          if (!settled) finish(false)
        },
      },
    }).catch(() => {
      clearTimeout(timeout)
      finish(false)
    })
  })
}
