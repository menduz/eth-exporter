import * as fs from "fs"
import * as fsp from "fs/promises"
import * as crypto from "crypto"
import ethConnect from "eth-connect"
const { RequestManager, HTTPProvider, BigNumber } = ethConnect
import { log } from "./log.mjs"
import { Options, graph } from "./graph.mjs"
import path from "path"
import undici from "undici"

  ; (globalThis as any).fetch = undici.fetch

const provider = new HTTPProvider("https://cloudflare-eth.com")
provider.debug = true

const requestManagerWithoutCache = new RequestManager(provider)
let currentBlock = new BigNumber("0")

function sleep(ms: number) {
  return new Promise((ok) => setTimeout(ok, ms))
}

export function sha256hash(s: string): string {
  const shasum: crypto.Hash = crypto.createHash("sha256")
  shasum.update(s)
  return shasum.digest("hex").substring(0, 32)
}

export async function ensureCacheDir() {
  if (!fs.existsSync(graph.options.cacheDir)) {
    await fsp.mkdir(graph.options.cacheDir, { recursive: true })
  }
}

export async function fetchWithAttempts(url: string) {
  let attempts = 5
  let time = 1000
  while (attempts) {
    log(`Fetching: %s`, url)
    const req = await undici.fetch(transformCoingeckoUrl(url))
    if (req.ok) {
      const j: any = await req.json()
      if (j.result !== "Max rate limit reached") {
        return j
      }
      console.dir(j)
    } else {

      try {
        console.log(await req.text())
      } catch { }
    }
    attempts--
    await sleep(time)
    time *= 2;
  }
  throw new Error("Attempts exceeded for URL " + url)
}

function transformCoingeckoUrl(url: string): string {
  if (url.startsWith('https://api.coingecko.com/') && graph.options.coingeckoApiKey) {
    const nurl = new URL(url)
    nurl.searchParams.set('x_cg_demo_api_key', graph.options.coingeckoApiKey)
    return nurl.toString()
  }
  return url
}

export async function fetchWithCache<T>(url: string, transform: (data: any, fromCache: boolean) => T): Promise<T> {
  const finalUrl = url
    .replace(":ETHERSCAN_API_KEY:", encodeURIComponent(graph.options.etherscanApiKey!))
    .replace(":COINGECKO_API_KEY:", encodeURIComponent(graph.options.coingeckoApiKey!))
    .replace(":END_BLOCK:", encodeURIComponent(graph.endBlock.toString()))

  const hash = sha256hash(finalUrl)

  async function r(data: any, fromCache: boolean) {
    try {
      const newData = await transform(data, fromCache)
      writeCache(hash, data)
      return newData
    } catch (e) {
      try {
        fs.rmSync(cacheFile(hash))
      } catch { }
      throw e
    }
  }

  if (cacheHit(hash)) {
    return await r(readCache(hash), true)
  } else {
    return await r(await fetchWithAttempts(finalUrl), false)
  }
}

export function writeCache(name: string, data: any) {
  fs.writeFileSync(cacheFile(name), JSON.stringify(data))
}

export function cacheHit(name: string) {
  return fs.existsSync(cacheFile(name))
}

export function readCache(name: string) {
  return JSON.parse(fs.readFileSync(cacheFile(name)).toString())
}

function cacheFile(name: string) {
  return path.join(graph.options.cacheDir, name)
}

export async function setEndBlock(value: string) {
  if (value == "latest") {
    graph.endBlock = new BigNumber(await requestManagerWithoutCache.eth_blockNumber())
  } else {
    const bnValue = new BigNumber(value)
    graph.endBlock = bnValue
  }
}

export async function initFetcher() {
  await ensureCacheDir()
  currentBlock = new BigNumber(await requestManagerWithoutCache.eth_blockNumber())

  if (graph.endBlock.toNumber() < 1) graph.endBlock = currentBlock

  console.assert(currentBlock.toNumber() > 0, 'invalid current block')
  console.log('> Current block: ' + currentBlock.toNumber())
  console.log('> Cutoff block: ' + graph.endBlock)
}
