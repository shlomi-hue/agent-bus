#!/usr/bin/env node
import { main } from "./cli.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  process.stderr.write(`agent-bus-listener needs Node >= 20 (running ${process.version} at ${process.execPath})\n`);
  process.exit(1);
}
main(process.argv.slice(2)).then(
  (code) => {
    if (typeof code === "number") process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`agent-bus-listener: ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
