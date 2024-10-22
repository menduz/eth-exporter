import ethConnect, { BigNumber } from 'eth-connect'
import { txValue } from './draw.mjs'
import { Account, filterTransfer, getAccountFromAddress, Graph, normalizeAddress, Transfer } from './graph.mjs'
import { fetchWithAttempts } from './fetcher.mjs'
import { memoize } from './memoize.js'
import { log } from './log.mjs'

export type LineItemChange = {
  tx: string
  accountDebit: Account
  accountCredit: Account
  symbol: string
  amount: ethConnect.BigNumber
  originalTx: Transfer
  contractAddress: null | string
  isFee: boolean
}

export type LineItem = {
  date: Date
  changes: LineItemChange[]
  fees: ethConnect.BigNumber

  /** Net changes of any account of the lineitem */
  netChanges: Map<string, Map<string, ethConnect.BigNumber>>

  /** Net changes of added accounts */
  selfAccountNetChanges: Map<string, Map<string, ethConnect.BigNumber>>

  /** whether the line item looks like a swap */
  apparentSwap: boolean
}

export type TradeRecord = {
  credit: Record<string, number>
  debit: Record<string, number>
}

export type LineItemColumn = {
  date: Date
  tx: string
  type: string
  /** <TOKEN-slug,amount> */
  changes: Record<string, number>
  trade: null | TradeRecord
  lineItem: LineItem
  txs: Transfer[]
}

export type DoubleEntryResult = ReturnType<typeof doubleEntryFromGraph>

export function changeTracker(requiredAccounts: Set<Account>) {
  const netChanges: Map<string, Map<string, ethConnect.BigNumber>> = new Map()

  function delta(account: Account, symbol: string, amt: ethConnect.BigNumber) {
    const a = normalizeAddress(account.address)

    requiredAccounts.add(account)

    if (!netChanges.has(a)) netChanges.set(a, new Map())

    if (!netChanges.get(a)!.has(symbol)) netChanges.get(a)!.set(symbol, new ethConnect.BigNumber(0))
    {
      const curr = netChanges.get(a)!.get(symbol)!
      netChanges.get(a)!.set(symbol, curr.plus(amt))
    }
    return a
  }

  return {
    delta,
    netChanges
  }
}

export function doubleEntryFromGraph(graph: Graph) {
  const lineItems = new Map<string, LineItem>()
  const contractToToken = new Map<string, string>()
  const unknownAccounts = new Set<string>()
  const foundCommodities = new Set<string>()

  const requiredAccounts = new Set<Account>()

  function addLineItem(transfer: Transfer) {
    const accountFrom = getAccountFromAddress(transfer.from)
    const accountTo = getAccountFromAddress(transfer.to)

    if (accountFrom.hidden || accountTo.hidden) return

    if (accountFrom.label === accountFrom.address) unknownAccounts.add(accountFrom.address)
    if (accountTo.label === accountTo.address) unknownAccounts.add(accountTo.address)

    if (!lineItems.has(transfer.hash)) {
      lineItems.set(transfer.hash, {
        changes: [],
        date: new Date(parseInt(transfer.timeStamp) * 1000),
        fees: new ethConnect.BigNumber(0),
        netChanges: new Map(),
        selfAccountNetChanges: new Map(),
        apparentSwap: false
      })
    }

    const lineItem = lineItems.get(transfer.hash)!

    const data = graph.receipts.get(transfer.hash)

    if (data) {
      const fees = new ethConnect.BigNumber(data.gasUsed).multipliedBy(
        ethConnect.toDecimal((data as any).effectiveGasPrice ?? '0x0')
      )
      if (fees.gt(lineItem.fees)) {
        lineItem.fees = fees
      }
    }

    if (!lineItem.changes.some(($) => JSON.stringify($.originalTx) == JSON.stringify(transfer))) {
      lineItem.changes.push({
        tx: transfer.hash,
        accountDebit: accountFrom,
        accountCredit: accountTo,
        symbol: transfer.tokenSymbol || 'ETH',
        amount: txValue(transfer),
        contractAddress: normalizeAddress(transfer.contractAddress),
        originalTx: transfer,
        isFee: false
      })
    }

    if (transfer.contractAddress) {
      if (
        !graph.ignoredSymbols.has(normalizeAddress(transfer.contractAddress)) &&
        !graph.ignoredSymbols.has(transfer.tokenSymbol || '????????')
      ) {
        const prev = contractToToken.get(normalizeAddress(transfer.contractAddress))
        const symbol = transfer.tokenSymbol || '????'
        if (prev && prev !== symbol) {
          console.dir({ prev, symbol, transfer })
          throw new Error('OOPS')
        }
        contractToToken.set(normalizeAddress(transfer.contractAddress), symbol)
      }
    }
  }

  // add all line items
  const alltx: Transfer[] = []
  Array.from(graph.transactions.values()).forEach((txlist) => alltx.push(...txlist))
  const txs = alltx.sort((a, b) => (parseInt(a.timeStamp) > parseInt(b.timeStamp) ? 1 : -1)).filter(filterTransfer)

  txs.forEach(addLineItem)

  // include fees as line item
  if (graph.options.includeFees) {
    for (const [hash, lineItem] of lineItems) {
      const tx = graph.txData.get(hash)

      if (tx) {
        const accountFrom = getAccountFromAddress(tx.from)
        const [{ originalTx }] = lineItem.changes
        if (accountFrom.added && lineItem.fees.gt(0)) {
          const feesAccount = getAccountFromAddress('0x0000000000000000000000000000000000000000')
          lineItem.changes.push({
            tx: hash,
            accountDebit: accountFrom,
            accountCredit: feesAccount,
            symbol: 'ETH',
            contractAddress: null,
            amount: lineItem.fees.shiftedBy(-18),
            originalTx,
            isFee: true
          })
        }
      }
    }
  }

  Array.from(lineItems.entries()).map(([_tx, item]) => {
    const txChanges = changeTracker(requiredAccounts)
    const selfAccountChanges = changeTracker(requiredAccounts)

    for (const $ of item.changes) {
      if (!$.accountDebit.added && !$.accountCredit.added) continue

      if ($.isFee) continue

      const contract = $.contractAddress ? graph.allowedContracts.get(normalizeAddress($.contractAddress)) : null
      const symbol = contract?.symbol || $.symbol

      txChanges.delta($.accountDebit, symbol, $.amount.negated())
      txChanges.delta($.accountCredit, symbol, $.amount)

      if ($.accountCredit.added) selfAccountChanges.delta($.accountCredit, symbol, $.amount)
      if ($.accountDebit.added) selfAccountChanges.delta($.accountDebit, symbol, $.amount.negated())

      foundCommodities.add(symbol)
    }

    item.netChanges = txChanges.netChanges
    item.selfAccountNetChanges = selfAccountChanges.netChanges

    if (item.selfAccountNetChanges.size == 1) {
      const [[_address, changes]] = item.selfAccountNetChanges

      if (changes.size == 2) {
        const [a, b] = changes
        item.apparentSwap = a[1].isPositive() != b[1].isPositive()
      }
    }
  })

  function addressBySymbol(symbol: string) {
    for (const [addr, c] of graph.allowedContracts) {
      if (c.symbol == symbol && graph.prices.has(addr)) return addr
    }
    return null
  }

  function latestPrice(symbol: string) {
    if (stablecoins.has(symbol.toUpperCase())) return ethConnect.BigNumber(1)

    const prices = graph.prices.get(symbol) ?? graph.prices.get(addressBySymbol(symbol)!)
    if (prices?.prices) {
      return prices.prices[prices.prices.length - 1][1]
    }
    return Number.NaN
  }

  const stablecoins = new Set(['DAI', 'USD', 'USDC', 'USDT'])

  function priceAt(symbol: string, date: Date): [number, ethConnect.BigNumber] {
    if (stablecoins.has(symbol.toUpperCase())) return [(new Date().getTime() / 1000) >>> 0, ethConnect.BigNumber(1)]

    const prices = graph.prices.get(symbol) ?? graph.prices.get(addressBySymbol(symbol)!)
    if (prices?.prices) {
      const dateNum = date.getTime()
      const list = prices.prices.filter(([when]) => when <= dateNum)
      if (!list.length) {
        console.dir({ ...prices, dateNum, symbol })
        return [0, ethConnect.BigNumber(Number.NaN)]
      }
      return list[list.length - 1]
    }

    return [0, ethConnect.BigNumber(Number.NaN)]
  }

  function getContractFromSymbol(symbol: string): null | string {
    if (symbol.toUpperCase() == 'ETH' || symbol.toUpperCase() == 'BTC' || symbol.toUpperCase() == 'USD') {
      return symbol
    }

    if (symbol.startsWith('0x')) return symbol

    const addr = addressBySymbol(symbol)
    if (addr != symbol) return addr
    return null
  }

  return {
    lineItems,
    contractToToken,
    unknownAccounts,
    foundCommodities,
    // set of accounts appearing in movements
    requiredAccounts,
    txs,
    priceAt,
    latestPrice,
    addressBySymbol,
    getContractFromSymbol
  }
}
