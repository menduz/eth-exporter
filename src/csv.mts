import { doubleEntryFromGraph, DoubleEntryResult } from "./double-entry.mjs"
import { graph, Graph } from "./graph.mjs"
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
  const fixedColumns = ["Date", "Tx", "Symbol", "Contract", "Account", "Credit", "Debit"]

  const valuesForGoogle = []
  valuesForGoogle.push([...fixedColumns])

  doubleEntry.lineItems.forEach((LI, ix) => {
    LI.changes.forEach(row => {
      if (row.accountCredit.added) {
        valuesForGoogle.push([
          LI.date.toISOString(),
          row.tx,
          row.symbol,
          row.contractAddress,
          row.accountCredit.address,
          row.amount,
          ''
        ])
      }

      if (row.accountDebit.added) {
        valuesForGoogle.push([
          LI.date.toISOString(),
          row.tx,
          row.symbol,
          row.contractAddress,
          row.accountDebit.address,
          '',
          row.amount,
        ])
      }
    })
  }
  )

  const csv = valuesForGoogle.map($ => $.join(',')).join('\n')

  await writeFile(filename, csv)
}