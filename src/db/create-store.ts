import { createPgPool, PgStore, poolClient } from "./pg-store.js";
import { createSupabaseStore } from "./supabase-store.js";
import type { Store } from "./types.js";

const pools = new Map<string, ReturnType<typeof createPgPool>>();
const supabaseStores = new Map<string, Store>();

export function createStoreFromEnv(env: NodeJS.ProcessEnv): Store {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    let pool = pools.get(databaseUrl);
    if (!pool) {
      pool = createPgPool(databaseUrl);
      pools.set(databaseUrl, pool);
    }
    return new PgStore(poolClient(pool));
  }

  const supabaseUrl = env.SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || env.SUPABASE_SECRET_KEY?.trim();
  if (supabaseUrl && serviceRoleKey) {
    const key = `${supabaseUrl}\0${serviceRoleKey}`;
    let store = supabaseStores.get(key);
    if (!store) {
      store = createSupabaseStore(supabaseUrl, serviceRoleKey);
      supabaseStores.set(key, store);
    }
    return store;
  }

  throw new Error(
    "Set DATABASE_URL for local Postgres, or SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for Supabase.",
  );
}
