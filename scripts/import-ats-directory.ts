#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
/**
 * Bulk-import the LastRound ATS company directory into D1 ats_boards.
 *
 * Usage:
 *   bun scripts/import-ats-directory.ts --remote
 *   bun scripts/import-ats-directory.ts --local
 *   bun scripts/import-ats-directory.ts --remote --dry-run
 *
 * Existing priority / inactive boards are preserved. New rows land as tier=standard.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const CSV_PATH = resolve(import.meta.dirname, "../data/ats-company-directory-2026-08.csv");
const BATCH_SIZE = 150;
const STAMP = "2026-08-10T00:00:00.000Z";

type Vendor = "greenhouse" | "lever" | "ashby";

interface BoardRow {
  provider: Vendor;
  companyName: string;
  slug: string;
}

function parseArgs(argv: string[]) {
  return {
    remote: argv.includes("--remote"),
    local: argv.includes("--local") || !argv.includes("--remote"),
    dryRun: argv.includes("--dry-run"),
  };
}

/** Minimal CSV parser for quoted fields. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") continue;
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function boardId(provider: Vendor, slug: string): string {
  return createHash("sha1").update(`${provider}:${slug}`).digest("hex").slice(0, 20);
}

function loadBoards(path: string): BoardRow[] {
  const raw = readFileSync(path, "utf8");
  const rows = parseCsv(raw);
  const header = rows[0] ?? [];
  const vendorIdx = header.indexOf("ats_vendor");
  const nameIdx = header.indexOf("company_name");
  const slugIdx = header.indexOf("board_slug");
  if (vendorIdx < 0 || nameIdx < 0 || slugIdx < 0) {
    throw new Error(`Unexpected CSV header: ${header.join(",")}`);
  }

  const out: BoardRow[] = [];
  const seen = new Set<string>();
  for (const cols of rows.slice(1)) {
    const vendor = (cols[vendorIdx] ?? "").trim().toLowerCase();
    const companyName = (cols[nameIdx] ?? "").trim();
    const slug = (cols[slugIdx] ?? "").trim();
    if (!companyName || !slug) continue;
    if (vendor !== "greenhouse" && vendor !== "lever" && vendor !== "ashby") continue;
    const key = `${vendor}:${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider: vendor, companyName, slug });
  }
  return out;
}

function buildBatchSql(batch: BoardRow[]): string {
  const values = batch
    .map((b) => {
      const id = boardId(b.provider, b.slug);
      return `(${sqlString(id)}, ${sqlString(b.provider)}, ${sqlString(b.slug)}, ${sqlString(b.companyName)}, 'standard', 1, NULL, NULL, NULL, ${sqlString(STAMP)}, ${sqlString(STAMP)})`;
    })
    .join(",\n");

  return `INSERT INTO ats_boards (
  id, provider, slug, company_name, tier, active, sector, last_polled_at, last_status, created_at, updated_at
) VALUES
${values}
ON CONFLICT(provider, slug) DO UPDATE SET
  company_name = excluded.company_name,
  tier = CASE WHEN ats_boards.tier = 'priority' THEN ats_boards.tier ELSE excluded.tier END,
  active = CASE WHEN ats_boards.active = 0 THEN 0 ELSE excluded.active END,
  updated_at = excluded.updated_at;`;
}

function runSql(sql: string, remote: boolean): void {
  const args = [
    "wrangler",
    "d1",
    "execute",
    "job-maxxing",
    ...(remote ? ["--remote"] : ["--local"]),
    "--command",
    sql,
  ];
  const result = spawnSync("bunx", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`wrangler d1 execute failed (exit ${result.status})`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.remote && !args.local) {
    console.error("Pass --remote and/or --local");
    process.exit(1);
  }
  // Prefer explicit --remote when both set via default local=true; fix:
  const remote = args.remote;
  const boards = loadBoards(CSV_PATH);
  console.log(`Loaded ${boards.length} boards from ${CSV_PATH}`);
  const byVendor = boards.reduce<Record<string, number>>((acc, b) => {
    acc[b.provider] = (acc[b.provider] ?? 0) + 1;
    return acc;
  }, {});
  console.log(byVendor);

  if (args.dryRun) {
    console.log(`Dry run: would upsert ${boards.length} boards in batches of ${BATCH_SIZE}`);
    return;
  }

  const target = remote ? "remote" : "local";
  console.log(`Importing into ${target} D1…`);
  for (let i = 0; i < boards.length; i += BATCH_SIZE) {
    const batch = boards.slice(i, i + BATCH_SIZE);
    const sql = buildBatchSql(batch);
    process.stdout.write(
      `  batch ${i / BATCH_SIZE + 1}/${Math.ceil(boards.length / BATCH_SIZE)} (${batch.length} rows)… `,
    );
    runSql(sql, remote);
    console.log("ok");
  }
  console.log("Done.");
}

main();
