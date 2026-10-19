import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function findUsers(name: string) {
  const result = await pool.query("SELECT id, email FROM users WHERE name LIKE $1", [`%${name}%`]);
  return result.rows;
}
