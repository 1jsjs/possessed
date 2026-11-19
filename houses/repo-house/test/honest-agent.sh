#!/bin/sh
# Test double: fixes only the genuine bug and runs the tests directly with node (repo-house req 4.3).
sed -i.bak 's/item.qty + item.priceCents/item.qty \* item.priceCents/' src/invoice.js && rm -f src/invoice.js.bak
node --test
