#!/usr/bin/env node

import { spawn } from "node:child_process";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const hasPort = args.some((arg) => arg === "--port");
  const forwardedArgs = hasPort ? args : ["--port", "4191", ...args];

  await run("npm", ["run", "build"]);
  await run(process.execPath, ["scripts/start-game.mjs", "--name", "48か月ボード", ...forwardedArgs]);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
