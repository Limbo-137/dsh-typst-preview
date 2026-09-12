/**
 * `dsh-resource://file/…` address parsing.
 *
 * The right Sidebar records a resource tab under the address it opened, so this
 * is where the tab body learns which file it is showing. Session-scoped
 * addresses carry `session/<sessionId>/<path>`; the path is absolute on POSIX
 * when it starts with `/`, otherwise workspace-relative. `absolute/<path>`
 * addresses carry no session, so the enclosing slot's session identity is the
 * fallback. Encoding is per segment, exactly as the address was built.
 */

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

/** One file address resolved to the parts a reader needs. */
export interface SessionFileAddress {
  /** Owning Session: from the address, or from the enclosing slot when it carries none. */
  readonly sessionId: string
  /** Absolute or workspace-relative path, decoded. */
  readonly path: string
}

/** One decoded path segment, or `undefined` when the address is malformed. */
function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment)
  } catch {
    return undefined
  }
}

/**
 * Read a file address back into its parts.
 * @param address - a candidate `dsh-resource://file/…` address.
 * @param fallbackSessionId - session identity used by session-less addresses.
 * @returns the parts, or `undefined` when the address is not a file address with a path.
 */
export function parseFileAddress(address: string, fallbackSessionId: string): SessionFileAddress | undefined {
  if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const end = address.search(/[?#]/)
  const rest = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
  const [scope, ...tail] = rest.split('/')
  if (scope === 'session') {
    const [id, ...segments] = tail
    if (id === undefined || id === '' || segments.length === 0) return undefined
    const decodedId = decode(id)
    if (decodedId === undefined) return undefined
    const parts: string[] = []
    for (const segment of segments) {
      const value = decode(segment)
      if (value === undefined) return undefined
      parts.push(value)
    }
    const path = parts.join('/')
    if (path === '') return undefined
    return { sessionId: decodedId, path }
  }
  if (scope === 'absolute') {
    const unc = tail[0] === '' && tail.length > 1
    const segments = unc ? tail.slice(1) : tail
    const parts: string[] = []
    for (const segment of segments) {
      const value = decode(segment)
      if (value === undefined) return undefined
      parts.push(value)
    }
    const joined = parts.join('/')
    if (joined === '') return undefined
    return { sessionId: fallbackSessionId, path: unc ? `//${joined}` : `/${joined}` }
  }
  return undefined
}

/** The tab chip's text: the file's last segment, or the address when it has none. */
export function basenameOf(address: string): string {
  const withoutQuery = address.split(/[?#]/)[0] ?? address
  const trimmed = withoutQuery.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  const segment = index === -1 ? trimmed : trimmed.slice(index + 1)
  const decoded = decode(segment)
  return decoded === undefined || decoded === '' ? address : decoded
}
