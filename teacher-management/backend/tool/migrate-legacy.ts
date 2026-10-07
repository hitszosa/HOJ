#!/usr/bin/env bun
import { pbkdf2, randomBytes } from "node:crypto";
import { parseArgs, promisify } from "node:util";
import { createConnection, type Connection } from "mysql2/promise";
import { z } from "zod";

// Run during maintenance, after backing up the database. This is deliberately
// separate from the backend and has no rollback or recovery-state machinery.
const derive = promisify(pbkdf2);
const version = "20260918000000";
const baseline = await Bun.file(
  new URL(`../migrations/${version}_baseline/up.sql`, import.meta.url),
).text();
const statements = baseline
  .split(";")
  .map((value) => value.replace(/^--.*$/gm, "").trim())
  .filter(Boolean);
const tableStatements = statements.filter((value) =>
  value.startsWith("CREATE TABLE"),
);
const indexStatements = statements.filter((value) =>
  /^CREATE (UNIQUE )?INDEX /.test(value),
);
const foreignKeys = statements.filter((value) =>
  value.startsWith("ALTER TABLE"),
);
const legacyPassword = /^[0-9a-fA-F]{96}$/;
const wrappedPassword =
  /^pbkdf2_sha256_legacy\$v1\$(\d+)\$[0-9a-fA-F]{32}\$[0-9a-fA-F]{32}\$[0-9a-fA-F]{64}$/;
const passwordRows = z.array(
  z.object({ id: z.string(), password: z.string() }),
);
const countRows = z.array(
  z.object({ n: z.coerce.number().int().nonnegative() }),
);
const nameRows = z.array(z.object({ name: z.string() }));
const versions = [
  "20250621025115",
  "20250622035123",
  "20250630055947",
  "20250701063016",
  "20251015035304",
  "20260306090000",
  "20260416090000",
  "20260501090000",
  "20260509120000",
  "20260512120000",
];

class MigrationError extends Error {}
function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new MigrationError(message);
}

async function count(db: Connection, sql: string): Promise<number> {
  const [result] = await db.query(sql);
  const rows = countRows.parse(result);
  requireCondition(rows.length === 1, "Expected a single aggregate result");
  return rows[0]!.n;
}

async function tableNames(db: Connection): Promise<Set<string>> {
  const [result] = await db.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
  );
  return new Set(nameRows.parse(result).map((row) => row.name));
}

async function* passwordBatches(db: Connection) {
  let after: string | null = null;
  while (true) {
    // Order by the numeric column, not the string alias used to preserve BIGINT IDs.
    const [result] = await db.execute(
      "SELECT CAST(id AS CHAR) AS id,password FROM users WHERE ? IS NULL OR users.id>CAST(? AS SIGNED) ORDER BY users.id LIMIT 128",
      [after, after],
    );
    const rows = passwordRows.parse(result);
    if (rows.length === 0) return;
    after = rows[rows.length - 1]!.id;
    yield rows;
  }
}

async function preflight(db: Connection): Promise<number> {
  const [history] = await db.query(
    "SELECT CAST(version AS CHAR) AS version,success FROM _sqlx_migrations ORDER BY version",
  );
  const applied = z
    .array(z.object({ version: z.string(), success: z.coerce.number() }))
    .parse(history);
  requireCondition(
    [7, 10].includes(applied.length) &&
      applied.every(
        (row, index) => row.success === 1 && row.version === versions[index],
      ),
    "Expected the known seven- or ten-migration database",
  );
  const checks: [string, string][] = [
    [
      "duplicate assignment/user submissions",
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM submissions GROUP BY assignment_id,user_id HAVING COUNT(*)>1) d",
    ],
    [
      "ambiguous file associations",
      "SELECT COUNT(*) AS n FROM (SELECT file_ident FROM submissions WHERE file_ident IS NOT NULL GROUP BY file_ident HAVING COUNT(DISTINCT assignment_id)>1 OR COUNT(DISTINCT user_id)>1) d",
    ],
    [
      "conflicting file associations",
      "SELECT COUNT(*) AS n FROM submissions s JOIN file_info f ON f.file_ident=s.file_ident WHERE (f.assignment_id IS NOT NULL AND f.assignment_id<>s.assignment_id) OR (f.uploaded_by IS NOT NULL AND f.uploaded_by<>s.user_id) OR f.upload_finished_at IS NULL",
    ],
  ];
  for (const [label, sql] of checks) {
    requireCondition(
      (await count(db, sql)) === 0,
      `Repair ${label} before migration`,
    );
  }
  let remaining = 0;
  for await (const batch of passwordBatches(db)) {
    for (const row of batch) {
      if (legacyPassword.test(row.password)) remaining++;
      else {
        const match = wrappedPassword.exec(row.password);
        requireCondition(
          match && Number(match[1]) >= 1 && Number(match[1]) <= 10_000_000,
          "Unsupported password format",
        );
      }
    }
  }
  requireCondition(
    remaining ===
      (await count(
        db,
        "SELECT COUNT(*) AS n FROM users WHERE CHAR_LENGTH(password)=96",
      )),
    "Password scan did not cover every legacy credential",
  );
  return remaining;
}

async function upgradeSchema(db: Connection) {
  const present = await tableNames(db);
  for (const statement of tableStatements) {
    const name = /^CREATE TABLE `(\w+)`/.exec(statement)?.[1];
    requireCondition(name, "Invalid baseline table declaration");
    if (!present.has(name)) await db.query(statement);
  }
  await db.query(
    "ALTER TABLE users MODIFY COLUMN password VARCHAR(255) NOT NULL",
  );
  await db.query("DROP INDEX IF EXISTS session_key ON user_sessions");
  await db.query(
    "ALTER TABLE user_sessions MODIFY COLUMN session_key VARCHAR(32) NOT NULL",
  );

  const fileTable = tableStatements.find((value) =>
    value.startsWith("CREATE TABLE `file_info`"),
  );
  requireCondition(fileTable, "Baseline has no file_info table");
  const columns = fileTable
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) =>
      /^`(object_key|staging_key|upload_state|upload_expires_at|object_etag|published_at|upload_purpose|source_etag|source_version)` /.test(
        line,
      ),
    );
  await db.query(
    `ALTER TABLE file_info ${columns.map((column) => `ADD COLUMN IF NOT EXISTS ${column}`).join(", ")}`,
  );

  // The migration SQL is the only index definition source for both empty and old databases.
  for (const statement of indexStatements) {
    await db.query(statement.replace("INDEX ", "INDEX IF NOT EXISTS "));
  }
  const [constraints] = await db.query(
    "SELECT CONCAT(TABLE_NAME,':',CONSTRAINT_NAME) AS name FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()",
  );
  const existing = new Set(nameRows.parse(constraints).map((row) => row.name));
  for (const statement of foreignKeys) {
    const match = /^ALTER TABLE `(\w+)` ADD CONSTRAINT `(\w+)`/.exec(statement);
    requireCondition(match, "Invalid baseline foreign-key declaration");
    if (!existing.has(`${match[1]}:${match[2]}`)) await db.query(statement);
  }
}

async function convertPasswords(db: Connection, iterations: number) {
  let converted = 0;
  for await (const batch of passwordBatches(db)) {
    const old = batch.filter((row) => legacyPassword.test(row.password));
    if (old.length === 0) continue;
    const updates = await Promise.all(
      old.map(async (row) => {
        const decoded = Buffer.from(row.password, "hex");
        const salt = randomBytes(16);
        const digest = await derive(
          decoded.subarray(16),
          salt,
          iterations,
          32,
          "sha256",
        );
        const password = `pbkdf2_sha256_legacy$v1$${iterations}$${decoded.subarray(0, 16).toString("hex")}$${salt.toString("hex")}$${digest.toString("hex")}`;
        return { id: row.id, old: row.password, password };
      }),
    );
    const cases = updates.map(() => "WHEN CAST(? AS SIGNED) THEN ?").join(" ");
    const matches = updates
      .map(() => "(id=CAST(? AS SIGNED) AND BINARY password=BINARY ?)")
      .join(" OR ");
    const values = [
      ...updates.flatMap((row) => [row.id, row.password]),
      ...updates.flatMap((row) => [row.id, row.old]),
    ];
    const [result] = await db.execute(
      `UPDATE users SET password=CASE id ${cases} END,updated_at=updated_at WHERE ${matches}`,
      values,
    );
    const changed = z
      .object({ affectedRows: z.number() })
      .parse(result).affectedRows;
    requireCondition(
      changed === updates.length,
      "Credentials changed concurrently; keep all writers stopped",
    );
    const selected = updates.map(() => "CAST(? AS SIGNED)").join(",");
    const [stored] = await db.execute(
      `SELECT CAST(id AS CHAR) AS id,password FROM users WHERE users.id IN (${selected}) ORDER BY users.id`,
      updates.map((row) => row.id),
    );
    const verified = passwordRows.parse(stored);
    requireCondition(
      verified.length === updates.length &&
        verified.every(
          (row, index) =>
            row.id === updates[index]!.id &&
            row.password === updates[index]!.password,
        ),
      "Stored credentials do not match the intended users",
    );
    converted += changed;
  }
  console.log(`converted_passwords=${converted}`);
}

async function repairFiles(db: Connection) {
  await db.query(
    "UPDATE users SET role=2,updated_at=updated_at WHERE is_staff=1 AND role=1",
  );
  await db.query(`UPDATE file_info f JOIN (
    SELECT file_ident,MIN(assignment_id) AS assignment_id,MIN(user_id) AS user_id
    FROM submissions WHERE file_ident IS NOT NULL GROUP BY file_ident
    HAVING COUNT(DISTINCT assignment_id)=1 AND COUNT(DISTINCT user_id)=1
  ) s ON s.file_ident=f.file_ident
  SET f.assignment_id=COALESCE(f.assignment_id,s.assignment_id),f.uploaded_by=COALESCE(f.uploaded_by,s.user_id)
  WHERE f.assignment_id IS NULL OR f.uploaded_by IS NULL`);
  await db.query(
    "UPDATE file_info SET object_key=file_ident,upload_state='ready',published_at=upload_finished_at WHERE upload_finished_at IS NOT NULL AND object_key IS NULL",
  );
  await db.query(
    "UPDATE file_info SET upload_state='pending',upload_expires_at='1970-01-02 00:00:00' WHERE upload_finished_at IS NULL AND upload_expires_at IS NULL",
  );
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      apply: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "DATABASE_URL=mysql://... bun tool/migrate-legacy.ts [--apply]\nStop writers and back up the original database first. Without --apply this only inspects the database.\nPASSWORD_ITERATIONS defaults to 100000. No rollback command is provided.",
    );
    return;
  }
  const url = process.env.DATABASE_URL;
  requireCondition(url, "DATABASE_URL is required");
  const iterations = Number(process.env.PASSWORD_ITERATIONS ?? "100000");
  requireCondition(
    Number.isInteger(iterations) &&
      iterations >= 10_000 &&
      iterations <= 2_000_000,
    "PASSWORD_ITERATIONS must be between 10000 and 2000000",
  );
  const db = await createConnection({
    uri: url,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    if (values.apply) {
      const acquired = await count(
        db,
        "SELECT COALESCE(GET_LOCK(CONCAT('grader-schema:',LEFT(SHA2(DATABASE(),256),40)),0),0) AS n",
      );
      requireCondition(acquired === 1, "Another migration is already running");
    }
    const tables = await tableNames(db);
    if (!tables.has("_sqlx_migrations")) {
      requireCondition(
        tables.has("__diesel_schema_migrations"),
        "No SQLx database found; use the backend migrate command for an empty database",
      );
      const recorded = await count(
        db,
        `SELECT COUNT(*) AS n FROM __diesel_schema_migrations WHERE version='${version}'`,
      );
      requireCondition(
        recorded === 1,
        "The expected Diesel baseline is not recorded",
      );
      console.log("already_migrated=true");
      return;
    }
    const remaining = await preflight(db);
    console.log(
      `mode=${values.apply ? "apply" : "inspect"} legacy_passwords=${remaining} baseline_indexes=${indexStatements.length}`,
    );
    if (!values.apply) return;
    console.log(
      "Applying one-way conversion; all application writers must remain stopped.",
    );
    await upgradeSchema(db);
    await convertPasswords(db, iterations);
    await repairFiles(db);
    requireCondition(
      (await preflight(db)) === 0,
      "Password conversion is incomplete",
    );
    await db.query(
      "CREATE TABLE IF NOT EXISTS __diesel_schema_migrations(version VARCHAR(50) PRIMARY KEY NOT NULL,run_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    await db.execute(
      "INSERT INTO __diesel_schema_migrations(version) VALUES(?) ON DUPLICATE KEY UPDATE version=version",
      [version],
    );
    await db.query("DROP TABLE _sqlx_migrations");
    console.log("migration_complete=true");
  } finally {
    await db.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof MigrationError) console.error(error.message);
  else {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : "unknown";
    console.error(
      `Migration failed (${String(code)}). Keep the backend stopped and inspect the database.`,
    );
  }
  process.exitCode = 1;
}
