import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

let sqlClient: ReturnType<typeof postgres> | undefined;

/** Lazily creates the singleton Postgres connection + Drizzle client. */
export function getDb() {
  if (!sqlClient) {
    sqlClient = postgres(requireEnv("DATABASE_URL"), { max: 10 });
  }
  return drizzle(sqlClient, { schema });
}

export type Db = ReturnType<typeof getDb>;
