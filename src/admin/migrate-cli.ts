import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPgPool, poolClient } from "../db/pg-store.js";
import { applyMigrations } from "../db/migrate.js";
import { assertAdminSecret, loadDotEnv } from "../env.js";

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === entry;
}

async function main(): Promise<void> {
  loadDotEnv();
  assertAdminSecret(process.env.ADMIN_SECRET);
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "db:migrate needs DATABASE_URL. On Supabase, paste supabase/migrations/20261015120000_init.sql into the SQL editor instead.",
    );
  }
  const pool = createPgPool(databaseUrl);
  try {
    const directory = join(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");
    const applied = await applyMigrations(poolClient(pool), directory);
    if (applied.length === 0) console.log("migrations up to date");
    else console.log(`applied ${applied.join(", ")}`);
  } finally {
    await pool.end();
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exit(1);
  });
}
