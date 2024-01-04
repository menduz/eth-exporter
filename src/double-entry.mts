import ethConnect from "eth-connect"
import { txValue } from "./draw.mjs"
import { Account, filterTransfer, getAccountFromAddress, Graph, normalizeAddress, operationType, Options, Transfer } from "./graph.mjs"

export type LineItemChange = {
  tx: string
  accountDebit: Account
  accountCredit: Account
  symbol: string
  amount: ethConnect.BigNumber
  originalTx: Transfer
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
  txs: Transfer[]
}

export type DoubleEntryResult = ReturnType<typeof doubleEntryFromGraph>

export function doubleEntryFromGraph(graph: Graph) {
  const lineItems = new Map<string, LineItem>()
  const contractToToken = new Map<string, string>()
  const unknownAccounts = new Set<string>()

  function addLineItem(transfer: Transfer) {
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

    const data = graph.receipts.get(transfer.hash)

    if (data) {
      const fees = new ethConnect.BigNumber(data.gasUsed).multipliedBy(ethConnect.toDecimal((data as any).effectiveGasPrice ?? '0x0'))
      if (fees.gt(lineItem.fees)) {
        lineItem.fees = fees
      }
    }

    if (!lineItem.changes.some($ => $.originalTx == transfer)) {
      lineItem.changes.push({
        tx: transfer.hash,
        accountDebit: accountFrom,
        accountCredit: accountTo,
        symbol: transfer.tokenSymbol || "ETH",
        amount: txValue(transfer),
        contractAddress: normalizeAddress(transfer.contractAddress),
        originalTx: transfer,
      })
    }

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
  }


  // add all line items
  const alltx: Transfer[] = []
  Array.from(graph.transactions.values()).forEach((txlist) => alltx.push(...txlist))
  const txs = alltx
    .sort((a, b) => (parseInt(a.timeStamp) > parseInt(b.timeStamp) ? 1 : -1))
    .filter(filterTransfer)
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
            symbol: "ETH",
            contractAddress: null,
            amount: lineItem.fees.shiftedBy(-18),
            originalTx,
          })
        }
      }
    }
  }

  return {
    lineItems,
    contractToToken,
    unknownAccounts,
    txs,
  }
}
