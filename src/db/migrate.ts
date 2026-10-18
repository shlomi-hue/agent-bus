import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dbErrorCode } from "../errors.js";
import type { SqlClient } from "./types.js";

function isMissingMigrationsTable(error: unknown): boolean {
  if (dbErrorCode(error) === "42P01") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("schema_migrations") && message.includes("does not exist");
}

async function isApplied(db: SqlClient, id: string): Promise<boolean> {
  try {
    const result = await db.query<{ id: string }>(
      "select id from public.schema_migrations where id = $1",
      [id],
    );
    return result.rows.length > 0;
  } catch (error) {
    if (isMissingMigrationsTable(error)) return false;
    throw error;
  }
}

export async function applyMigrations(db: SqlClient, directory: string): Promise<string[]> {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    if (await isApplied(db, id)) continue;
    await db.exec(readFileSync(join(directory, file), "utf8"));
    applied.push(id);
  }
  return applied;
}
