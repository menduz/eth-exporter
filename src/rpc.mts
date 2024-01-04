
import ethConnect from "eth-connect"
const { RequestManager, HTTPProvider, SolidityEvent } = ethConnect
import { promisify } from "util"
import { cacheHit, readCache, sha256hash, writeCache } from "./fetcher.mjs"

function providerWithCache(provider: { sendAsync(data: any, callback: ethConnect.Callback): void }) {
  const sendAsyncPromise = promisify<any, any>(provider.sendAsync.bind(provider))

  return {
    sendAsync(data: any, callback: ethConnect.Callback) {

      const key = "eth-" + sha256hash(JSON.stringify({ method: data.method, params: data.params }))
      execWithCacheKey(key, () => sendAsyncPromise(data))
        .then((result) => callback(null, result))
        .catch((err) => callback(err))
    },
  }
}

const providerInstance = new HTTPProvider("https://rpc.decentraland.org/mainnet")
providerInstance.debug = true

export const requestManager = new RequestManager(providerWithCache(providerInstance))

export async function getEventsWithCache(tx: string) {
  const receipt = await requestManager.eth_getTransactionReceipt(tx)

  let allEvents = new SolidityEvent(
    requestManager,
    {
      type: "event",
      name: "Transfer",
      inputs: [
        {
          name: "from",
          type: "address",
        },
        {
          name: "to",
          type: "address",
        },
        {
          name: "amount",
          type: "uint256",
        },
      ],
    },
    receipt.contractAddress
  )

  // console.dir({receipt, decoded: allEvents.decode(receipt as any) })
  // for (const log of receipt.logs) {
  //   const data = await getLogsData(log.blockNumber, log.topics)
  //   console.dir(data)
  // }
}

// export function getLogsData(blockNumber: any, topics: string[]) {
//   return execWithCacheKey(`receip${blockNumber}${topics}`, async () => {
//     return await requestManager.eth_getLogs({ fromBlock: blockNumber, toBlock: blockNumber, topics })
//   })
// }

export async function execWithCacheKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hash = sha256hash(key)
  if (cacheHit(hash)) {
    return readCache(hash)
  } else {
    const data = await fn()
    writeCache(hash, data)
    return data
  }
}
