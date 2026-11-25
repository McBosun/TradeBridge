// Creates the tables (safe to run many times) and, if ADMIN_EMAIL and ADMIN_PASSWORD
// are set, creates the first admin account once. Remove ADMIN_PASSWORD afterwards.
import { readFileSync } from "node:fs";
import bcrypt from "bcryptjs";
import { pool, q } from "../db.js";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
await q(schema);
console.log("Database schema is ready.");

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
if (email && password) {
  if (password.length < 12) throw new Error("ADMIN_PASSWORD must be at least 12 characters");
  const hash = await bcrypt.hash(password, 12);
  const r = await q(
    `insert into users (name,email,password_hash,role,verified)
     values ('Admin',$1,$2,'admin',true) on conflict (email) do nothing`,
    [email, hash]
  );
  console.log(r.rowCount ? "Admin account created." : "Admin account already exists, left unchanged.");
}
await pool.end();
