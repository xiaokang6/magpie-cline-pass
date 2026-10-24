#!/usr/bin/env node
/**
 * Call one magpie plugin tool over the local MCP server, without configuring
 * an agent.
 *
 *   node scripts/magpie-tool.mjs --list
 *   node scripts/magpie-tool.mjs magpie_probe model=glm-5.3
 *   node scripts/magpie-tool.mjs magpie_pin model=glm-5.3 upstreams=zai,baseten pinMode=preferred
 *   node scripts/magpie-tool.mjs magpie_status
 *
 * Arguments are `key=value` pairs (arrays comma-separated, booleans and
 * numbers inferred). A single JSON object is accepted too.
 *
 * @module magpie-cline-pass/scripts/magpie-tool
 */
const DEFAULT_URL = process.env.MAGPIE_MCP_URL || 'http://127.0.0.1:3425/mcp/magpie/tools'
const TIMEOUT_MS = 120000

function usage() {
  console.log(`usage:
  node scripts/magpie-tool.mjs --list
  node scripts/magpie-tool.mjs <tool> [key=value ...]
  node scripts/magpie-tool.mjs <tool> '{"key":"value"}'

Examples:
  node scripts/magpie-tool.mjs magpie_status
  node scripts/magpie-tool.mjs magpie_models filter=glm
  node scripts/magpie-tool.mjs magpie_probe model=deepseek-v4.1-flash-1017 has=vision,implicit-caching
  node scripts/magpie-tool.mjs magpie_validate model=deepseek-v4.1-flash-1017
  node scripts/magpie-tool.mjs magpie_pin model=deepseek-v4.1-flash-1017 upstreams=deepseek has=vision,implicit-caching pinMode=strict

Environment:
  MAGPIE_MCP_URL  default ${DEFAULT_URL}`)
}

async function rpc(method, params) {
  const response = await fetch(DEFAULT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`MCP ${method} answered HTTP ${response.status}: ${text.slice(0, 300)}`)
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    // Streamable HTTP may answer with an SSE frame.
    const line = text.split(/\r?\n/).find((row) => row.startsWith('data:'))
    if (line === undefined) throw new Error(`MCP ${method} returned no JSON: ${text.slice(0, 300)}`)
    payload = JSON.parse(line.slice(5).trim())
  }
  if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error))
  return payload.result
}

function parseValue(key, value) {
  if (key === 'upstreams' || key === 'exclude' || key === 'has') {
    return value.split(',').map((item) => item.trim()).filter(Boolean)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

function parseArguments(tokens) {
  if (tokens.length === 0) return {}
  if (tokens.length === 1 && tokens[0].trim().startsWith('{')) {
    const parsed = JSON.parse(tokens[0])
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON arguments must be an object')
    return parsed
  }
  const output = {}
  for (const token of tokens) {
    const index = token.indexOf('=')
    if (index <= 0) throw new Error(`expected key=value, got ${JSON.stringify(token)}`)
    output[token.slice(0, index)] = parseValue(token.slice(0, index), token.slice(index + 1))
  }
  return output
}

function printResult(text) {
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2))
  } catch {
    console.log(text)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage()
    return
  }

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'magpie-tool', version: '1' },
  })

  if (argv[0] === '--list') {
    const result = await rpc('tools/list', {})
    for (const tool of result.tools ?? []) {
      console.log(`${tool.name}\t${tool.description ?? ''}`)
    }
    return
  }

  const name = argv[0]
  const args = parseArguments(argv.slice(1))
  const result = await rpc('tools/call', { name, arguments: args })
  const parts = Array.isArray(result.content) ? result.content : []
  const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
  if (result.isError) {
    if (text) console.error(text)
    process.exitCode = 1
    return
  }
  printResult(text || JSON.stringify(result))
}

main().catch((error) => {
  console.error(`magpie-tool: ${error?.message ?? error}`)
  console.error('Is magpie running? The MCP server is at ' + DEFAULT_URL)
  process.exitCode = 1
})
