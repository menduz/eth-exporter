import ethConnect from "eth-connect"
import { InternalTx } from "./api.mjs"
import { txValue } from "./draw.mjs"
import { Account, filterTransfer, getAccountFromAddress, Graph, normalizeAddress, operationType, Options, Transfer } from "./graph.mjs"
import { inspect } from "util"

export type LineItemChange = {
  tx: string
  accountDebit: Account
  accountCredit: Account
  symbol: string
  amount: ethConnect.BigNumber
  originalTx: Transfer | InternalTx
  contractAddress: null | string
}

export type LineItem = {
  date: Date
  changes: LineItemChange[]
  fees: ethConnect.BigNumber
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
  txs: (Transfer | InternalTx)[]
}

export type DoubleEntryResult = ReturnType<typeof doubleEntryFromGraph>

export function doubleEntryFromGraph(graph: Graph) {
  const balancesAt = new Map<number, Record<string, number>>()

  function setBalancesAt(date: Date, balances: Record<string, number>) {
    balancesAt.set(date.getTime(), { ...balances })
  }

  function getBalancesAt(searchDate: Date): { date: Date; balances: Record<string, number> } {
    let sortedKeys = Array.from(balancesAt.keys()).sort().reverse()
    for (const key of sortedKeys) {
      if (key <= searchDate.getTime()) {
        return { date: new Date(key), balances: balancesAt.get(key)! }
      }
    }
    return { date: searchDate, balances: {} }
  }

  const lineItems = new Map<string, LineItem>()
  const contractToToken = new Map<string, string>()
  const unknownAccounts = new Set<string>()

  function addLineItem(transfer: Transfer | InternalTx) {
    const accountFrom = getAccountFromAddress(transfer.from)
    const accountTo = getAccountFromAddress(transfer.to)

    if (accountFrom.label === accountFrom.address) unknownAccounts.add(accountFrom.address)
    if (accountTo.label === accountTo.address) unknownAccounts.add(accountTo.address)

    if (!lineItems.has(transfer.hash)) {
      lineItems.set(transfer.hash, {
        changes: [],
        date: new Date(parseInt(transfer.timeStamp) * 1000),
        fees: new ethConnect.BigNumber(0),
      })
    }

    const lineItem = lineItems.get(transfer.hash)!

    lineItem.changes.push({
      tx: transfer.hash,
      accountDebit: accountFrom,
      accountCredit: accountTo,
      symbol: transfer.tokenSymbol || "ETH",
      amount: txValue(transfer),
      contractAddress: normalizeAddress(transfer.contractAddress),
      originalTx: transfer,
    })

    if (transfer.contractAddress) {
      if (
        !graph.ignoredSymbols.has(normalizeAddress(transfer.contractAddress)) &&
        !graph.ignoredSymbols.has(transfer.tokenSymbol || "????????")
      ) {
        const prev = contractToToken.get(normalizeAddress(transfer.contractAddress))
        const symbol = transfer.tokenSymbol || "????"
        if (prev && prev !== symbol) {
          console.dir({ prev, symbol, transfer })
          throw new Error("OOPS")
        }
        contractToToken.set(normalizeAddress(transfer.contractAddress), symbol)
      }
    }

    if ('gasPrice' in transfer && lineItem.fees.eq(0))
      lineItem.fees = new ethConnect.BigNumber(+transfer.gasUsed).multipliedBy(transfer.gasPrice)
  }


  // add all line items
  const alltx: (Transfer | InternalTx)[] = []
  Array.from(graph.transactions.values()).forEach((txlist) => alltx.push(...txlist))
  Array.from(graph.internalTxs.values()).forEach((txlist) => alltx.push(...txlist))
  const txs = alltx
    .sort((a, b) => (parseInt(a.timeStamp) > parseInt(b.timeStamp) ? 1 : -1))
    .filter(filterTransfer)
  txs.forEach(addLineItem)

  // include fees as line item
  if (graph.options.includeFees) {
    const feesAccount = getAccountFromAddress('0x0000000000000000000000000000000000000000')
    for (const [_, lineItem] of lineItems) {
      const [{ originalTx }] = lineItem.changes
      const accountFrom = getAccountFromAddress(originalTx.from)

      if (accountFrom.added) {
        lineItem.changes.push({
          tx: originalTx.hash,
          accountDebit: accountFrom,
          accountCredit: feesAccount,
          symbol: "ETH",
          contractAddress: null,
          amount: lineItem.fees.shiftedBy(-18),
          originalTx,
        })
      }
    }
  }

  function key(acct: string, symbol: string) {
    return `${symbol}-${acct}`
  }

  return {
    getBalancesAt,
    lineItems,
    contractToToken,
    unknownAccounts,
    txs,
  }
}
