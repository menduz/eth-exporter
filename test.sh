#sudo apt-get update
#sudo apt-get install --yes graphviz sqlite3

npm run build
./dist/index.mjs poap.cfg --format=hledger --output=hledger-out
./dist/index.mjs poap.cfg --format=sqlite --output=poap.db
./dist/index.mjs poap.cfg --format=csv --output=poap.csv --includeFees
./dist/index.mjs poap.cfg --format=dot --output=poap.dot --startDate=2023-01-01T00:00:00Z

dot poap.dot -T pdf -O
