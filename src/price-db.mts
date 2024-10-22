import { fetchWithAttempts, fetchWithCache } from './fetcher.mjs'
import ethConnect from 'eth-connect'
import { memoize } from './memoize.js'
import assert from 'assert'
import sqlite3 from 'sqlite3'
import * as sqlite from 'sqlite'
import sql, { Sql, bulk } from 'sql-template-tag'
import { mapColumns } from './sqlite.mjs'
import { log } from './log.mjs'

export async function priceDb() {
  const db = await sqlite.open({
    filename: 'prices.db',
    driver: sqlite3.Database
  })

  await db.migrate({
    migrations: [
      {
        id: 1,
        name: 'prices',
        up: `
	CREATE TABLE prices (
	  network varchar,
	  contract varchar,
	  date datetime,
	  price numeric
	);
	CREATE INDEX prices_ix ON prices (
	  network, contract, price desc
	);
	`,
        down: `DROP TABLE prices`
      },
      {
        id: 2,
        name: 'datasets',
        up: `
	CREATE TABLE prices_ranges (
	  network varchar,
	  contract varchar,
	  start_date datetime,
	  end_date datetime,
	  scale varchar
	);
	`,
        down: `DROP TABLE prices_ranges`
      },
      {
        id: 3,
        name: 'price range index',
        up: `
	CREATE INDEX prices_ranges_ix ON prices_ranges (
	  network, contract, start_date
	);
	`,
        down: `DROP INDEX prices_ranges_ix`
      }
    ]
  })

  async function close() {
    await db.close()
  }

  const now = new Date()
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))

  function getPrevSunday(d: Date) {
    // Copy date so don't modify original
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
    d.setUTCDate(d.getUTCDate() - d.getUTCDay())
    return d
  }

  function getPrevWeek(d: Date) {
    return getPrevSunday(d)
  }

  function getNextWeek(d: Date) {
    const ret = getPrevSunday(d)
    ret.setUTCDate(ret.getUTCDate() + 7)

    if (
      ret.getUTCFullYear() == d.getUTCFullYear() &&
      ret.getUTCMonth() == d.getUTCMonth() &&
      ret.getUTCDate() == d.getUTCDate()
    ) {
      ret.setUTCDate(ret.getUTCDate() + 7)
    }

    return ret
  }

  // prev
  assert.strictEqual(getPrevWeek(new Date('2024-10-28T00:00:00Z')).toISOString(), '2024-10-27T00:00:00.000Z')
  assert.strictEqual(getPrevWeek(new Date('2024-10-27T00:00:00Z')).toISOString(), '2024-10-20T00:00:00.000Z')
  assert.strictEqual(getPrevWeek(new Date('2024-01-01T00:00:00Z')).toISOString(), '2023-12-31T00:00:00.000Z')

  // next
  assert.strictEqual(getNextWeek(new Date('2024-01-03T00:00:00Z')).toISOString(), '2024-01-07T00:00:00.000Z')
  assert.strictEqual(getNextWeek(new Date('2024-01-03T00:00:00Z')).toISOString(), '2024-01-07T00:00:00.000Z')
  assert.strictEqual(getNextWeek(new Date('2024-01-27T00:00:00Z')).toISOString(), '2024-01-28T00:00:00.000Z')
  assert.strictEqual(getNextWeek(new Date('2024-10-13T00:00:00Z')).toISOString(), '2024-10-20T00:00:00.000Z')
  assert.strictEqual(getNextWeek(new Date('2024-10-20T00:00:00Z')).toISOString(), '2024-10-27T00:00:00.000Z')

  async function ensureData(contractOrSymbol: string, start: Date, end: Date) {
    const yearMonth: Date[] = [] // array of Dates for each month, starting at the first day of the month
    let max = getNextWeek(end)
    let min = getPrevWeek(start > today ? today : start)

    if (max > today) max = today

    let currentWeek = min
    yearMonth.push(currentWeek)

    while (currentWeek < max) {
      currentWeek = getNextWeek(currentWeek)
      if (currentWeek > today) currentWeek = today
      yearMonth.push(currentWeek)
    }

    if (yearMonth.length < 2) throw new Error(`Invalid range ${start.toISOString()} ${max.toISOString()}`)

    for (let i = 1; i < yearMonth.length; i++) {
      await ensureRange(contractOrSymbol, yearMonth[i - 1], yearMonth[i], '1h')
    }

    return {
      from: min,
      to: max
    }
  }

  async function getPrices(contractOrSymbol: string, start: Date, end?: Date) {
    const { from, to } = await ensureData(contractOrSymbol, start, end ?? today)
    const { network, contract } = netcon(contractOrSymbol)

    console.time('prices')

    const prices = await db.all(sql`
      SELECT
        p.date,
        AVG(p.price) as price
      FROM prices p
      WHERE
        p.contract = ${contract}
        AND
        p.network = ${network}
	AND
	p.date >= ${from}
        AND
	p.date <= ${to}
      GROUP BY
        strftime('%Y-%m-%dT%H:00:00', p.date)
      ORDER BY p.date ASC
      `)

    console.timeEnd('prices')
    console.log(prices.length, network, contract, start, end)

    return prices.flat().map((a) => hydratedPrice([a.date, ethConnect.BigNumber(a.price)]))
  }

  function netcon(contract: string) {
    if (contract == 'BTC') return { network: 'Bitcoin', contract: '0x0000000000000000000000000000000000000000' }
    if (contract == 'ETH') return { network: 'Ethereum', contract: '0x0000000000000000000000000000000000000000' }
    return { network: 'Ethereum', contract }
  }

  async function ensureRange(contractOrSymbol: string, from: Date, to: Date, scale: string) {
    const { network, contract } = netcon(contractOrSymbol)
    const exists = await db.all(sql`
      SELECT 1
      FROM prices_ranges 
      WHERE network = ${network}
	AND contract = ${contract}
	AND start_date >= ${from}
	AND end_date <= ${to}
	AND scale = ${scale}
      LIMIT 1`)

    if (!exists.length) {
      const data = await fetchPrices(contractOrSymbol, from, to, scale)

      await bulkInsert(
        sql`INSERT INTO prices (network, contract, date, price)`,
        mapColumns(
          data.map((x) => hydratedPrice(x)),
          () => network,
          () => contract,
          (price) => price.date,
          (price) => price
        )
      )

      await db.run(sql`
        INSERT INTO prices_ranges (network, contract, start_date, end_date, scale)
        VALUES (${network}, ${contract}, ${from}, ${to}, ${scale})
      `)
    }
  }

  async function bulkInsert(smt: Sql, rows: unknown[][]) {
    while (rows.length) {
      const toInsert = rows.splice(0, 1000)

      await db.run(sql`${smt} VALUES ${bulk(toInsert)}`)
    }
  }

  function hydratedPrice(args: [number | string | Date, ethConnect.BigNumber]): ethConnect.BigNumber & { date: Date } {
    if (args[0] instanceof Date) {
      return Object.assign(args[1], { date: args[0] })
    }

    if (typeof args[0] == 'string') {
      return Object.assign(args[1], { date: new Date(args[0]) })
    }

    if (isNaN(new Date(args[0] * 1000).getTime())) {
      throw new Error('NAN DATE')
    }

    return Object.assign(args[1], { date: new Date(args[0] * 1000) })
  }

  async function priceAt(
    contractOrSymbol: string,
    date: Date,
    fallback = (): [number, ethConnect.BigNumber] => [0, ethConnect.BigNumber(Number.NaN)]
  ): Promise<ethConnect.BigNumber & { date: Date }> {
    if (new Date().getTime() - date.getTime() < 3600000) {
      return currentPrice(contractOrSymbol)
    }
    const { from, to } = await ensureData(contractOrSymbol, date, date)

    try {
      assert.strictEqual(from < to, true, `${from} from < to`)
      assert.strictEqual(from < date, true, `${from} from < date ${date}`)
      assert.strictEqual(date <= to, true, `${date} date <= to ${to}`)

      const { network, contract } = netcon(contractOrSymbol)

      const prices = await db.all(sql`
	SELECT p.date, p.price
	FROM prices p
	WHERE
	  p.contract = ${contract}
	  AND
	  p.network = ${network}
	  AND
	  p.date <= ${date}
	ORDER BY p.date DESC
	LIMIT 1
      `)

      if (prices.length) {
        return hydratedPrice([prices[0].date, ethConnect.BigNumber(prices[0].price)])
      }
    } catch (e) {
      console.error(e)
    }
    return hydratedPrice(fallback())
  }

  const historicFetcher = memoize(async function (url: string) {
    return await fetchWithCache(
      url,
      (ret, fromCache) => {
        if (ret?.DataPoints[0]) {
          if (ret.DataPoints[0].Series && Array.isArray(ret.DataPoints[0].Series[0].values)) {
            return ret.DataPoints[0].Series[0].values
          }
          return []
        }
        throw new Error(`Error fetching ${url} ${JSON.stringify(ret)} FromCache: ${fromCache}`)
      },
      false
    )
  })

  async function fetchPrices(
    contractOrSymbol: string,
    start: Date,
    end: Date,
    scale: string
  ): Promise<[number, ethConnect.BigNumber][]> {
    const query = new URLSearchParams()

    query.set('scale', scale ?? '1h')
    query.set('starttime', ((start.getTime() / 1000) >>> 0).toString())
    query.set('endtime', ((end.getTime() / 1000) >>> 0).toString())

    const { network, contract } = netcon(contractOrSymbol)

    const url = `https://api.diadata.org/v1/assetChartPoints/MAIR120/${network}/${contract}?${query.toString()}`
    console.trace(url)
    const res = await historicFetcher(url)

    return res
      .map((x: any[]) => [x[0], ethConnect.BigNumber(x[x.length - 1])])
      .sort(([a]: number[], [b]: number[]) => {
        if (a > b) return 1
        return -1
      })
  }

  const currentPrice = memoize(async (contractOrSymbol: string): Promise<ethConnect.BigNumber & { date: Date }> => {
    const { contract, network } = netcon(contractOrSymbol)

    const url = `https://api.diadata.org/v1/assetQuotation/${network}/${contract}`

    const res = (await fetchWithAttempts(url)) as {
      Price: number
      PriceYesterday: number
      VolumeYesterdayUSD: number
      Time: string
    }

    log(`${contract} ${res.Price} ${res.Time}`)

    if (res.Price) {
      await db.run(sql`
        INSERT INTO prices (network, contract, date, price)
        VALUES (${network}, ${contract}, ${res.Time}, ${res.Price})
      `)
    }

    return Object.assign(ethConnect.BigNumber(res.Price), { date: new Date(res.Time) })
  })

  return { close, getPrices, priceAt, currentPrice }
}
