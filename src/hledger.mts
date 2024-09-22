import { doubleEntryFromGraph } from './double-entry.mjs'
import { Account, Graph, getAccountFromAddress, normalizeAddress, operationType } from './graph.mjs'
import { log } from './log.mjs'
import { mkdirSync, writeFileSync } from 'fs'
import ethConnect from 'eth-connect'
import { resolve } from 'path'

export async function dumpHledger(graph: Graph) {
  console.log('> Processing operations')
  const doubleEntry = doubleEntryFromGraph(graph)

  mkdirSync(graph.options.output, { recursive: true })

  const foundCommodities = new Set<string>()

  {
    log(`> Writing Accounts`)

    const parts: string[] = []

    parts.push('\n; accounts')
    const addedAccounts = Array.from(graph.accounts.values()).filter((acc) => {
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

    addedAccounts.forEach((acc) => {
      if (!acc.label) return

      parts.push(`alias ${normalizeAddress(acc.address)} = ${acc.label}`)
    })

    writeFileSync(resolve(graph.options.output, 'accounts.journal'), parts.join('\n'))
  }

  function changeTracker() {
    const netChanges: Map<string, Map<string, ethConnect.BigNumber>> = new Map()

    function delta(account: Account, symbol: string, amt: ethConnect.BigNumber) {
      const a = normalizeAddress(account.address)

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

  {
    log(`> Writing line items`)

    const parts: string[] = []

    Array.from(doubleEntry.lineItems.entries()).flatMap(([tx, item]) => {
      const opType = operationType(graph, tx)

      const txChanges = changeTracker()
      const selfAccountChanges = changeTracker()
      parts.push('')
      parts.push(`${item.date.toISOString().substring(0, 19).replace('T', ' ')} ${opType} ${tx}`)

      for (const $ of item.changes) {
        if ((!$.accountDebit.added && !$.accountCredit.added) || $.isFee) continue

        const contract = $.contractAddress ? graph.allowedContracts.get(normalizeAddress($.contractAddress)) : null
        const symbol = contract?.symbol || $.symbol

        const debitLabel = txChanges.delta($.accountDebit, symbol, $.amount.negated())
        const creditLabel = txChanges.delta($.accountCredit, symbol, $.amount)

        if ($.accountDebit.added) selfAccountChanges.delta($.accountDebit, symbol, $.amount.negated())
        if ($.accountCredit.added) selfAccountChanges.delta($.accountCredit, symbol, $.amount)

        foundCommodities.add(symbol)

        parts.push(`    ; ${debitLabel}  ${-$.amount.toFixed(12).replace(/\.?0+$/, '')} ${symbol}`)
        parts.push(`    ; ${creditLabel}   ${$.amount.toFixed(12).replace(/\.?0+$/, '')} ${symbol}`)
      }

      let printAll = true

      function printTrade(
        address: string,
        credit: [string, ethConnect.BigNumber],
        debit: [string, ethConnect.BigNumber]
      ) {
        const account = getAccountFromAddress(address)
        parts.push(`    ${account.label}    -${debit[1].abs().toFixed(12).replace(/\.?0+$/, '')} ${debit[0]}`)
        parts.push(`    equity:conversion    ${debit[1].abs().toFixed(12).replace(/\.?0+$/, '')} ${debit[0]}`)
        parts.push(`    equity:conversion   -${credit[1].abs().toFixed(12).replace(/\.?0+$/, '')} ${credit[0]}`)
        parts.push(
          `    ${account.label}  ${credit[1].toFixed(12).replace(/\.?0+$/, '')} ${credit[0]} @@ ${debit[1].abs().toFixed(12).replace(/\.?0+$/, '')} ${debit[0]}`
        )
      }

      if (opType == 'Swap') {
        const [[address, changes]] = selfAccountChanges.netChanges
        if (changes.size == 2) {
          const [a, b] = changes
          if (a[1].isPositive()) {
            printTrade(address, a, b)
          } else {
            printTrade(address, b, a)
          }
          printAll = false
        } else {
          parts.push('    ; self account changes:')
          parts.push('    ; ERROR! cannot infer trade')
          for (const [address, $] of selfAccountChanges.netChanges) {
            for (const [symbol, amount] of $) {
              if (amount.toNumber() != 0) {
                const account = getAccountFromAddress(address)
                parts.push(`    ;   change: ${account.label}  ${amount.toFixed(12).replace(/\.?0+$/, '')} ${symbol}`)
              }
            }
          }
        }
      }

      if (printAll) {
        for (const [address, $] of txChanges.netChanges) {
          for (const [symbol, amount] of $) {
            if (amount.toNumber() != 0) {
              const account = getAccountFromAddress(address)
              parts.push(`    ${account.label}  ${amount.toFixed(12).replace(/\.?0+$/, '')} ${symbol}`)
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

          parts.push(`    ${debitLabel}  ${-$.amount.toFixed(12).replace(/\.?0+$/, '')} ${symbol}`)
          parts.push(`    ${creditLabel}  ${$.amount.toFixed(12).replace(/\.?0+$/, '')} ${symbol}`)
        }
      }
    })

    writeFileSync(resolve(graph.options.output, 'movements.journal'), parts.join('\n'))
  }

  {
    log(`> Writing prices`)

    const parts: string[] = []

    for (const [key, data] of graph.prices) {
      const c = graph.allowedContracts.get(key)
      for (const price of data.prices) {
        parts.push(
          `P ${new Date(price[0]).toISOString().substring(0, 19).replace('T', ' ')} ${c?.symbol ?? key} $${price[1].toFixed(12).replace(/0+$/, '')}`
        )
      }
    }

    writeFileSync(resolve(graph.options.output, 'prices.journal'), parts.join('\n'))
  }
  {
    log(`> Writing parameters`)

    const parts: string[] = []

    parts.push(`decimal-mark ${(0.2).toString()[1]}`)

    parts.push(`commodity 1000.00000 ETH`)
    parts.push(`commodity 1000.00000 BTC`)
    parts.push(`account equity:conversion  ; type: V`)

    parts.push('; allowedContracts')

    const printedCommodities = new Set<string>()

    function printCommodities(symbol: string) {
      if (printedCommodities.has(symbol)) return
      printedCommodities.add(symbol)
      parts.push(`commodity 1000.00000 ${symbol}`)
    }

    for (const [addr, c] of graph.allowedContracts) {
      const acc = graph.accounts.get(addr)
      if (c.present && addr) {
        parts.push(`\n; symbol:${c.symbol}, contract:${addr}`)
        parts.push(`account ${acc?.label ?? `equity:trading:${c.symbol}`}    ; type:E`)
        printCommodities(c.symbol)
      }
    }

    for (const symbol of foundCommodities) {
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
    parts.push(`include prices.journal`)

    parts.push('')

    writeFileSync(resolve(graph.options.output, 'hledger.journal'), parts.join('\n'))
  }
}
