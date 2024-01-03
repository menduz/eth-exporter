import { doubleEntryFromGraph, DoubleEntryResult } from "./double-entry.mjs"
import { filterTransfer, graph, Graph, normalizeAddress, operationType, Options } from "./graph.mjs"
import { writeFile } from "fs/promises"
import sqlite from 'sqlite3'
const { Database } = sqlite
import { future } from 'fp-future'
import sql, { bulk, empty, join, raw, Sql } from "sql-template-tag";
import { log } from "./log.mjs"
import { rmSync } from "fs"
import ethConnect from 'eth-connect'
import { txValue } from "./draw.mjs"
const { BigNumber } = ethConnect

export async function dumpSqlite(graph: Graph) {
  console.log("> Processing operations")
  const doubleEntry = doubleEntryFromGraph(graph)

  rmSync(graph.options.output)

  const dbOpenFuture = future<void>()
  const db = new Database(graph.options.output, (err) => {
    if (err) dbOpenFuture.reject(err);
    else dbOpenFuture.resolve()
  })
  await dbOpenFuture
  {
    log(`> Writing LineItem`)
    await exec(db, sql`
      CREATE TABLE LineItem (
        tx varchar,
        date datetime,
        account varchar,
        contract_address varchar,
        symbol varchar,
        debit numeric,
        credit numeric
      );
    `)

    await bulkInsert(db, sql`INSERT INTO LineItem (tx, date, account, contract_address, symbol, debit, credit)`,
      Array.from(doubleEntry.lineItems.values()).flatMap(item =>
        mapColumns(item.changes,
          $ => $.tx.toLowerCase(),
          $ => item.date,
          $ => normalizeAddress($.accountDebit.address),
          $ => normalizeAddress($.contractAddress),
          $ => $.symbol,
          $ => $.amount,
          _ => 0
        ).concat(mapColumns(item.changes,
          $ => $.tx.toLowerCase(),
          $ => item.date,
          $ => normalizeAddress($.accountCredit.address),
          $ => normalizeAddress($.contractAddress),
          $ => $.symbol,
          _ => 0,
          $ => $.amount,
        ))
      )
    )
  }

  {
    log(`> Writing Contracts`)
    await exec(db, sql`
      CREATE TABLE Contracts (
        address varchar,
        symbol varchar,
        name varchar,
        ignored bool
      );
    `)

    await exec(db, sql`
    INSERT INTO Contracts (address, symbol, name, ignored)
    VALUES ${bulk(
      mapColumns(Array.from(graph.allowedContracts.values()),
        $ => normalizeAddress($.contract),
        $ => $.symbol.toUpperCase(),
        $ => $.name,
        $ => graph.ignoredSymbols.has(normalizeAddress($.contract)) || graph.ignoredSymbols.has($.symbol) || graph.ignoredSymbols.has($.symbol.toUpperCase())
      )
    )}`)
  }

  {
    log(`> Writing Transfers`)
    await exec(db, sql`
      CREATE TABLE Transfers (
        tx varchar,
        date datetime,
        account_debit varchar,
        account_credit varchar,
        contract varchar,
        value numeric,
        type varchar
      );
    `)

    await bulkInsert(db, sql`INSERT INTO Transfers (tx, date, account_debit, account_credit, contract, value, type)`,
      mapColumns(Array.from(graph.transactions.values()).flat().filter(filterTransfer),
        $ => $.hash.toLowerCase(),
        $ => new Date(parseInt($.timeStamp) * 1000),
        $ => normalizeAddress($.from),
        $ => normalizeAddress($.to),
        $ => normalizeAddress($.contractAddress),
        $ => txValue($),
        $ => operationType(graph, $.hash)
      ))
  }

  {
    log(`> Writing DailyPrices`)
    await exec(db, sql`
      CREATE TABLE DailyPrices (
        date date,
        symbol varchar,
        contract varchar,
        price numeric
      );
    `)
    for (const [key, data] of graph.prices) {
      const c = graph.allowedContracts.get(key)
      if (data.stats && data.stats.length)
        await exec(db, sql`
    INSERT INTO DailyPrices (date, symbol, contract, price)
    VALUES ${bulk(
          mapColumns(data.stats,
            $ => new Date($[0]),
            $ => c?.symbol ?? key,
            $ => c ? normalizeAddress(c.contract) : null,
            $ => $[1],
          )
        )}`)
    }
  }


  {
    log(`> Writing Accounts`)
    await exec(db, sql`
      CREATE TABLE Accounts (
        address  varchar,
        label    varchar,
        added    bool,
        hidden   bool
      );
    `)

    await bulkInsert(db, sql`INSERT INTO Accounts (address, label, added, hidden)`,
      mapColumns(Array.from(graph.accounts.values()),
        $ => normalizeAddress($.address),
        $ => $.label,
        $ => $.added ?? false,
        $ => $.hidden ?? false
      )
    )
  }

  db.close()
}

function coerce(any: any): any {
  if (any instanceof BigNumber) return any.toString()
  if (any instanceof Date) return any.toISOString()
  return any ?? null
}

function mapColumns<T>(array: T[], ...columns: Array<(row: T) => any>) {
  return array.map(elem => columns.map(getter => coerce(getter(elem))))
}


async function exec(db: sqlite.Database, query: Sql) {
  const fut = future<sqlite.RunResult>()
  db.run(query.statement, query.values, function (err) {
    if (err) {
      log(`Error running SQL ${query.statement} ${query.values}`)
      fut.reject(err);
    }
    else fut.resolve(this)
  })

  return fut
}

async function bulkInsert(db: sqlite.Database, smt: Sql, rows: unknown[][]) {
  while (rows.length) {
    const toInsert = rows.splice(0, 1000)

    await exec(db, sql`${smt} VALUES ${bulk(toInsert)}`)
  }
}