#!/usr/bin/env node
import { runPlugin } from "./src/runtime.js";

export * from "./src/runtime.js";
export * from "./src/processes.js";

if (process.argv[1] && process.argv[1] === new URL(import.meta.url).pathname) {
  runPlugin().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.stdout.write(`${JSON.stringify({ ok: false, stderr: message })}\n`);
    process.exitCode = 1;
  });
}
