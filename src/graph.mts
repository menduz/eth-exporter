import { writeFile } from 'fs/promises'
import { fetchErc20Txs, fetchInternalTxs, fetchToken1155tx, fetchTxs } from './api.mjs'
import { drawGraph } from './draw.mjs'
import { requestManager } from './rpc.mjs'
import ethConnect from 'eth-connect'
const { BigNumber } = ethConnect
import { fetchWithCache } from './fetcher.mjs'
import { log } from './log.mjs'

export type Options = {
  output: string
  etherscanApiKey: string | null
  coingeckoApiKey: string | null
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
  allowedContracts: new Map<
    string,
    { symbol: string; contract: string; name: string; coingeckoId?: string; present: boolean }
  >(),
  txData: new Map<string, ethConnect.TransactionObject>(),
  receipts: new Map<string, ethConnect.TransactionReceipt>(),
  endBlock: new BigNumber('0'),
  latestTimestamp: new Date(1970, 0, 0),
  prices: new Map<string /* contract */, { prices: number[][] }>(),
  selectors: new Map<string, string>(),
  options: {
    cacheDir: '.cache',
    etherscanApiKey: process.env.ETHERSCAN_API_KEY || null,
    coingeckoApiKey: process.env.COINGECKO_API_KEY || null,
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
  if (address && address.startsWith('0x')) return address?.toLowerCase().trim() ?? null
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
      }
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
      $.from == tx.from &&
      $.to == tx.to &&
      $.value == tx.value &&
      $.tokenSymbol == tx.tokenSymbol &&
      $.contractAddress == tx.contractAddress
  )

  if (!isPresent) {
    if (tx.value != '' && tx.value != '0x0' && tx.value != '0') list.push(tx)
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
      tx.tokenSymbol = 'ETH'
    }
    list.push(tx)
    graph.transactions.set(tx.hash, list)
  }
}

async function fetchRequiredPrices(contract: string) {
  if (graph.prices.has(contract)) return
  const token = graph.allowedContracts.get(contract)

  if (!token || !token.coingeckoId) {
    return
  }

  await fetchSymbolMarketData(token.coingeckoId, contract)
}

async function fetchPricesCoinGeckoHistorical(symbol: string): Promise<{ prices: number[][] }> {
  const result = await fetchWithCache(
    `https://www.coingecko.com/price_charts/export/${encodeURIComponent(
      symbol
    )}/usd.csv?utm_source=${graph.latestTimestamp.toISOString().replace(/\..*/, '')}`,
    (a) => a
  )
  const lines: any[][] = []

  if (typeof result == 'string') {
    result.split(/\n/g).forEach((line) => lines.push(line.split(/[,\t]/g)))
  }

  if (result === null) {
    log(`Prices not available for ${symbol}`)
    return { prices: [] }
  }

  if (lines.length <= 1) {
    console.log(`! Error fetching prices of ${symbol} (), empty result`)
    console.dir(result)
    return { prices: [] }
  }

  // remove NaN prices (including header) and coerce types
  const prices = lines
    .filter(($) => $.length && !isNaN($[1]))
    .map((line) => {
      // convert first element to timestamp
      const [date, time] = line[0].split(' ')
      return [new Date(`${date}T${time}Z`).getTime(), +line[1]]
    })

  return { prices }
}

async function fetchPricesCoinGeckoApi(symbol: string, year: number): Promise<{ prices: [number, number][] }> {
  const yearStartTimestamp = (new Date(year, 0, 0).getTime() / 1000) | 0
  const thisYear = year == new Date().getFullYear()

  const endDate = thisYear ? new Date() : new Date(year + 1, 0, 0)
  const yearEndTimestamp = ((endDate.getTime() / 1000) | 0) - 86400 // (-1 day)

  const result = await fetchWithCache(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(
      symbol
    )}/market_chart/range?vs_currency=usd&to=${yearEndTimestamp}&from=${yearStartTimestamp}`,
    (a) => a
  )

  if (!result.prices.length) {
    console.log(`! Error fetching prices of ${symbol} (${year}), empty result`)
    console.dir(result)
  }

  return result
}

async function fetchSymbolMarketData(symbol: string, contract: string) {
  // find all the years in which a transaction is present
  // const years = new Set(
  //   Array.from(graph.transactions.values())
  //     .flat()
  //     .map((tx) => new Date(parseInt(tx.timeStamp) * 1000).getFullYear())
  // )

  //  const prices = new Map<number /* timestamp */, number /* price */>()

  // for (const year of years) {
  //   const result = await fetchPricesCoincodex(symbol, year)
  //
  //   result.prices.forEach(([timestamp, price]: [number, number]) => {
  //     prices.set(timestamp, price)
  //   })
  // }

  const result = await fetchPricesCoinGeckoHistorical(symbol)

  if (!result.prices.length) {
    console.log(`! Error fetching prices of ${symbol}, empty result`)
    console.dir(result)
  }

  graph.prices.set(contract, result)
}

export async function processGraph() {
  const initialAccounts = new Set(graph.accounts.values())

  console.log('> Fetching allowed tokens from coingecko')
  const symbols: any[] = await fetchWithCache(
    `https://api.coingecko.com/api/v3/coins/list?include_platform=true&x_to_block=${graph.endBlock}`,
    (a) => a
  )
  const allowed = symbols.filter((x) => 'ethereum' in x.platforms)

  allowed.forEach((x) => {
    const addr = normalizeAddress(x.platforms.ethereum)
    const contractAccount = graph.accounts.get(addr)

    graph.allowedContracts.set(addr, {
      contract: x.platforms.ethereum,
      name: x.name,
      symbol: contractAccount?.label || x.symbol.toUpperCase(),
      coingeckoId: x.id,
      present: false
    })

    const acct = getAccountFromAddress(addr)
    if (acct.label == addr) {
      acct.label = `equity:trading:${x.symbol.toUpperCase()}-${x.id}`
    }
  })

  console.time('> Fetching accounts transaction list')
  for (let acc of initialAccounts) {
    if (acc.added) {
      await ensureErc20Txs(acc.address, acc.startBlock || '0')
      await ensureErc1155Txs(acc.address, acc.startBlock || '0')
      await ensureTxs(acc.address, acc.startBlock || '0')
      await ensureInternalTxs(acc.address, acc.startBlock || '0')
    }
  }
  console.timeEnd('> Fetching accounts transaction list')

  console.time('> Fetching transaction details')
  for (const [tx, data] of graph.transactions) {
    const txData = await requestManager.eth_getTransactionByHash(tx)
    graph.txData.set(tx, txData)

    if (!graph.receipts.has(tx) && getAccountFromAddress(txData.from).added) {
      const receipt = await requestManager.eth_getTransactionReceipt(tx)
      graph.receipts.set(tx, receipt)
    }
  }
  console.timeEnd('> Fetching transaction details')

  const hasBalanceOf = new Set<string /* contract */>()

  // find latest tx timestamp
  Array.from(graph.transactions.values())
    .flat()
    .forEach((tx) => {
      const date = new Date(parseInt(tx.timeStamp) * 1000)
      if (date > graph.latestTimestamp) graph.latestTimestamp = date
      // find all contracts with changes of balance
      const contract = normalizeAddress(tx.contractAddress)
      hasBalanceOf.add(contract)
    })

  console.time('> Fetching historical prices')
  {
    for (const contract of hasBalanceOf) {
      await fetchRequiredPrices(contract)
    }

    await fetchSymbolMarketData('bitcoin', 'BTC')
    await fetchSymbolMarketData('ethereum', 'ETH')
  }
  console.timeEnd('> Fetching historical prices')

  printUnknownSelectors()

  // for (let [tx] of graph.transactions) {
  //   await getEventsWithCache(tx)
  // }
}

export function getSender(graph: Graph, hash: string) {
  const tx = graph.transactions.get(hash)
  if (tx?.length) {
    return normalizeAddress(tx[0].from)
  }
  return 'unknown'
}

const unknownSelectors: Record<string, Set<string>> = {}

export function operationTypeBySelector(data: string, tx: string) {
  const selector = data.substring(0, 10).toLowerCase()

  const store_value = graph.selectors.get(selector)
  if (store_value !== null && store_value !== undefined) return store_value

  switch (true) {
    case data == '0x':
      return 'Transfer' // eth
    case data.startsWith('0xa9059cbb'):
      return 'Transfer' // erc20
    case data.startsWith('0x85f6d155'):
      return 'Transfer' // ENS: Register
    case data.startsWith('0xc9a48e6f'):
    case data.startsWith('0x1cff79cd'):
    case data.startsWith('0xf88bf15a'):
      return 'Liquidity event' // "Balancer: Execute"
    case data.startsWith('0x86d1a69f'): // vesting release
    case data.startsWith('0xc01a8c84'): // vesting terminate
      return 'Vesting'
    case data.startsWith('0xacf1a841'):
      return 'ENS: Renew'
    case data.startsWith('0x18cbafe5'):
    case data.startsWith('0x3d8d4082'): // executeMetaTransactionV2(tuple mtx,tuple signature)
    case data.startsWith('0x2e95b6c8'):
    case data.startsWith('0x13d79a0b'):
    case data.startsWith('0xd0e30db0'): // deposit() (WETH)
    case data.startsWith('0x38ed1739'):
    case data.startsWith('0x4f948110'):
    case data.startsWith('0x34b0793b'): // discountedSwap(address caller,tuple desc,tuple[] calls)
    case data.startsWith('0xfb3bdb41'): // swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)
    case data.startsWith('0xaa77476c'): // fillRfqOrder(tuple order,tuple signature,uint128 takerTokenFillAmount)
    case data.startsWith('0x5cf54026'):
    case data.startsWith('0x7a1eb1b9'):
    case data.startsWith('0x0f3b31b2'): // multiplexMultiHopSellTokenForToken(address[] tokens,tuple[] calls,uint256 sellAmount,uint256 minBuyAmount) ***
    case data.startsWith('0x7c025200'):
    case data.startsWith('0xe9383a68'):
    case data.startsWith('0x3593564c'):
    case data.startsWith('0xa578efaf'):
    case data.startsWith('0x3598d8ab'): // sellEthForTokenToUniswapV3
    case data.startsWith('0xd9627aa4'):
    case data.startsWith('0xf88309d7'):
    case data.startsWith('0x90411a32'): // swap(address caller,tuple desc,tuple[] calls)
    case data.startsWith('0xfbabdebd'): // swapSaiToDai(uint256 wad)
    case data.startsWith('0x77725df6'): // Swap (ETH)
    case data.startsWith('0xcb3c28c7'): // trade(address src, uint256 srcAmount, address dest, address destAddress, uint256 maxDestAmount, uint256 minConversionRate, address walletId)
    case data.startsWith('0x2e1a7d4d'): // withdraw weth->eth
      return 'Swap'
    case data.startsWith('0x1a695230'):
    case data.startsWith('0xdb1b6948'):
      return 'Transfer' // Stake
    case data.startsWith('0xc73a2d60'):
      return 'Crowdsale'
    case data.startsWith('0xb02f0b73'):
      return 'Transfer' // Unstake
    case data.startsWith('0xc8a397a8'):
    case data.startsWith('0xd35ab3f1'):
      return 'Swap' // Convert DG to new DG
    case data.startsWith('0x6a761202'):
      return 'Gnosis: Exec'
    case data.startsWith('0x13d98d13'): // Tornado: Deposit
    case data.startsWith('0x439370b1'): // depositEth()
      return 'Transfer'
  }

  unknownSelectors[selector] = unknownSelectors[selector] ?? new Set()
  unknownSelectors[selector].add(tx)

  return data.substring(0, 10)
}

export function printUnknownSelectors() {
  for (let [_, txlist] of graph.transactions) {
    for (let tx of txlist) {
      if (!filterTransfer(tx)) continue

      operationType(graph, tx.hash)
    }
  }

  const entries = Object.entries(unknownSelectors).sort(([_, a], [__, b]) => (a.size < b.size ? 1 : -1))

  function first([a]: any) {
    return a
  }

  if (entries.length) {
    console.log('! Unknown selectors')
    entries.forEach(([selector, set]) => console.log(`  ${selector}: ${set.size} occurences, eg: ${first(set)}`))
  }
}

export function operationType(graph: Graph, tx: string) {
  const data = graph.txData.get(tx)?.input.toLowerCase() || ''
  return operationTypeBySelector(data, tx)
}

export async function dumpGraph(filename: string) {
  const dot = drawGraph(graph)
  await writeFile(filename, dot)
}

export function filterTransfer($: Transfer) {
  const date = new Date(1000 * +$.timeStamp)

  if (graph.options.startDate && date < graph.options.startDate) return false
  if (graph.options.endDate && date > graph.options.endDate) return false

  if (graph.accounts.get(normalizeAddress($.from))?.hidden) return false
  if (graph.ignoredSymbols.has(normalizeAddress($.contractAddress))) return false
  if (graph.ignoredSymbols.has($.tokenSymbol || 'ETH')) return false

  const contract = graph.allowedContracts.get(normalizeAddress($.contractAddress))
  const added = graph.accounts.has(normalizeAddress($.contractAddress))

  if ($.contractAddress && !contract && !added) {
    return false
  }

  if (contract) {
    contract.present = true
  }

  return true
}
