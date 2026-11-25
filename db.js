import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("Missing env DATABASE_URL");

// Neon requires SSL; the connection string from Neon already includes sslmode=require.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const q = (text, params) => pool.query(text, params);
