import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }

  return files;
}

const files = [
  ...await javascriptFiles("src"),
  ...await javascriptFiles("tests"),
  ...await javascriptFiles("scripts"),
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exitCode = 1;
}

if (!process.exitCode) {
  console.log(`Syntax checked ${files.length} JavaScript files.`);
}

