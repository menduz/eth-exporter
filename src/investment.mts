import { doubleEntryFromGraph } from './double-entry.mjs'
import { Graph } from './graph.mjs'
import { mkdirSync, writeFileSync } from 'fs'
import ethConnect from 'eth-connect'
import { resolve } from 'path'
import { priceDb } from './price-db.mjs'
import chart from 'asciichart'
import { memoize } from './memoize.js'

function byDate(a: { date: Date }, b: { date: Date }) {
  if (a.date > b.date) return 1
  else return -1
}

export async function dumpInvestment(graph: Graph) {
  console.log('> Processing operations')
  const doubleEntry = doubleEntryFromGraph(graph)

  mkdirSync(graph.options.output, { recursive: true })

  type TradeOp = {
    type: 'BUY' | 'SELL'
    date: Date
    tx: string
    address: string

    // symbol decreasing
    symbol: string
    amount: ethConnect.BigNumber
    cost: ethConnect.BigNumber
    price: ethConnect.BigNumber

    // symbol increasing
    other_symbol: string
    other_amount: ethConnect.BigNumber
    other_cost: ethConnect.BigNumber
    other_price: ethConnect.BigNumber
  }

  type LiquidityOp = {
    type: 'DEPOSIT' | 'WITHDRAW'
    date: Date
    tx: string
    address: string

    //
    symbol: string
    amount: ethConnect.BigNumber
    cost: ethConnect.BigNumber
    price: ethConnect.BigNumber
  }

  type Op = TradeOp | LiquidityOp

  type Movement = Op & {
    original: Op
    gain?: ethConnect.BigNumber
    stock: Op
  }

  const pdb = await priceDb()
  const stable = new Set(['USD', 'USDC', 'USDT', 'DAI'])

  const priceAt = async function (contractOrSymbol: string, date: Date): Promise<ethConnect.BigNumber> {
    const key = `priceAt ${contractOrSymbol} ${date.toISOString()}`

    try {
      console.time(key)

      if (stable.has(contractOrSymbol)) return ethConnect.BigNumber(1)
      const address = doubleEntry.getContractFromSymbol(contractOrSymbol)
      const fallback = doubleEntry.priceAt(contractOrSymbol, date)
      return await pdb.priceAt(contractOrSymbol == 'BTC' ? 'BTC' : address ?? contractOrSymbol, date, () => fallback)
    } finally {
      console.timeEnd(key)
    }
  }

  const getHistoricalPricesOf = async function (contractOrSymbol: string, from: Date, to: Date) {
    const key = `histPriceOf ${contractOrSymbol} ${from.toISOString()} to ${to.toISOString()}`

    try {
      console.time(key)

      if (stable.has(contractOrSymbol)) {
        return Array.from(generateDates(from, to, 1)).map((date) => {
          return Object.assign(ethConnect.BigNumber(1), { date })
        })
      }

      const address = doubleEntry.getContractFromSymbol(contractOrSymbol)
      return await pdb.getPrices(contractOrSymbol == 'BTC' ? 'BTC' : address ?? contractOrSymbol, from, to)
    } finally {
      console.timeEnd(key)
    }
  }

  const getCurrentPrice = memoize(async function (contractOrSymbol: string) {
    const address = doubleEntry.getContractFromSymbol(contractOrSymbol)
    return address ? await pdb.currentPrice(address) : ethConnect.BigNumber(Number.NaN)
  })

  const btcPrice = await getCurrentPrice('BTC')

  const beginGraph = new Date()
  beginGraph.setDate(beginGraph.getDate() - 15)
  const now = new Date()

  const dates: Date[] = Array.from(generateDates(beginGraph, now))

  function* generateDates(from: Date, to: Date, hourStep = 12) {
    const begin = new Date()
    begin.setDate(from.getDate() - 15)
    begin.setMilliseconds(0)
    begin.setSeconds(0)
    begin.setMinutes(0)
    begin.setHours(0)

    while (begin < to) {
      begin.setHours(begin.getHours() + hourStep)
      yield new Date(begin.getTime())
    }
  }

  async function* generator(): AsyncGenerator<Op> {
    for (const [tx, lineItem] of doubleEntry.lineItems) {
      if (lineItem.apparentSwap) {
        const [[address, changes]] = lineItem.selfAccountNetChanges

        if (changes.size == 2) {
          const [[symbol_a, amount_a], [symbol_b, amount_b]] = changes

          let price_a = await priceAt(symbol_a, lineItem.date)
          let price_b = await priceAt(symbol_b, lineItem.date)

          if (price_a.eq(0)) {
            price_a = price_b.multipliedBy(amount_b.abs()).dividedBy(amount_a.abs())
          }

          if (price_b.eq(0)) {
            price_b = price_a.multipliedBy(amount_a.abs()).dividedBy(amount_b.abs())
          }

          yield {
            type: amount_a.gt(0) ? 'BUY' : 'SELL',
            date: lineItem.date,
            tx,
            address,
            symbol: symbol_a,
            amount: amount_a,
            price: price_a,
            cost: price_a.multipliedBy(amount_a),

            other_symbol: symbol_b,
            other_amount: amount_b,
            other_price: price_b,
            other_cost: price_b.multipliedBy(amount_b)
          }

          yield {
            type: amount_b.gt(0) ? 'BUY' : 'SELL',
            date: lineItem.date,
            tx,
            address,
            symbol: symbol_b,
            amount: amount_b,
            price: price_b,
            cost: price_b.multipliedBy(amount_b),

            other_symbol: symbol_a,
            other_amount: amount_a,
            other_price: price_a,
            other_cost: price_a.multipliedBy(amount_a)
          }
        } else {
          process.exit(1)
        }
      } else {
        for (const [address, changes] of lineItem.selfAccountNetChanges) {
          if (changes.size > 2) console.dir(changes)
          for (const [symbol, amount] of changes) {
            const price = await priceAt(symbol, lineItem.date)

            yield {
              type: amount.gt(0) ? 'DEPOSIT' : 'WITHDRAW',
              date: lineItem.date,
              tx,
              address,
              symbol,
              amount,
              price,
              cost: price.multipliedBy(amount)
            }
          }
        }
      }
    }
  }

  const movements: Op[] = []

  for await (const x of generator()) {
    movements.push(x)
  }

  movements.sort(byDate)

  const data: Record<
    string,
    {
      symbol: string
      totalGains: ethConnect.BigNumber
      totalCost: ethConnect.BigNumber
      inventory: Movement[]
      sells: Movement[]
      remainingInventory: ethConnect.BigNumber
      remainingInventoryCost: ethConnect.BigNumber
      currentAverageBuyPrice: ethConnect.BigNumber
    }
  > = {}

  function getInventory(symbol: string) {
    if (!(symbol in data)) {
      data[symbol] = {
        symbol,
        totalGains: new ethConnect.BigNumber(0),
        totalCost: new ethConnect.BigNumber(0),
        inventory: [],
        sells: [],
        remainingInventory: new ethConnect.BigNumber(0),
        remainingInventoryCost: new ethConnect.BigNumber(0),
        currentAverageBuyPrice: new ethConnect.BigNumber(0)
      }
    }

    return data[symbol]
  }

  for (let item of movements) {
    if (item.type == 'DEPOSIT' || item.type == 'BUY') {
      const t = getInventory(item.symbol)
      t.inventory.push({ ...item, original: item, stock: { ...item } })
    } else if (item.type == 'SELL' || item.type == 'WITHDRAW') {
      const t = getInventory(item.symbol)
      if (item.amount.lt(0)) {
        // SELL
        if (t.inventory.length === 0) {
          throw new Error('Sell transaction before a buy transaction')
        }

        let amountToSell = item.amount.negated()

        while (amountToSell.gt(0)) {
          if (t.inventory.length == 0) {
            console.error('SOLD MORE THAN STOCK!!!!!', data)
            break
          }

          let inventoryItem = t.inventory[0]

          if (inventoryItem.amount.lte(amountToSell)) {
            amountToSell = amountToSell.minus(inventoryItem.amount)

            t.totalCost = t.totalCost.plus(inventoryItem.amount.multipliedBy(inventoryItem.price))
            t.totalGains = t.totalGains.plus(inventoryItem.amount.multipliedBy(item.price.minus(inventoryItem.price)))

            t.sells.push({
              ...item,
              original: item,
              stock: { ...inventoryItem },
              amount: inventoryItem.amount,
              cost: inventoryItem.amount.multipliedBy(inventoryItem.price),
              gain: item.price.minus(inventoryItem.price)
            })

            t.inventory.shift()
          } else {
            inventoryItem.amount = inventoryItem.amount.minus(amountToSell)
            t.totalCost = t.totalCost.plus(amountToSell.multipliedBy(inventoryItem.price))
            t.totalGains = t.totalGains.plus(amountToSell.multipliedBy(item.price.minus(inventoryItem.price)))

            t.sells.push({
              ...item,
              original: item,
              stock: { ...inventoryItem },
              amount: amountToSell,
              cost: amountToSell.multipliedBy(inventoryItem.price),
              gain: amountToSell.multipliedBy(item.price.minus(inventoryItem.price))
            })

            amountToSell = new ethConnect.BigNumber(0)
          }
        }
      } else {
        console.error('unknown tx', item)
      }
    } else {
      console.error('unknown type', item)
    }
  }

  for (var symbol in data) {
    const t = data[symbol]
    t.remainingInventory = t.inventory.reduce((total, item) => total.plus(item.amount), new ethConnect.BigNumber(0))
    t.remainingInventoryCost = t.inventory.reduce(
      (total, item) => total.plus(item.amount.multipliedBy(item.price)),
      new ethConnect.BigNumber(0)
    )
    t.currentAverageBuyPrice = t.remainingInventoryCost.dividedBy(Math.max(t.remainingInventory.toNumber(), 1))
  }

  const chartData: number[][] = []

  const currentPositions: any[] = []

  const pricesOfBtc = await getHistoricalPricesOf('BTC', beginGraph, now)

  function getPriceAt(data: Array<ethConnect.BigNumber & { date: Date }>, date: Date) {
    for (const x of data) {
      if (x.date <= date) return x
    }
    return null
  }

  for (const value of Object.values(data)) {
    const pricesOf$ = await getHistoricalPricesOf(value.symbol, beginGraph, now)
    for (const $ of value.inventory)
      if ($.type == 'BUY') {
        const latestPrice = await getCurrentPrice($.symbol)
        const currentCost = $.amount.multipliedBy(latestPrice)

        // ratio of the original stock that we are still holding
        const ratio = $.amount.dividedBy($.original.amount)

        // acquisition cost of the remaining (ratio)
        const acqCost = $.original.cost.multipliedBy(ratio)
        const acqPrice = $.original.price

        const originalOp = $.original as TradeOp
        const soldPartLatestPrice = await getCurrentPrice(originalOp.other_symbol)

        // current price of the sold part if we were holding it. adjusted by the sold part (ratio)
        const soldPartCurrentCost = soldPartLatestPrice
          .multipliedBy(originalOp.other_amount.negated())
          .multipliedBy(ratio)

        let effect = ''

        if (currentCost.lt(acqCost) && currentCost.gt(soldPartCurrentCost)) {
          effect = `Damage control for ${originalOp.other_symbol}`
        } else if (currentCost.gt(acqCost) && currentCost.minus(soldPartCurrentCost).gt(100)) {
          effect = 'Profit'
        } else if (currentCost.lt(acqCost) && currentCost.minus(acqCost).lt(currentCost.minus(soldPartCurrentCost))) {
          effect = 'Controlled loss'
        } else if (currentCost.lt(acqCost)) {
          effect = 'Loss'
        }

        const currentCostBtc = currentCost.dividedBy(btcPrice)
        const acqCostBtc = acqCost.dividedBy(await priceAt('BTC', $.original.date))

        const prices: number[] = []

        for (const date of dates) {
          const priceAtDate = getPriceAt(pricesOf$, date)
          const btcPriceAt = getPriceAt(pricesOfBtc, date)
          if (priceAtDate && btcPriceAt) {
            const costAt = $.amount.multipliedBy(priceAtDate)
            prices.push(costAt.dividedBy(btcPriceAt).toNumber())
          } else {
            console.dir({
              symbol: $.symbol,
              symbol2: value.symbol,
              date,
              pricesOf$: priceAtDate ?? pricesOf$.slice(-4),
              pricesOfBtc: btcPriceAt ?? pricesOfBtc.slice(-4)
            })
          }
        }

        if (prices.length) {
          chartData.push(prices)
        }

        currentPositions.push({
          tx: $.tx,
          date: $.date,
          op: `${originalOp.symbol} ${originalOp.amount.toFixed(3)} @ $ ${acqPrice.toFixed(3).padEnd(4, ' ')} @@ ${originalOp.other_symbol} ${originalOp.other_amount.toFixed(3)} ($${originalOp.other_cost.negated().toFixed(3)})`,
          currentPosition: `(% ${ratio.multipliedBy(100).toFixed(0).padEnd(3, ' ')}) ${$.amount.toFixed(3).padEnd(14, ' ')} @@ $ ${currentCost.toFixed(3).padStart(10, ' ')}`,
          'PnL vs USD': formatPerformance(currentCost, acqCost),
          'PnL vs doing nothing': formatPerformance(currentCost, soldPartCurrentCost),
          'PnL vs BTC': formatPerformance(currentCostBtc, acqCostBtc),
          effect
        })
      }
  }

  console.log(chart.plot(chartData, { height: 40 }))

  function formatPerformance(curr: ethConnect.BigNumber, prev: ethConnect.BigNumber) {
    const performance = curr.minus(prev).dividedBy(prev)
    return `$ ${curr.toFixed(3).padStart(10, ' ')} ${accounting(curr.minus(prev), 11)} ${performance.multipliedBy(100).toFixed(1).padStart(5, ' ') + '%'}`
  }

  console.log('Current positions:')
  console.table(currentPositions.sort(byDate))

  const currentPositionsFinal = Array.from(Object.values(data))
    .filter(($) => !$.remainingInventory.eq(0))
    .map(async ($) => {
      const currentPrice = await getCurrentPrice($.symbol)
      const currentCost = $.remainingInventory.multipliedBy(currentPrice)
      return {
        'Position @@ Inventory cost': `${`${$.symbol} ${$.remainingInventory.toFixed(3)}`.padEnd(20, ' ')} @@ ${('~' + $.remainingInventoryCost.toFixed(3)).padStart(10, ' ')}`,
        'Current cost': `$ ${currentCost.toFixed(3).padStart(10, ' ')}`,
        PnL: formatPerformance(currentCost, $.remainingInventoryCost)
      }
    })

  console.table(await Promise.all(currentPositionsFinal))

  console.log('Finalized operations:')

  const sells = Array.from(Object.values(data)).flatMap(($) => {
    return $.sells
      .filter(($) => $.type == 'SELL')
      .map(($) => {
        const originalOp = $.stock
        const op = $ as TradeOp

        // fraction of the total amount of the operation corresponding to this sell
        const inAmount = op.amount.dividedBy(originalOp.amount).multipliedBy(op.other_amount).abs()

        return {
          tx: $.tx,
          date: $.date,
          op: `${op.other_symbol} ${inAmount.toFixed(3)} @ $${originalOp.price.toFixed(3)} @@ ${op.symbol} ${-op.amount.toFixed(3)} ($${op.price.multipliedBy(op.amount).toFixed(3)})`,
          // fromStock: `${originalOp.symbol} ${originalOp.amount.toFixed(3)} @@ ${originalOp.other_symbol} ${originalOp.other_amount.toFixed(3)} ($${originalOp.other_cost.negated().toFixed(3)})`,
          cost: `$ ${$.cost.toFixed(3)}`,
          gain: `$ ${$.gain?.toFixed(3)}`
        }
      })
  })

  writeFileSync(
    resolve(graph.options.output, 'fifo.json'),
    JSON.stringify({ data, table: currentPositions, sells }, null, 2)
  )

  await pdb.close()
  //  console.table(sells.sort(byDate))
}

function accounting(n: ethConnect.BigNumber, m: number) {
  if (n.eq(0)) return '0'.padStart(m, ' ') + ' '
  if (n.gt(0)) return ('+' + n.toFixed(3)).padStart(m, ' ') + ' '
  return n.toFixed(3).padStart(m, ' ') + ' '
}