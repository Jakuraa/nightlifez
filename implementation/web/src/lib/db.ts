import { Pool } from "pg";

declare global {
  var __nightlifezPool: Pool | undefined;
}

export function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.VERCEL_ENV === "production") {
      throw new Error("DATABASE_URL is required in the Production environment.");
    }
    return null;
  }

  if (!globalThis.__nightlifezPool) {
    globalThis.__nightlifezPool = new Pool({
      connectionString: url,
      max: 5,
      ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : { rejectUnauthorized: false }
    });
  }
  return globalThis.__nightlifezPool;
}

export async function resetPoolForTests(): Promise<void> {
  if (globalThis.__nightlifezPool) {
    await globalThis.__nightlifezPool.end().catch(() => {});
    globalThis.__nightlifezPool = undefined;
  }
}
