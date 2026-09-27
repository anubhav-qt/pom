// Runs a Node server as several processes on one port, so the ThinkPad's cores share its
// work: a slow page (a report, a PDF, a reel being drawn) holds up one process, not all.
// Node hands each new connection to the next process in turn, and replaces one that dies.
//
//   node /cluster.cjs server.js
//
// PROCESSES: how many ("auto": one per core, up to 8). compose.yml mounts this file into
// the storefront and OMS containers; their images run fine without it, as one process.
"use strict";

const cluster = require("node:cluster");
const os = require("node:os");
const path = require("node:path");

const setting = (process.env.PROCESSES || "auto").trim();
const count = setting === "auto" ? Math.min(os.availableParallelism(), 8) : Math.max(1, Number.parseInt(setting, 10) || 1);
const app = path.resolve(process.argv[2] || "server.js");

if (count === 1 || !cluster.isPrimary) {
  require(app);
} else {
  console.log(`starting ${count} processes of ${app}`);
  let stopping = false;
  for (let i = 0; i < count; i++) cluster.fork();

  cluster.on("exit", (worker, code, signal) => {
    if (stopping) {
      if (Object.keys(cluster.workers).length === 0) process.exit(0);
      return;
    }
    console.error(`process ${worker.process.pid} ended (${signal || `code ${code}`}); starting another`);
    setTimeout(() => cluster.fork(), 1000);
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      stopping = true;
      for (const worker of Object.values(cluster.workers)) worker.process.kill(signal);
    });
  }
}
