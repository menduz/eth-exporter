import { writeFile } from "fs/promises"
import { fetchErc20Txs, fetchInternalTxs, fetchToken1155tx, fetchTxs } from "./api.mjs"
import { drawGraph, txDate } from "./draw.mjs"
import { requestManager } from "./rpc.mjs"
import ethConnect, { getAddress } from "eth-connect"
const { BigNumber } = ethConnect
import { fetchWithCache } from "./fetcher.mjs"
import { log } from "./log.mjs"

export type Options = {
  output: string
  etherscanApiKey: string | null,
  cacheDir: string
  format: string
  includeFees: boolean
  startDate: Date | null
  endDate: Date | null
  filter: string[]
}

export type Transfer = {
  blockNumber: string
  timeStamp: string
  hash: string
  from: string
  contractAddress: string
  to: string
  value: string
  tokenName?: string // 'Decentraland',
  tokenSymbol?: string // 'MANA',
  tokenDecimal?: string
  input?: string
  gasPrice?: string
  gasUsed?: string
}

export type Account = {
  address: string
  label: string
  added: boolean
  readonly hidden: boolean
  startBlock?: string
}

export const graph = {
  accounts: new Map<string, Account>(),
  transactions: new Map<string /*txid*/, Transfer[]>(),
  hiddenAddressess: new Set<string>(),
  cluster: new Map<string, RegExp>(),
  ignoredSymbols: new Set<string>(),
  allowedContracts: new Map<string, { symbol: string, contract: string, name: string, api_symbol?: string }>(),
  txData: new Map<string, ethConnect.TransactionObject>(),
  receipts: new Map<string, ethConnect.TransactionReceipt>(),
  endBlock: new BigNumber("0"),
  latestTimestamp: new Date(1970, 0, 0),
  prices: new Map<string /* contract */, { stats: [[number, number]], total_volumes: [[number, number]] }>,
  options: {
    cacheDir: ".cache",
    etherscanApiKey: process.env.ETHERSCAN_API_KEY || null,
    format: 'csv',
    includeFees: false,
    output: 'output.csv',
    startDate: null,
    endDate: null,
    filter: []
  } as Options
}

export type Graph = typeof graph

export function normalizeAddress(address: string): string
export function normalizeAddress(address: string | null): string | null
export function normalizeAddress(address: string | null): string | null {
  if (address && address.startsWith('0x'))
    return address?.toLowerCase().trim() ?? null
  return address
}

export function getAccountFromAddress(address: string) {
  const normalizedAddress = normalizeAddress(address)

  if (!graph.accounts.has(normalizedAddress)) {
    const account: Account = {
      address,
      added: false,
      label: address,
      get hidden() {
        return graph.hiddenAddressess.has(normalizedAddress)
      },
    }
    graph.accounts.set(normalizedAddress, account)
  }

  return graph.accounts.get(normalizedAddress)!
}

export function addAccounts(...addr: string[]) {
  return addr.map(($) => getAccountFromAddress($))
}

export function hideAccounts(...addr: string[]) {
  addr.map(normalizeAddress).forEach(($) => graph.hiddenAddressess.add($!))
}

export function setCluster(name: string, regex: RegExp) {
  graph.cluster.set(name, regex)
}

async function ensureErc20Txs(account: string, startBlock: string) {
  const txs: Transfer[] = await fetchErc20Txs(account, startBlock)
  for (let tx of txs) {
    mergeTransactions(graph, tx)
  }
}
async function ensureErc1155Txs(account: string, startBlock: string) {
  const txs: Transfer[] = await fetchToken1155tx(account, startBlock)
  for (let tx of txs) {
    mergeTransactions(graph, tx)
  }
}

function mergeTransactions(graph: Graph, tx: Transfer) {
  const list = graph.transactions.get(tx.hash) || []

  const isPresent = list.some(
    ($) =>
      $.from == tx.from
      && $.to == tx.to
      && $.value == tx.value
      && $.tokenSymbol == tx.tokenSymbol
      && $.contractAddress == tx.contractAddress
  )

  if (!isPresent) {
    if (tx.value != "" && tx.value != "0x0" && tx.value != "0")
      list.push(tx)
  }

  if (list.length) graph.transactions.set(tx.hash, list)
}

async function ensureTxs(account: string, startBlock: string) {
  const txs: Transfer[] = await fetchTxs(account, startBlock)
  for (let tx of txs) {
    mergeTransactions(graph, tx)
  }
}

async function ensureInternalTxs(account: string, startBlock: string) {
  const txs = await fetchInternalTxs(account, startBlock)
  for (let tx of txs) {
    const list = graph.transactions.get(tx.hash) || []
    if (!tx.contractAddress && !tx.tokenSymbol) {
      tx.tokenSymbol = "ETH"
    }
    list.push(tx)
    graph.transactions.set(tx.hash, list)
  }
}

async function fetchRequiredPrices(contract: string) {
  if (graph.prices.has(contract)) return
  const token = graph.allowedContracts.get(contract)

  if (!token || !token.api_symbol) {
    return
  }

  log(`Fetching prices of ${token.contract}\t${token.name}`)

  const result = await fetchWithCache(`https://www.coingecko.com/price_charts/${encodeURIComponent(token.api_symbol)}/usd/custom.json?from=0&to=${(graph.latestTimestamp.getTime() / 1000) | 0}`, a => a)

  graph.prices.set(token.contract, result)
}

export async function processGraph() {
  const initialAccounts = new Set(graph.accounts.values())

  console.log("> Fetching allowed tokens from coingecko")
  const symbols: any[] = await fetchWithCache("https://api.coingecko.com/api/v3/coins/list?include_platform=true", a => a)
  const allowed = symbols.filter(x => 'ethereum' in x.platforms)

  allowed.forEach(x => {
    graph.allowedContracts.set(normalizeAddress(x.platforms.ethereum), {
      contract: x.platforms.ethereum,
      name: x.name,
      symbol: x.symbol.toUpperCase()
    })
  })

  console.time("> Fetching accounts transaction list")
  for (let acc of initialAccounts) {
    if (acc.added) {
      await ensureErc20Txs(acc.address, acc.startBlock || "0")
      await ensureErc1155Txs(acc.address, acc.startBlock || "0")
      await ensureTxs(acc.address, acc.startBlock || "0")
      await ensureInternalTxs(acc.address, acc.startBlock || "0")
    }
  }
  console.timeEnd("> Fetching accounts transaction list")

  console.time("> Fetching transaction details")
  for (const [tx, data] of graph.transactions) {
    const txData = await requestManager.eth_getTransactionByHash(tx)
    graph.txData.set(tx, txData)

    if (!graph.receipts.has(tx) && getAccountFromAddress(txData.from).added) {
      const receipt = await requestManager.eth_getTransactionReceipt(tx)
      graph.receipts.set(tx, receipt)
    }
  }
  console.timeEnd("> Fetching transaction details")

  const hasBalanceOf = new Set<string /* contract */>()

  // find latest tx timestamp
  Array.from(graph.transactions.values()).flat().forEach(tx => {
    const date = new Date(parseInt(tx.timeStamp) * 1000)
    if (date > graph.latestTimestamp) graph.latestTimestamp = date
    // find all contracts with changes of balance
    const contract = normalizeAddress(tx.contractAddress)
    hasBalanceOf.add(contract)
  })

  {
    // coingecko top1000 list
    const result = await fetchWithCache(`https://api.coingecko.com/api/v3/search?from=0&to=${(graph.latestTimestamp.getTime() / 1000) | 0}`, a => a)
    const { coins } = result

    for (const [_, contract] of graph.allowedContracts) {
      const found = coins.find(($: any) => $.symbol.toUpperCase() == contract.symbol.toUpperCase())
      if (found) {
        contract.api_symbol = found.api_symbol
      }
    }
  }


  for (const contract of hasBalanceOf) {
    await fetchRequiredPrices(contract)
  }

  {
    const result = await fetchWithCache(`https://www.coingecko.com/price_charts/bitcoin/usd/custom.json?from=0&to=${(graph.latestTimestamp.getTime() / 1000) | 0}`, a => a)
    graph.prices.set('btc', result)
  }

  {
    const result = await fetchWithCache(`https://www.coingecko.com/price_charts/ethereum/usd/custom.json?from=0&to=${(graph.latestTimestamp.getTime() / 1000) | 0}`, a => a)
    graph.prices.set('eth', result)
  }

  // for (let [tx] of graph.transactions) {
  //   await getEventsWithCache(tx)
  // }
}

export function getSender(graph: Graph, hash: string) {
  const tx = graph.transactions.get(hash)
  if (tx?.length) {
    return normalizeAddress(tx[0].from)
  }
  return "unknown"
}

export function operationTypeBySelector(data: string) {

  switch (true) {
    case data == "0x":
      return "Transfer" // eth
    case data.startsWith("0xa9059cbb"):
      return "Transfer" // erc20
    case data.startsWith("0x85f6d155"):
      return "Transfer" // ENS: Register
    case data.startsWith("0x1cff79cd"):
    case data.startsWith("0xf88bf15a"):
      return "Liquidity event" // "Balancer: Execute"
    case data.startsWith("0x86d1a69f"): // vesting release
    case data.startsWith("0xc01a8c84"): // vesting terminate
      return "Vesting"
    case data.startsWith("0xacf1a841"):
      return "ENS: Renew"
    case data.startsWith("0x18cbafe5"):
    case data.startsWith("0x3d8d4082"): // executeMetaTransactionV2(tuple mtx,tuple signature)
    case data.startsWith("0x2e95b6c8"):
    case data.startsWith("0x13d79a0b"):
    case data.startsWith("0xd0e30db0"): // deposit() (WETH)
    case data.startsWith("0x38ed1739"):
    case data.startsWith("0x4f948110"):
    case data.startsWith("0x34b0793b"): // discountedSwap(address caller,tuple desc,tuple[] calls)
    case data.startsWith("0xfb3bdb41"): // swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)
    case data.startsWith("0xaa77476c"): // fillRfqOrder(tuple order,tuple signature,uint128 takerTokenFillAmount)
    case data.startsWith("0x5cf54026"):
    case data.startsWith("0x7a1eb1b9"):
    case data.startsWith("0x0f3b31b2"): // multiplexMultiHopSellTokenForToken(address[] tokens,tuple[] calls,uint256 sellAmount,uint256 minBuyAmount) ***
    case data.startsWith("0x7c025200"):
    case data.startsWith("0xa578efaf"):
    case data.startsWith("0x3598d8ab"): // sellEthForTokenToUniswapV3
    case data.startsWith("0xd9627aa4"):
    case data.startsWith("0xf88309d7"):
    case data.startsWith("0x90411a32"): // swap(address caller,tuple desc,tuple[] calls)
    case data.startsWith("0xfbabdebd"): // swapSaiToDai(uint256 wad)
    case data.startsWith("0x77725df6"): // Swap (ETH)
    case data.startsWith("0xcb3c28c7"): // trade(address src, uint256 srcAmount, address dest, address destAddress, uint256 maxDestAmount, uint256 minConversionRate, address walletId)
    case data.startsWith("0x2e1a7d4d"): // withdraw weth->eth
      return "Swap"
    case data.startsWith("0xdb1b6948"):
      return "Transfer" // Stake
    case data.startsWith("0xc73a2d60"):
      return "Crowdsale"
    case data.startsWith("0xb02f0b73"):
      return "Transfer" // Unstake
    case data.startsWith("0xd35ab3f1"):
      return "Swap" // Convert DG to new DG
    case data.startsWith("0x6a761202"):
      return "Gnosis: Exec"
    case data.startsWith("0x13d98d13"): // Tornado: Deposit
    case data.startsWith("0x74bd0ace"): // sellNXMTokens(uint256 _amount) (NXM pool)
    case data.startsWith("0x439370b1"): // depositEth()
      return "Transfer"
  }

  return data.substring(0, 10)
}

export function operationType(graph: Graph, tx: string) {
  const data = graph.txData.get(tx)?.input.toLowerCase() || ""
  return operationTypeBySelector(data)
}

export async function dumpGraph(filename: string) {
  const dot = drawGraph(graph)
  await writeFile(filename, dot)
}

export function filterTransfer($: Transfer) {
  const date = new Date(1000 * +$.timeStamp)

  if (graph.options.startDate && date < graph.options.startDate) return false
  if (graph.options.endDate && date > graph.options.endDate) return false

  if (graph.ignoredSymbols.has(normalizeAddress($.contractAddress))) return false
  if (graph.ignoredSymbols.has($.tokenSymbol || "ETH")) return false

  if ($.contractAddress && !graph.allowedContracts.has(normalizeAddress($.contractAddress))) {
    return false
  }

  return true
}