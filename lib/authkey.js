/**
 * Read one account's stored API key from magpie's plugin-auth.json.
 *
 * A tool call runs outside an account's scope: magpie does not hand `getAuth()`
 * to the tool hook, so a probe must resolve a key another way. The auth file is
 * magpie's own store and sits in the directory the plugin already receives;
 * reading it here is what makes `magpie_probe` work immediately after a reload,
 * before any provider request has populated the in-memory account.
 *
 * The value is returned to the caller only; it is never logged, cached in the
 * state file, or included in a tool result.
 *
 * @module magpie-cline-pass/authkey
 */
import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve the first API key stored for a provider.
 *
 * @param {{directory?: string, provider: string}} options
 * @returns {string} the key, or an empty string when none is stored.
 */
export function readStoredApiKey({ directory = '', provider }) {
  if (!directory || !provider) return ''
  const file = path.join(directory, 'plugin-auth.json')
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return ''
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return ''
  const prefix = `${provider}#`
  for (const [name, auth] of Object.entries(data)) {
    if (name !== provider && !name.startsWith(prefix)) continue
    if (auth && auth.type === 'api' && typeof auth.key === 'string' && auth.key.trim().length > 0) return auth.key
  }
  return ''
}
