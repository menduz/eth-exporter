# eth-exporter

```bash
# this is an example configuration file named "poap.cfg"

blockNumber 17773460

# etherscanApiKey AAAAAAAAAAAAAAAAAAAAAAAAAAAASD
# (can also be specified as env var ETHERSCAN_API_KEY)

# coingeckoApiKey CG-AAAAAAAAAAAAAAAAAAAAA
# (can also be specified as env var COINGECKO_API_KEY)

add 0xf6B6F07862A02C85628B3A9688beae07fEA9C863 poap.xyz 
```


Then run the following command to extract the transactions to a CSV file

```bash
npx eth-exporter poap.cfg --format=csv --output=poap.csv
npx eth-exporter poap.cfg --format=dot --output=poap.dot
```

A `.cache` folder will be created on the current working directory to reduce the total amount of RPC and API calls in future runs.