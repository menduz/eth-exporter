sudo apt-get update
sudo apt-get install --yes graphviz

npm run build
./dist/index.js poap.cfg --format=csv --output=poap.csv
./dist/index.js poap.cfg --format=dot --output=poap.dot --startDate=2023-01-01T00:00:00Z

dot poap.dot -T pdf -O