import path from "node:path";
import { stat } from "node:fs/promises";

export async function fileSize(file) {
  try {
    return (await stat(file)).size;
  } catch {
    return 0;
  }
}

export async function databaseFilesSize(databaseFile) {
  return (await fileSize(databaseFile)) + (await fileSize(`${databaseFile}-wal`)) + (await fileSize(`${databaseFile}-shm`));
}

export async function databaseHealth(db, dataDir, databaseName) {
  const database = path.join(dataDir, databaseName);
  const wal = `${database}-wal`;
  const shm = `${database}-shm`;
  const integrity = safeGet(db, "PRAGMA integrity_check");
  const pageCount = safeGet(db, "PRAGMA page_count");
  const pageSize = safeGet(db, "PRAGMA page_size");
  const freelistCount = safeGet(db, "PRAGMA freelist_count");
  const walBytes = await fileSize(wal);
  const shmBytes = await fileSize(shm);
  const databaseBytes = await fileSize(database);
  const warnings = [];
  if (String(integrity?.integrity_check || "").toLowerCase() !== "ok") warnings.push("SQLite integrity check did not return ok.");
  if (walBytes > Math.max(64 * 1024 * 1024, databaseBytes)) warnings.push("WAL file is large; run checkpoint.");
  if (Number(freelistCount?.freelist_count || 0) > Math.max(1000, Number(pageCount?.page_count || 0) * 0.25)) warnings.push("SQLite freelist is high; cleanup plus vacuum may reclaim space.");
  return {
    database,
    databaseBytes,
    walBytes,
    shmBytes,
    sizeBytes: databaseBytes + walBytes + shmBytes,
    pageCount: Number(pageCount?.page_count) || 0,
    pageSize: Number(pageSize?.page_size) || 0,
    freelistCount: Number(freelistCount?.freelist_count) || 0,
    integrity: String(integrity?.integrity_check || "unknown"),
    warnings,
  };
}

export function checkpointDatabase(db, mode = "TRUNCATE") {
  const safeMode = ["PASSIVE", "FULL", "RESTART", "TRUNCATE"].includes(String(mode).toUpperCase()) ? String(mode).toUpperCase() : "TRUNCATE";
  return db.prepare(`PRAGMA wal_checkpoint(${safeMode})`).all();
}

export function optimizeDatabase(db) {
  db.exec("PRAGMA optimize");
}

function safeGet(db, sql) {
  try {
    return db.prepare(sql).get();
  } catch {
    return {};
  }
}
