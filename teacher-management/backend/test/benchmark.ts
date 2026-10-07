#!/usr/bin/env bun
import { createConnection } from "mysql2/promise";
import { z } from "zod";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function localURL(raw: string, protocol: string) {
  const url = new URL(raw);
  if (
    url.protocol !== protocol ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("Benchmark targets must be isolated loopback services");
  }
  return url;
}

const targetSchema = z.array(z.object({ id: z.coerce.string() }));
const countSchema = z.array(z.object({ n: z.coerce.number() }));
const observerURL = localURL(required("BENCH_OBSERVER_DATABASE_URL"), "mysql:");
const observer = await createConnection({
  uri: observerURL.href,
  supportBigNumbers: true,
  bigNumberStrings: true,
});
const duration = Number(process.env.BENCH_DURATION_SECONDS ?? "5");
const concurrencyLevels = (process.env.BENCH_CONCURRENCY ?? "1,16,64")
  .split(",")
  .map(Number);
if (
  !Number.isFinite(duration) ||
  duration < 1 ||
  duration > 120 ||
  concurrencyLevels.some(
    (value) => !Number.isInteger(value) || value < 1 || value > 256,
  )
) {
  throw new Error("Invalid benchmark duration or concurrency");
}

interface Target {
  name: string;
  origin: string;
  database: string;
  cookie: string;
}

async function target(name: string, prefix: string): Promise<Target> {
  const origin = localURL(required(`${prefix}_URL`), "http:").origin;
  const database = required(`${prefix}_DATABASE`);
  if (!/^[a-zA-Z0-9_]+$/.test(database))
    throw new Error("Invalid local benchmark database name");
  const started = performance.now();
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: required("BENCH_USERNAME"),
      password: required("BENCH_PASSWORD"),
    }),
    signal: AbortSignal.timeout(30000),
    redirect: "manual",
  });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`${name} benchmark login failed`);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!cookie.includes("sessionid="))
    throw new Error("Login produced no session cookie");
  console.log(
    JSON.stringify({
      target: name,
      login_ms: Number((performance.now() - started).toFixed(2)),
    }),
  );
  return { name, origin, database, cookie };
}

async function sqlCount(database: string) {
  const [rows] = await observer.execute(
    "SELECT COALESCE(SUM(e.COUNT_STAR),0) AS n FROM performance_schema.events_statements_summary_by_thread_by_event_name e JOIN performance_schema.threads t ON t.THREAD_ID=e.THREAD_ID WHERE t.PROCESSLIST_DB=? AND (e.EVENT_NAME LIKE 'statement/sql/%' OR e.EVENT_NAME='statement/com/Execute')",
    [database],
  );
  return countSchema.parse(rows)[0].n;
}

async function main() {
  const targets = [
    await target(process.env.BENCH_OLD_LABEL ?? "rocket-sqlx", "BENCH_OLD"),
    await target(process.env.BENCH_NEW_LABEL ?? "axum-diesel", "BENCH_NEW"),
  ];
  for (const server of targets) {
    if ((await sqlCount(server.database)) === 0) {
      throw new Error(
        "Enable performance_schema events_statements_current and statement instruments before benchmarking",
      );
    }
  }
  const source = targets[0].database;
  const [courseRows] = await observer.query(
    `SELECT a.course_id AS id FROM ${source}.submissions s JOIN ${source}.assignments a ON a.id=s.assignment_id GROUP BY a.course_id ORDER BY COUNT(*) DESC,a.course_id LIMIT 1`,
  );
  const [assignmentRows] = await observer.query(
    `SELECT assignment_id AS id FROM ${source}.submissions GROUP BY assignment_id ORDER BY COUNT(*) DESC,assignment_id LIMIT 1`,
  );
  const course = targetSchema.parse(courseRows)[0]?.id;
  const assignment = targetSchema.parse(assignmentRows)[0]?.id;
  if (!course || !assignment)
    throw new Error("A real snapshot with submissions is required");
  const workload = [
    { name: "current-user", path: "/auth/current_user" },
    { name: "course-list", path: "/courses" },
    { name: "recent-assignments", path: "/courses/with_recent_assignments" },
    { name: "assignment-list", path: `/assignments?course=${course}` },
    { name: "submission-list", path: `/submissions?assignment=${assignment}` },
    { name: "course-statistics", path: `/courses/${course}/statistics` },
    {
      name: "missing-students",
      path: `/submissions/no_submission_students?assignment=${assignment}`,
    },
  ];
  const selectedNames = process.env.BENCH_ENDPOINTS?.split(",");
  if (
    selectedNames?.some(
      (name) => !workload.some((route) => route.name === name),
    )
  ) {
    throw new Error("Unknown BENCH_ENDPOINTS workload");
  }
  const cardinalities: Record<string, number> = {};
  for (const name of ["users", "courses", "assignments", "submissions"]) {
    const [rows] = await observer.query(
      `SELECT COUNT(*) AS n FROM ${source}.${name}`,
    );
    cardinalities[name] = countSchema.parse(rows)[0].n;
  }
  console.log(
    JSON.stringify({
      dataset: cardinalities,
      duration_seconds: duration,
      concurrency: concurrencyLevels,
      sql_counter:
        "performance_schema per-connection SQL and prepared executions",
    }),
  );

  for (const route of workload) {
    if (selectedNames && !selectedNames.includes(route.name)) continue;
    for (const concurrency of concurrencyLevels) {
      for (const server of targets) {
        async function request() {
          const response = await fetch(`${server.origin}/api${route.path}`, {
            headers: { cookie: server.cookie },
            signal: AbortSignal.timeout(30000),
            redirect: "manual",
          });
          const body = await response.arrayBuffer();
          return { status: response.status, bytes: body.byteLength };
        }
        for (let warm = 0; warm < 5; warm++) {
          const warmed = await Promise.all(
            Array.from({ length: concurrency }, request),
          );
          if (warmed.some((response) => response.status !== 200))
            throw new Error(`${server.name} ${route.name} warmup failed`);
        }
        const before = await sqlCount(server.database);
        const elapsed: number[] = [];
        const errors: Record<string, number> = {};
        let bytes = 0;
        const started = performance.now();
        const deadline = started + duration * 1000;
        await Promise.all(
          Array.from({ length: concurrency }, async () => {
            while (performance.now() < deadline) {
              const begin = performance.now();
              try {
                const result = await request();
                bytes += result.bytes;
                if (result.status !== 200)
                  errors[result.status] = (errors[result.status] ?? 0) + 1;
              } catch {
                errors.transport = (errors.transport ?? 0) + 1;
              }
              elapsed.push(performance.now() - begin);
            }
          }),
        );
        const seconds = (performance.now() - started) / 1000;
        const statements = (await sqlCount(server.database)) - before;
        elapsed.sort((a, b) => a - b);
        const percentile = (fraction: number) =>
          Number(
            elapsed[
              Math.min(
                elapsed.length - 1,
                Math.floor(elapsed.length * fraction),
              )
            ].toFixed(2),
          );
        console.log(
          JSON.stringify({
            target: server.name,
            endpoint: route.name,
            concurrency,
            requests: elapsed.length,
            rps: Number((elapsed.length / seconds).toFixed(2)),
            p50_ms: percentile(0.5),
            p95_ms: percentile(0.95),
            p99_ms: percentile(0.99),
            sql_per_request: Number((statements / elapsed.length).toFixed(3)),
            mean_bytes: Math.round(bytes / elapsed.length),
            errors,
          }),
        );
        if (Object.keys(errors).length) process.exitCode = 1;
      }
    }
  }
}

try {
  await main();
} catch {
  console.error(
    "Benchmark failed; inspect local configuration and server status (credentials and response bodies redacted)",
  );
  process.exitCode = 1;
} finally {
  await observer.end();
}
