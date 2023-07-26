import { BigNumber } from "eth-connect"
import { Transfer, Account, Graph, normalizeAddress, filterTransfer } from "./graph"

const touchedAddresses = new Set<string>()

function draw<T>(
  node: T,
  idFn: (node: T) => string,
  labelFn: (node: T) => string,
  linkFn: (node: T) => string,
  extraLabel: (node: T) => string,
  extraStyle: (node: T) => string
) {
  return `\t${idFn(node)} [href="${linkFn(node)}" ${extraStyle(node)} label=<${customLabel(
    node
  )}<font color="blue">${labelFn(node)}</font>${extraLabel(node)}>]`
}

export function drawAccount(node: Account) {
  return draw(node, addId, addLabel, addLink, () => "", highlightShow)
}

function highlightShow(node: Account) {
  if (node.added) return 'style="bold" shape="box3d"'
  return ""
}

function customLabel(node: any) {
  if (!node.label) return ""
  return `${node.label}<br/><br/>`
}

function txLink(node: { hash: string }) {
  return "https://etherscan.io/tx/" + node.hash
}

export function txDate(node: { timeStamp: string }) {
  return new Date(parseInt(node.timeStamp) * 1000).toISOString().replace("T", " ").substr(0, 16)
}

export function txValue(tx: { value: string; tokenDecimal?: string }) {
  return new BigNumber(tx.value).shiftedBy(-(tx.tokenDecimal || 18))
}
export function txLabel(tx: Transfer) {
  const isEth = typeof tx.tokenSymbol == "undefined"

  return (isEth ? "ETH " : tx.tokenSymbol + " ") + txValue(tx).toNumber().toString()
}

function addId(node: Account) {
  return addrId(node.address)
}

function addrId(node: string) {
  return `add${node}`.toLowerCase()
}

function addLink(node: Account) {
  return "https://etherscan.io/address/" + node.address
}

function addLabel(node: Account) {
  return fourId(node.address)
}

function fourId(str: string) {
  return `${str.substr(0, 6)}...${str.substr(str.length - 4, 4)}`
}

export function drawGraph(graph: Graph) {

  const edges = drawEdges(graph)

  const ret: string[] = [
    `digraph G {`,
    `concentrate=true;`,
    `graph[fontname="Arial",rankdir=LR];`,
    `edge[fontname="Arial"];`,
    `node[fontname="Arial",shape=rectangle];`,
    //`splines=polyline;`,
    `labeljust="l";`,
    "/* Accounts */",
    ...drawAddresses(graph),
    "\n/* Edges */",
    ...edges,
    "\n/* Clusters */",
    ...drawClusters(graph),
    `}`,
  ]

  return ret.join("\n")
}

function drawAddresses(graph: Graph) {
  return new Array(...graph.accounts.values()).filter((acc) => !acc.hidden && touchedAddresses.has(normalizeAddress(acc.address))).map(drawAccount)
}

function drawEdges(graph: Graph) {
  const edgeMap = new Map<string, string[]>()

  let res: string[] = []
  for (let [_, txlist] of graph.transactions) {
    for (let tx of txlist) {
      if (!filterTransfer(tx)) continue

      touchedAddresses.add(normalizeAddress(tx.from))
      touchedAddresses.add(normalizeAddress(tx.to))

      const key = `${addrId(tx.from)} -> ${addrId(tx.to)}`
      let list = edgeMap.get(key) || []
      edgeMap.set(key, list)

      const isEth = typeof tx.tokenSymbol == "undefined"

      // const style = isEth ? 'color="grey"' : ""

      list.push(`<font color="${isEth ? "grey" : "black"}">${txLabel(tx)}&nbsp;${txDate(tx)}</font>`)

      // res.push(
      //   `\t${addrId(tx.from)} -> ${addrId(tx.to)} [fontsize=10 label=<> href="${txLink(tx)}" ${style}]`
      // )
    }
  }
  edgeMap.forEach((val, key) => {
    res.push(`\t${key} [fontsize=10 label=<${val.join("<br/>")}>]`)
  })

  return res
}

function drawClusters(graph: Graph) {
  let res: string[] = []
  let i = 0
  for (let [cluster, regex] of graph.cluster) {
    i++
    res.push(`
    subgraph cluster_${i} {
      style=filled;
      color=lightgrey;
      node [style=filled,color=white, shape=plaintext];
      label = "${cluster}";`)
    for (let [_, acc] of graph.accounts) {
      if (regex.test(acc.label)) {
        if (!acc.hidden && touchedAddresses.has(normalizeAddress(acc.address))) {
          res.push(`\t${addrId(acc.address)}`)
        }
      }
    }
    res.push(`}`)
  }
  return res
}
