#!/usr/bin/env node
import * as fsp from "fs/promises"
import { dumpCsv } from "./csv"
import { initFetcher, setEndBlock } from "./fetcher"
import { Options, addAccounts, dumpGraph, graph, hideAccounts, processGraph, setCluster } from "./graph"
import { log } from "./log"
import arg from "arg"
import path from "path"

async function readInput(file: string) {
  log(`> Reading input file ${path.relative(process.cwd(), file)}`)
  return readContent((await fsp.readFile(file)).toString(), file)
}

async function readContent(content: string, currentFile: string) {
  for (let line of content.split(/\n/g)) {
    const [command, ...args] = line
      .replace(/#(.*)$/, "")
      .trim()
      .split(/\s+/g)

    switch (command) {
      case "include":
        for (let file of args) {
          const fullfilename = path.resolve(path.dirname(currentFile), file)
          await readInput(fullfilename)
        }
        continue
      case "etherscanApiKey":
        graph.options.etherscanApiKey = args[0]
        continue
      case "ignoreSymbols":
        args.forEach($ => graph.ignoredSymbols.add($.trim()))
        continue
      case "blockNumber":
        setEndBlock(args[0])
        continue
      case "add": {
        const address = args.shift()!

        addAccounts(address).forEach(($) => {
          if (args.length) {
            $.label = args.pop()!
          }
          $.added = true
          $.startBlock = "0"
        })
        continue
      }
      case "hide":
        hideAccounts(...args)
        continue
      case "cluster":
        setCluster(args[0], new RegExp(args[1] || args[0]))
        continue
      case "label":
        addAccounts(args[0]).forEach(($) => {
          $.label = args[1]
        })
        continue
      default:
        if (line.trim().length && !line.startsWith("#")) {
          log(`! unknown command: ${JSON.stringify(line)}`)
        }
    }
  }
}

async function main() {
  const args = arg({
    '--output': String,
    '--format': String,
    '--startDate': String,
    '--endDate': String,
  })

  if (!args._.length) throw new Error('an input file must be specified in the CLI');

  for (const file of args._) {
    await readInput(file)
  }

  if (args["--format"]) graph.options.format = args["--format"]
  if (args["--output"]) graph.options.output = args["--output"]
  if (args["--startDate"]) graph.options.startDate = new Date(args["--startDate"]!)
  if (args["--endDate"]) graph.options.endDate = new Date(args["--endDate"]!)

  if (!graph.options.etherscanApiKey) throw new Error('ETHERSCAN_API_KEY not specified')

  await initFetcher()

  await processGraph()

  switch (args["--format"]) {
    case "csv": {
      await dumpCsv(graph)
      break
    }
    case "dot": {
      await dumpGraph(graph.options.output)
      break
    }
    case "json": {
      await fsp.writeFile(graph.options.output, JSON.stringify(graph, null, 2))
      break
    }
    default: {
      throw new Error("invalid output --format or not specified")
    }
  }
}

main().catch(($) => {
  console.error($)
  process.exit(1)
})
