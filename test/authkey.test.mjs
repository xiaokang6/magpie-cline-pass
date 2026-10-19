import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStoredApiKey } from '../lib/authkey.js'

test('reads the first stored API key for the provider', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-pass-auth-'))
  try {
    fs.writeFileSync(path.join(directory, 'plugin-auth.json'), JSON.stringify({
      cline: { type: 'api', key: 'sk-other' },
      'cline-pass': { type: 'api', key: 'sk-first' },
      'cline-pass#backup': { type: 'api', key: 'sk-second' },
    }))
    assert.equal(readStoredApiKey({ directory, provider: 'cline-pass' }), 'sk-first')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('returns empty for a missing file, provider or non-api login', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-pass-auth-'))
  try {
    assert.equal(readStoredApiKey({ directory, provider: 'cline-pass' }), '')
    fs.writeFileSync(path.join(directory, 'plugin-auth.json'), JSON.stringify({
      'cline-pass': { type: 'oauth', access: 'not-a-key' },
    }))
    assert.equal(readStoredApiKey({ directory, provider: 'cline-pass' }), '')
    assert.equal(readStoredApiKey({ directory: '', provider: 'cline-pass' }), '')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
