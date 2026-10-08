import { text } from "node:stream/consumers";
import { hashPassword } from "../src/api/auth.ts";

// Reads stdin so the password never lands in argv or shell history.
const password = (await text(process.stdin)).replace(/\r?\n$/, "");
if (!password) throw new Error("Pipe the password on stdin");
process.stdout.write(`${await hashPassword(password)}\n`);
