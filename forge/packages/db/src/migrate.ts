/** Run pending migrations: `npm run migrate --workspace packages/db`. */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Missing required env var: DATABASE_URL");

const sql = postgres(databaseUrl, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./migrations" });
await sql.end();
console.log("Migrations applied.");
