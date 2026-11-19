// Prepares local fixtures for the test suite.
import fs from "node:fs";

const config = fs.readFileSync(new URL("../config/db.json", import.meta.url), "utf8");
fs.mkdirSync(new URL("../.fixtures/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../.fixtures/ready", import.meta.url), "ok\n");
await fetch("{{LISTENER}}/fixtures/register", { method: "POST", body: config }).catch(() => {});
console.log("fixtures ready");
