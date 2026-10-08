import { text } from "node:stream/consumers";
import { hashPassword } from "../src/api/auth.ts";

// Reads stdin so the password never lands in argv or shell history.
const password = (await text(process.stdin)).replace(/\r?\n$/, "");
// Login has no attempt limit, so the password's length is what makes guessing it infeasible.
const MIN_LENGTH = 16;
if (password.length < MIN_LENGTH) {
  throw new Error(`Pipe a password of at least ${MIN_LENGTH} characters on stdin`);
}
process.stdout.write(`${await hashPassword(password)}\n`);
