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

  function addLineItem(transfer: Transfer) {
    const accountFrom = getAccountFromAddress(transfer.from)
    const accountTo = getAccountFromAddress(transfer.to)

    const someAdded = accountFrom.added || accountTo.added

    if (!someAdded && (accountFrom.hidden || accountTo.hidden) || accountFrom == accountTo) return

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

    if (
      !graph.ignoredSymbols.has(normalizeAddress(transfer.contractAddress)) &&
      !graph.ignoredSymbols.has(transfer.tokenSymbol || "????????")
    ) {
      const prev = contractToToken.get(normalizeAddress(transfer.contractAddress))
      const symbol = transfer.tokenSymbol || "????"
      if (prev && prev !== symbol) throw new Error("OOPS")
      contractToToken.set(normalizeAddress(transfer.contractAddress), symbol)
    }

    const internalTxs = graph.internalTxs.get(transfer.hash)!
    if (internalTxs) {
      for (let tx of internalTxs) {
        const accountDebit = getAccountFromAddress(transfer.to)
        const accountCredit = getAccountFromAddress(transfer.from)

        if (accountDebit.label === accountDebit.address) unknownAccounts.add(accountDebit.address)
        if (accountCredit.label === accountCredit.address) unknownAccounts.add(accountCredit.address)

        lineItem.changes.push({
          tx: transfer.hash,
          accountDebit,
          accountCredit,
          symbol: tx.tokenSymbol || normalizeAddress(tx.contractAddress),
          contractAddress: normalizeAddress(tx.contractAddress),
          amount: txValue(tx),
          originalTx: tx,
        })
      }
    }

    lineItem.fees = lineItem.fees.plus(new ethConnect.BigNumber(transfer.gasUsed).multipliedBy(transfer.gasPrice))

    if (accountFrom.added && graph.options.includeFees) {
      const feesAccount = getAccountFromAddress('0x0000000000000000000000000000000000000000')
      lineItem.changes.push({
        tx: transfer.hash,
        accountDebit: accountFrom,
        accountCredit: feesAccount,
        symbol: "ETH",
        contractAddress: null,
        amount: lineItem.fees.shiftedBy(-18),
        originalTx: transfer,
      })
    }
  }

  const alltx: Transfer[] = []

  Array.from(graph.transactions.values()).forEach((txlist) => alltx.push(...txlist))

  const txs = alltx
    .sort((a, b) => (parseInt(a.timeStamp) > parseInt(b.timeStamp) ? 1 : -1))
    .filter(filterTransfer)

  txs.forEach(addLineItem)

  function key(acct: string, symbol: string) {
    return `${symbol}-${acct}`
  }

  const calculatedLineItems: LineItemColumn[] = []
  const columns: string[] = []
  const finalBalance: Record<string, number> = {}

  for (const [_, lineItem] of lineItems) {
    const txs: (Transfer | InternalTx)[] = []
    const doubleEntryLine: LineItemColumn = {
      date: lineItem.date,
      tx: "",
      type: "",
      changes: {},
      trade: null,
      lineItem,
      txs
    }

    for (let change of lineItem.changes) {
      doubleEntryLine.tx = change.tx
      txs.push(change.originalTx)
      doubleEntryLine.type = doubleEntryLine.type || operationType(graph, change.originalTx.hash)

      if (doubleEntryLine.type == "Transfer" || doubleEntryLine.type == 'Crowdsale' || doubleEntryLine.type == 'Vesting' || doubleEntryLine.type == 'Gnosis: Exec' || doubleEntryLine.type == 'Liquidity event') {
        if (change.accountDebit.added !== change.accountCredit.added) {
          doubleEntryLine.trade = doubleEntryLine.trade || { credit: {}, debit: {} }
          if (change.accountDebit.added) {
            doubleEntryLine.trade.debit[change.symbol] = (doubleEntryLine.trade.debit[change.symbol] || 0) + change.amount.toNumber()
          }
          if (change.accountCredit.added) {
            doubleEntryLine.trade.credit[change.symbol] = (doubleEntryLine.trade.credit[change.symbol] || 0) + change.amount.toNumber()
          }
        } else if (!change.accountDebit.added && !change.accountCredit.added) {
          console.log('weird line item', inspect(doubleEntryLine, false, 10, true))
        }
      } else {
        doubleEntryLine.trade = doubleEntryLine.trade || { credit: {}, debit: {} }
        if (change.accountDebit.added) {
          doubleEntryLine.trade.debit[change.symbol] = (doubleEntryLine.trade.debit[change.symbol] || 0) + change.amount.toNumber()
        }
        if (change.accountCredit.added) {
          doubleEntryLine.trade.credit[change.symbol] = (doubleEntryLine.trade.credit[change.symbol] || 0) + change.amount.toNumber()
        }
        if (change.accountDebit.added === change.accountCredit.added) {
          console.log('weird line item', inspect(doubleEntryLine, false, 10, true))
        }
      }

      const keyDebit = key(change.accountDebit.label, change.symbol)
      doubleEntryLine.changes[keyDebit] = (doubleEntryLine.changes[keyDebit] || 0) - change.amount.toNumber()
      finalBalance[keyDebit] = (finalBalance[keyDebit] || 0) - change.amount.toNumber()

      const keyCredit = key(change.accountCredit.label, change.symbol)
      doubleEntryLine.changes[keyCredit] = (doubleEntryLine.changes[keyCredit] || 0) + change.amount.toNumber()
      finalBalance[keyCredit] = (finalBalance[keyCredit] || 0) + change.amount.toNumber()
    }

    setBalancesAt(lineItem.date, finalBalance)

    calculatedLineItems.push(doubleEntryLine)

    // populate columns
    for (let i in doubleEntryLine.changes) {
      if (!columns.includes(i)) columns.push(i)
    }
  }

  return {
    getBalancesAt,
    calculatedLineItems,
    columns,
    finalBalance,
    contractToToken,
    unknownAccounts,
    txs,
  }
}
