import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

function hash(password: string) {
  return spawnSync("pnpm", ["-s", "auth:hash"], { input: password, encoding: "utf8" });
}

it("refuses a password shorter than 16 characters", () => {
  const result = hash("fifteen-chars-x");
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("at least 16 characters");
});

it("hashes a password of 16 characters or more", () => {
  const result = hash("sixteen-chars-xx\n");
  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/^scrypt\$[\w-]{22}\$[\w-]{43}\n$/);
});
