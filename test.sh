#sudo apt-get update
#sudo apt-get install --yes graphviz sqlite3

set -x
npm run build
rm -rf hledger-out || true
./dist/index.mjs poap.cfg --format=investment --output=invesments-out #--includeFees
./dist/index.mjs poap.cfg --format=hledger --output=hledger-out #--includeFees

hledger --version > hledger-out/version
hledger -f hledger-out/hledger.journal check --infer-equity
hledger -f hledger-out/hledger.journal bal --tree --pretty -Y --layout=bare > hledger-out/balance
hledger -f hledger-out/hledger.journal bal --tree --pretty -Y --layout=bare -O json > hledger-out/balance.json
hledger -f hledger-out/hledger.journal print --show-cost --infer-cost --infer-equity --infer-market-prices -s --explicit --round=soft > hledger-out/print
hledger -f hledger-out/hledger.journal bs --tree --yearly --market --infer-cost --infer-equity --infer-market-prices -s --pretty > hledger-out/value

./dist/index.mjs poap.cfg --format=sqlite --output=poap.db
./dist/index.mjs poap.cfg --format=csv --output=poap.csv --includeFees
./dist/index.mjs poap.cfg --format=dot --output=poap.dot --startDate=2023-01-01T00:00:00Z

dot poap.dot -T pdf -O
