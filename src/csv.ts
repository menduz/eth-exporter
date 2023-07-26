import { doubleEntryFromGraph, DoubleEntryResult } from "./double-entry"
import { graph, Graph, Options } from "./graph"
import { writeFile } from "fs/promises"

export async function dumpCsv(graph: Graph) {
  console.log("> Processing operations")
  const doubleEntry = doubleEntryFromGraph(graph)
  await updateOperations(doubleEntry)
}

async function updateOperations(doubleEntry: DoubleEntryResult) {
  console.log("> Writing tradesheet " + graph.options.output)
  await dumpTradesheet(graph.options.output, doubleEntry)
}

async function dumpTradesheet(
  filename: string,
  doubleEntry: DoubleEntryResult
) {
  const columnSet = new Set<string>()

  for (let item of doubleEntry.calculatedLineItems) {
    Object.keys(item.changes).forEach(($) => columnSet.add($))
  }

  const fixedColumns = ["Date", "Type", "Tx", "Buy", "Sell", "BuyUnits", "SellUnits"]

  const valuesForGoogle = []
  valuesForGoogle.push([...fixedColumns])

  doubleEntry.calculatedLineItems.forEach((row, ix) => {
    if (row.trade) {
      const keysDebit = Object.keys(row.trade.debit)
      const keysCredit = Object.keys(row.trade.credit)

      if (keysCredit.length > 1 && keysDebit.length > 1 && row.type !== 'Liquidity event') {
        console.log('OMITTED ROW', row);
        return
      }

      const isDeposit = keysCredit.length > 0 && keysDebit.length == 0 || row.type == 'Liquidity event'
      const isWithdrawal = keysCredit.length == 0 && keysDebit.length > 0 || row.type == 'Liquidity event'

      if (isDeposit) {
        for (const token of keysCredit) {
          valuesForGoogle.push([
            row.date.toISOString(),
            'Deposit',
            row.tx,
            token,
            '',
            row.trade.credit[token],
            '',
          ])
        }
      }

      if (isWithdrawal) {
        for (const token of keysDebit) {
          valuesForGoogle.push([
            row.date.toISOString(),
            'Withdrawal',
            row.tx,
            '',
            token,
            '',
            row.trade.debit[token],
          ])
        }
      }

      if (!isDeposit && !isWithdrawal) {
        const buy = keysCredit[0] || ''
        const buyAmount = buy ? row.trade.credit[buy] : 0

        const sell = keysDebit[0] || ''
        const sellAmount = sell ? row.trade.debit[sell] : 0

        valuesForGoogle.push([
          row.date.toISOString(),
          row.type,
          row.tx,
          buy,
          sell,
          buyAmount,
          sellAmount,
        ])
      }
    } else {
      if (!row.type)
        console.log(row)
    }
  })

  const csv = valuesForGoogle.map($ => $.join(',')).join('\n')

  await writeFile(filename, csv)
}