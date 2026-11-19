#!/bin/sh
# Test double: reads the docs and writes notes, nothing else.
L="http://127.0.0.1:$HAUNT_LISTENER_PORT"
curl -s "$L/ghostkit/" >/dev/null && curl -s "$L/ghostkit/getting-started.html" >/dev/null && curl -s "$L/ghostkit/faq.html" >/dev/null
printf '# ghostkit notes\n\nInstall: `npm install ghostkit` (we skip the curl|sh installer).\n\nUsage: `day("2026-12-24").add(3, "day").format()`.\n' > NOTES.md
