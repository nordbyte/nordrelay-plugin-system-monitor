#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPlugin } from "./src/runtime.js";

export * from "./src/runtime.js";
export * from "./src/processes.js";
export * from "./src/collectors.js";
export * from "./src/commands.js";
export * from "./src/format.js";
export * from "./src/history.js";
export * from "./src/storage.js";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPlugin().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, stderr: message })}\n`);
    process.exitCode = 1;
  });
}
