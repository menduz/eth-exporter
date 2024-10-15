import { doubleEntryFromGraph } from './double-entry.mjs'
import { Graph, normalizeAddress, operationType } from './graph.mjs'
import sqlite from 'sqlite3'
const { Database } = sqlite
import { future } from 'fp-future'
import sql, { bulk, empty, join, raw, Sql } from 'sql-template-tag'
import { log } from './log.mjs'
import { rmSync } from 'fs'
import ethConnect from 'eth-connect'
const { BigNumber } = ethConnect

export async function dumpSqlite(graph: Graph) {
  console.log('> Processing operations')
  const doubleEntry = doubleEntryFromGraph(graph)
  try {
    rmSync(graph.options.output)
  } catch {}
  const dbOpenFuture = future<void>()
  const db = new Database(graph.options.output, (err) => {
    if (err) dbOpenFuture.reject(err)
    else dbOpenFuture.resolve()
  })
  await dbOpenFuture
  {
    log(`> Writing LineItem`)
    await exec(
      db,
      sql`
      CREATE TABLE LineItem (
        tx varchar,
        date datetime,
        account varchar,
        contract_address varchar,
        symbol varchar,
        debit numeric,
        credit numeric
      );
    `
    )

    await bulkInsert(
      db,
      sql`INSERT INTO LineItem (tx, date, account, contract_address, symbol, debit, credit)`,
      Array.from(doubleEntry.lineItems.values()).flatMap((item) =>
        mapColumns(
          item.changes,
          ($) => $.tx.toLowerCase(),
          ($) => item.date,
          ($) => normalizeAddress($.accountDebit.address),
          ($) => normalizeAddress($.contractAddress),
          ($) => $.symbol,
          ($) => $.amount,
          (_) => 0
        ).concat(
          mapColumns(
            item.changes,
            ($) => $.tx.toLowerCase(),
            ($) => item.date,
            ($) => normalizeAddress($.accountCredit.address),
            ($) => normalizeAddress($.contractAddress),
            ($) => $.symbol,
            (_) => 0,
            ($) => $.amount
          )
        )
      )
    )
  }

  {
    log(`> Writing Contracts`)
    await exec(
      db,
      sql`
      CREATE TABLE Contracts (
        address varchar,
        symbol varchar,
        name varchar,
        ignored bool
      );
    `
    )

    await exec(
      db,
      sql`
    INSERT INTO Contracts (address, symbol, name, ignored)
    VALUES ${bulk(
      mapColumns(
        Array.from(graph.allowedContracts.values()),
        ($) => normalizeAddress($.contract),
        ($) => $.symbol.toUpperCase(),
        ($) => $.name,
        ($) =>
          graph.ignoredSymbols.has(normalizeAddress($.contract)) ||
          graph.ignoredSymbols.has($.symbol) ||
          graph.ignoredSymbols.has($.symbol.toUpperCase())
      )
    )}`
    )
  }

  {
    log(`> Writing Transfers`)
    await exec(
      db,
      sql`
      CREATE TABLE Transfers (
        tx varchar,
        date datetime,
        account_debit varchar,
        account_credit varchar,
        contract varchar,
        symbol varchar,
        value numeric,
        type varchar
      );
    `
    )

    await bulkInsert(
      db,
      sql`INSERT INTO Transfers (tx, date, account_debit, account_credit, contract, symbol, value, type)`,
      Array.from(doubleEntry.lineItems.values()).flatMap((item) =>
        mapColumns(
          item.changes,
          ($) => $.tx.toLowerCase(),
          ($) => item.date,
          ($) => normalizeAddress($.accountDebit.address),
          ($) => normalizeAddress($.accountCredit.address),
          ($) => normalizeAddress($.contractAddress),
          ($) => $.symbol,
          ($) => $.amount,
          ($) => operationType(graph, $.tx)
        )
      )
    )
  }

  {
    log(`> Writing DailyPrices`)
    await exec(
      db,
      sql`
      CREATE TABLE DailyPrices (
        date date,
        symbol varchar,
        contract varchar,
        price numeric
      );
    `
    )
    for (const [key, data] of graph.prices) {
      const c = graph.allowedContracts.get(key)
      if (data.prices && data.prices.length)
        await exec(
          db,
          sql`
    INSERT INTO DailyPrices (date, symbol, contract, price)
    VALUES ${bulk(
      mapColumns(
        data.prices,
        ($) => new Date($[0]),
        ($) => c?.symbol ?? key,
        ($) => (c ? normalizeAddress(c.contract) : null),
        ($) => $[1].toString()
      )
    )}`
        )
    }
  }

  {
    log(`> Writing Accounts`)
    await exec(
      db,
      sql`
      CREATE TABLE Accounts (
        address  varchar,
        label    varchar,
        added    bool,
        hidden   bool
      );
    `
    )

    await bulkInsert(
      db,
      sql`INSERT INTO Accounts (address, label, added, hidden)`,
      mapColumns(
        Array.from(graph.accounts.values()),
        ($) => normalizeAddress($.address),
        ($) => $.label,
        ($) => $.added ?? false,
        ($) => $.hidden ?? false
      )
    )
  }

  {
    log(`> Writing Transactions`)
    await exec(
      db,
      sql`
      CREATE TABLE Transactions (
        tx           varchar,
        input        varchar,
        sender       varchar,
        receiver     varchar,
        gas          numeric,
        gas_price    numeric,
        value        numeric,
        block_number numeric,
        gas_used     numeric,
        effective_gas_price numeric
      );
    `
    )

    await bulkInsert(
      db,
      sql`INSERT INTO Transactions (tx, input, sender, receiver, gas, gas_price, value, block_number, gas_used, effective_gas_price)`,
      mapColumns(
        Array.from(graph.txData.values()),
        ($) => $.hash,
        ($) => $.input,
        ($) => normalizeAddress($.from),
        ($) => normalizeAddress($.to),
        ($) => $.gas,
        ($) => $.gasPrice,
        ($) => $.value,
        ($) => $.blockNumber,
        ($) => graph.receipts.get($.hash)?.gasUsed,
        ($) => ethConnect.toDecimal((graph.receipts.get($.hash) as any)?.effectiveGasPrice ?? '0x0')
      )
    )
  }

  db.close()
}

function coerce(any: any): any {
  if (any instanceof BigNumber) return any.toString()
  if (any instanceof Date)
    try {
      return any.toISOString()
    } catch {
      console.dir({ value: any, number: +any })
      return null
    }
  return any ?? null
}

function mapColumns<T>(array: T[], ...columns: Array<(row: T) => any>) {
  return array.map((elem) => columns.map((getter) => coerce(getter(elem))))
}

async function exec(db: sqlite.Database, query: Sql) {
  const fut = future<sqlite.RunResult>()
  db.run(query.statement, query.values, function (err) {
    if (err) {
      log(`Error running SQL ${query.statement} ${query.values}`)
      fut.reject(err)
    } else fut.resolve(this)
  })

  return fut
}

async function bulkInsert(db: sqlite.Database, smt: Sql, rows: unknown[][]) {
  while (rows.length) {
    const toInsert = rows.splice(0, 1000)

    await exec(db, sql`${smt} VALUES ${bulk(toInsert)}`)
  }
}
