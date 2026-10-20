import { Pool } from "pg";

const pool = new Pool();

export async function similaritySearch(source: string, limit: number) {
  const result = await pool.query(
    `SELECT id, content FROM documents WHERE metadata->>'source' = '${source}' LIMIT ${limit}`,
  );
  return result.rows;
}
