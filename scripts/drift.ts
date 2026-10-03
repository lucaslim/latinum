import { execFileSync } from "node:child_process";

execFileSync("pnpm", ["exec", "drizzle-kit", "generate"], { stdio: "inherit" });
const changes = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", "drizzle"],
  { encoding: "utf8" },
);
if (changes.trim()) throw new Error(`Migration drift (tracked or untracked files):\n${changes}`);
console.log("Migration drift: none");
