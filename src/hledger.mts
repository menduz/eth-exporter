import { changeTracker, doubleEntryFromGraph } from './double-entry.mjs'
import { Account, Graph, getAccountFromAddress, normalizeAddress, operationType } from './graph.mjs'
import { log } from './log.mjs'
import { mkdirSync, writeFileSync } from 'fs'
import ethConnect from 'eth-connect'
import { resolve } from 'path'

export async function dumpHledger(graph: Graph) {
  console.log('> Processing operations')
  const doubleEntry = doubleEntryFromGraph(graph)

  mkdirSync(graph.options.output, { recursive: true })

  function sym(symbol: string) {
    if (!symbol.match(/^[A-Z]+$/i)) {
      return `"${symbol}"`
    } else {
      return symbol
    }
  }

  function num(n: ethConnect.BigNumber): string {
    return n
      .abs()
      .toFixed(12)
      .replace(/\.?0+$/, '')
  }

  {
    log(`> Writing line items`)

    const parts: string[] = []

    Array.from(doubleEntry.lineItems.entries()).flatMap(([tx, item]) => {
      const opType = operationType(graph, tx)

      parts.push('')
      parts.push(`${item.date.toISOString().substring(0, 19).replace('T', ' ')} ${opType} ${tx}`)

      let printAll = true

      function printTrade(
        address: string,
        credit: [string, ethConnect.BigNumber],
        debit: [string, ethConnect.BigNumber]
      ) {
        const account = getAccountFromAddress(address)

        parts.push(`    ${account.label}    -${num(debit[1])} ${sym(debit[0])}`)
        parts.push(`    equity:conversion    ${num(debit[1])} ${sym(debit[0])}`)
        parts.push(`    equity:conversion   -${num(credit[1])} ${sym(credit[0])}`)
        parts.push(`    ${account.label}  ${num(credit[1])} ${sym(credit[0])} @@ ${num(debit[1])} ${sym(debit[0])}`)
      }

      if (item.apparentSwap) {
        const [[address, changes]] = item.selfAccountNetChanges

        if (changes.size == 2) {
          const [a, b] = changes
          if (a[1].isPositive()) {
            printTrade(address, a, b)
          } else {
            printTrade(address, b, a)
          }
          printAll = false
        }
      }

      if (printAll) {
        for (const [address, $] of item.netChanges) {
          for (const [symbol, amount] of $) {
            if (amount.toNumber() != 0) {
              const account = getAccountFromAddress(address)
              parts.push(`    ${account.label}  ${amount.toFixed(12).replace(/\.?0+$/, '')} ${sym(symbol)}`)
            }
          }
        }
      }

      for (const $ of item.changes) {
        if ($.isFee) {
          const contract = $.contractAddress ? graph.allowedContracts.get(normalizeAddress($.contractAddress)) : null
          const symbol = contract?.symbol || $.symbol

          const debitLabel = $.accountDebit.label.trim() || normalizeAddress($.accountDebit.address)
          const creditLabel = $.accountCredit.label.trim() || normalizeAddress($.accountCredit.address)

          parts.push(`    ${creditLabel}  ${num($.amount)} ${sym(symbol)}`)
          parts.push(`    ${debitLabel}  -${num($.amount)} ${sym(symbol)}`)
        }
      }
    })

    writeFileSync(resolve(graph.options.output, 'movements.journal'), parts.join('\n'))
  }

  {
    log(`> Writing Accounts`)

    const parts: string[] = []

    parts.push('\n; accounts')
    const addedAccounts = Array.from(graph.accounts.values()).filter((acc) => {
      if (doubleEntry.requiredAccounts.has(acc)) return true
      if (acc.hidden) return false
      if (acc.label == normalizeAddress(acc.address)) return
      if (graph.allowedContracts.has(normalizeAddress(acc.address))) return false
      return true
    })

    for (const label of new Set(addedAccounts.map(($) => $.label))) {
      if (label.includes(':')) {
        parts.push(`account ${label}`)
      } else {
        parts.push(`account ${label}    ; type:E`)
      }
    }

    writeFileSync(resolve(graph.options.output, 'accounts.journal'), parts.join('\n'))
  }

  const prices: string[] = []
  {
    log(`> Writing prices`)

    mkdirSync(graph.options.output + '/prices', { recursive: true })

    for (const [key, data] of graph.prices) {
      const c = graph.allowedContracts.get(key)
      const parts: string[] = []

      for (const price of data.prices) {
        parts.push(
          `P ${new Date(price[0]).toISOString().substring(0, 19).replace('T', ' ')} ${sym(c?.symbol ?? key)} $${price[1].toFixed(12).replace(/0+$/, '')}`
        )
      }

      const filename = `prices/${c?.symbol ?? key}.journal`
      prices.push(filename)
      writeFileSync(resolve(graph.options.output, filename), parts.join('\n'))
    }
  }
  {
    log(`> Writing parameters`)

    const parts: string[] = []

    parts.push(`decimal-mark ${(0.2).toString()[1]}`)

    parts.push(`commodity 1000.00000 ETH`)
    parts.push(`commodity 1000.00000 BTC`)
    parts.push(`account equity:conversion    ; type:V`)

    parts.push('; allowedContracts')

    const printedCommodities = new Set<string>()

    function printCommodities(symbol: string) {
      if (printedCommodities.has(symbol)) return
      printedCommodities.add(symbol)
      parts.push(`commodity 1000.00000 ${sym(symbol)}`)
    }

    for (const [addr, c] of graph.allowedContracts) {
      const acc = graph.accounts.get(addr)
      if (c.present && addr) {
        parts.push(`\n; symbol:${c.symbol}, contract:${addr}`)
        parts.push(`account ${acc?.label ?? `equity:trading:${c.symbol}`}    ; type:E`)
        printCommodities(c.symbol)
      }
    }

    for (const symbol of doubleEntry.foundCommodities) {
      printCommodities(symbol)
    }

    writeFileSync(resolve(graph.options.output, 'parameters.journal'), parts.join('\n'))
  }
  {
    log(`> Writing hledger.journal`)

    const parts: string[] = []

    parts.push(`D $1,000.00`)
    parts.push(`commodity $1,000.00`)

    parts.push(`include parameters.journal`)
    parts.push(`include accounts.journal`)
    parts.push(`include movements.journal`)
    for (const filename of prices) {
      parts.push(`include ${filename}`)
    }

    parts.push('')

    writeFileSync(resolve(graph.options.output, 'hledger.journal'), parts.join('\n'))
  }
}
