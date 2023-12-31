import { fetchWithCache } from "./fetcher.mjs"
import { Transfer } from "./graph.mjs"

export async function fetchToken1155tx(address: string, startBlock: number | string) {
  const url = `https://api.etherscan.io/api?module=account&action=token1155tx&address=${address}&startblock=${startBlock}&endblock=:END_BLOCK:&sort=asc&apikey=:ETHERSCAN_API_KEY:`
  return await fetchWithCache(url, (ret, fromCache) => {
    if (Array.isArray(ret.result)) {
      return ret.result
    }
    throw new Error(`Error fetching ${url} ${JSON.stringify(ret)} FromCache: ${fromCache}`)
  })
}

export async function fetchErc20Txs(address: string, startBlock: number | string) {
  const url = `https://api.etherscan.io/api?module=account&action=tokentx&address=${address}&startblock=${startBlock}&endblock=:END_BLOCK:&sort=asc&apikey=:ETHERSCAN_API_KEY:`
  return await fetchWithCache(url, (ret, fromCache) => {
    if (Array.isArray(ret.result)) {
      return ret.result
    }
    throw new Error(`Error fetching ${url} ${JSON.stringify(ret)} FromCache: ${fromCache}`)
  })
}

export async function fetchTxs(address: string, startBlock: number | string) {
  const url = `https://api.etherscan.io/api?module=account&action=txlist&address=${address}&startblock=${startBlock}&endblock=:END_BLOCK:&sort=asc&apikey=:ETHERSCAN_API_KEY:`
  return await fetchWithCache(url, (ret, fromCache) => {
    if (Array.isArray(ret.result)) {
      return ret.result
    }
    throw new Error(`Error fetching ${url} ${JSON.stringify(ret)} FromCache: ${fromCache}`)
  })

}

export async function fetchInternalTxs(address: string, startBlock: number | string): Promise<Transfer[]> {
  const url = `https://api.etherscan.io/api?module=account&action=txlistinternal&address=${address}&startblock=${startBlock}&endblock=:END_BLOCK:&sort=asc&apikey=:ETHERSCAN_API_KEY:`
  return await fetchWithCache(url, (ret, fromCache) => {
    if (Array.isArray(ret.result)) {
      return ret.result
    }
    throw new Error(`Error fetching ${url} ${JSON.stringify(ret)} FromCache: ${fromCache}`)
  })
}
