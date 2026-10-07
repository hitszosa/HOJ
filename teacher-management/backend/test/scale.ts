#!/usr/bin/env bun
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { createConnection } from "mysql2/promise";

const User = z.object({
  id: z.number().int(),
  username: z.string(),
  real_name: z.string(),
  role: z.number().int(),
  password_expired: z.boolean(),
});

function check(value: unknown, message: string): asserts value {
  if (!value) throw new ProbeFailure(message);
}

class ProbeFailure extends Error {}

function localURL(raw: string, protocols = ["http:", "https:"]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeFailure("Invalid URL configuration");
  }
  check(
    protocols.includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Refusing non-loopback URL",
  );
  return url;
}

function required(key: string): string {
  const value = process.env[key];
  check(value, `Missing environment variable ${key}`);
  return value;
}

function baseURL(): string {
  const url = localURL(required("PROBE_BASE_URL"));
  check(
    !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/",
    "PROBE_BASE_URL must be a loopback origin without path or credentials",
  );
  return url.origin;
}

type Reply = { status: number; data: unknown; headers: Headers };
type Options = {
  csrf?: boolean | string;
  raw?: string;
  form?: URLSearchParams;
  bearer?: string;
};

class Session {
  cookies = new Map<string, string>();
  constructor(readonly base: string) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    options: Options = {},
  ): Promise<Reply> {
    check(
      path.startsWith("/") && !path.startsWith("//"),
      "API path must be relative",
    );
    const headers = new Headers({
      accept: "application/json",
      "user-agent": "grader-backend-external-probe",
    });
    if (this.cookies.size)
      headers.set(
        "cookie",
        [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    const csrf =
      typeof options.csrf === "string"
        ? options.csrf
        : this.cookies.get("csrftoken");
    if (options.csrf !== false && csrf && !["GET", "HEAD"].includes(method))
      headers.set("X-CSRFTOKEN", decodeURIComponent(csrf));
    if (options.bearer)
      headers.set("authorization", `Bearer ${options.bearer}`);
    let payload: string | URLSearchParams | undefined;
    if (options.form) {
      payload = options.form;
      headers.set("content-type", "application/x-www-form-urlencoded");
    } else if (options.raw !== undefined || body !== undefined) {
      payload = options.raw ?? JSON.stringify(body);
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`${this.base}/api${path}`, {
      method,
      headers,
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const split = pair.indexOf("=");
      const key = pair.slice(0, split);
      const value = pair.slice(split + 1);
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    const text = await response.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: response.status, data, headers: response.headers };
  }

  async ok(
    method: string,
    path: string,
    body?: unknown,
    options?: Options,
  ): Promise<unknown> {
    const result = await this.request(method, path, body, options);
    check(
      result.status >= 200 && result.status < 300,
      `${method} ${path.split("?")[0].replace(/\/\d+/g, "/:id")} expected success, got HTTP ${result.status}`,
    );
    return result.data;
  }

  async login(username: string, password: string) {
    await this.ok("POST", "/auth/login/", { username, password });
    check(
      this.cookies.has("sessionid") && this.cookies.has("csrftoken"),
      "Login must set session and CSRF cookies",
    );
    const user = User.parse(await this.ok("GET", "/auth/current_user/"));
    check(user.username === username, "Login returned wrong identity");
    return user;
  }
}

class Report {
  passed = 0;
  failed = 0;
  skipped = 0;

  async run(name: string, work: () => Promise<void>): Promise<boolean> {
    try {
      await work();
      this.passed++;
      console.log(`PASS ${name}`);
      return true;
    } catch (error) {
      this.failed++;
      // Never print server bodies, URLs, cookies, driver errors, credentials or arbitrary stack traces.
      console.log(
        `FAIL ${name}: ${error instanceof ProbeFailure ? error.message : error instanceof z.ZodError ? `Response schema mismatch (${error.issues.map((issue) => `${issue.path.join(".")}:${issue.code}`).join(", ")})` : "Unexpected runtime/transport/database error (details redacted)"}`,
      );
      return false;
    }
  }

  finish() {
    console.log(
      JSON.stringify({
        passed: this.passed,
        failed: this.failed,
        skipped: this.skipped,
      }),
    );
    if (this.failed) process.exitCode = 1;
  }
}

async function connectLocal(key = "PROBE_DATABASE_URL") {
  const url = localURL(required(key), ["mysql:", "mariadb:"]);
  return createConnection({
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    timezone: "Z",
    supportBigNumbers: true,
    multipleStatements: false,
  });
}

const prefix = `probe_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const fixturePassword = `P!a9_${randomBytes(18).toString("hex")}`;

type Person = { id: number; username: string; session: Session };

async function createPerson(
  admin: Session,
  label: string,
  role = 0,
): Promise<Person> {
  const username = `${prefix}_${label}`;
  const user = User.parse(
    await admin.ok("POST", "/users/", {
      username,
      real_name: username,
      role,
      password_expired: false,
    }),
  );
  check(Number.isSafeInteger(user.id), "Created user must have an integer ID");
  await admin.ok("POST", "/users/change_password/", {
    username,
    password: fixturePassword,
  });
  const session = new Session(admin.base);
  await session.login(username, fixturePassword);
  return { id: user.id, username, session };
}

const report = new Report();
const numericCount = z.array(z.object({ n: z.coerce.number() }));
async function main() {
  const api = new Session(baseURL());
  await api.login(
    required("PROBE_ADMIN_USERNAME"),
    required("PROBE_ADMIN_PASSWORD"),
  );
  const teacher = await createPerson(api, "scale_teacher", 1);
  const db = await connectLocal();
  const measurements = new Map<string, number[]>();
  async function counter() {
    const text = await (await fetch(`${baseURL()}/metrics`)).text();
    const match = text.match(/^grader_database_queries_total (\d+)$/m);
    check(match, "Missing SQL counter");
    return Number(match[1]);
  }
  async function measure(
    name: string,
    count: number,
    path: string,
    validate: (value: unknown) => void,
  ) {
    const before = await counter();
    const started = performance.now();
    const value = await teacher.session.ok("GET", path);
    const elapsed = performance.now() - started;
    const queries = (await counter()) - before;
    validate(value);
    (
      measurements.get(name) ??
      (measurements.set(name, []), measurements.get(name)!)
    ).push(queries);
    console.log(
      JSON.stringify({
        endpoint: name,
        cardinality: count,
        statements: queries,
        elapsed_ms: Math.round(elapsed * 100) / 100,
      }),
    );
  }
  try {
    const [result] = await db.execute(
      "INSERT INTO courses(title,year,term) VALUES (?,2026,2)",
      [`${prefix}_scale`],
    );
    const course = z
      .object({ insertId: z.coerce.number().int().positive() })
      .parse(result).insertId;
    await db.execute(
      "INSERT INTO course_teachers(course_id,user_id) VALUES (?,?)",
      [course, teacher.id],
    );
    let existing = 0;
    for (const size of [10, 100, 1000]) {
      const values = Array.from({ length: size - existing }, (_, index) => [
        `${prefix}_rank_${existing + index}`,
        course,
        teacher.id,
        new Date(Date.now() - 3600_000),
        new Date(Date.now() + (existing + index + 1) * 60_000),
      ]);
      await db.query(
        "INSERT INTO assignments(title,course_id,creator_id,published,start_time,due_time) VALUES " +
          values.map(() => "(?,?,?,1,?,?)").join(","),
        values.flat(),
      );
      existing = size;
      await measure(
        "assignment list",
        size,
        `/assignments/?course=${course}`,
        (value) =>
          check(
            Array.isArray(value) && value.length === size,
            "Assignment cardinality differs",
          ),
      );
      await measure(
        "course statistics",
        size,
        `/courses/${course}/statistics`,
        (value) => {
          const rows = z
            .array(z.object({ median: z.number(), average: z.number() }))
            .parse(value);
          check(
            rows.length === size &&
              rows.every((row) => row.median === 0 && row.average === 0),
            "Empty statistics cardinality or values differ",
          );
        },
      );
      await measure(
        "recent top three",
        size,
        "/courses/with_recent_assignments",
        (value) => {
          const rows = z
            .array(
              z.object({
                id: z.number(),
                recent_assignments: z.array(z.object({ title: z.string() })),
              }),
            )
            .parse(value);
          const assignments = rows.find(
            (row) => row.id === course,
          )?.recent_assignments;
          check(assignments?.length === 3, "Top-three cardinality differs");
          check(
            assignments.every(
              (row, index) =>
                row.title === `${prefix}_rank_${size - index - 1}`,
            ),
            "Top-three order or truncation differs",
          );
        },
      );
    }
    for (const [endpoint, counts] of measurements) {
      check(
        counts.every((count) => count === counts[0]),
        `${endpoint} has cardinality-dependent SQL queries`,
      );
    }
    const [rows] = await db.execute(
      "SELECT COUNT(*) AS n FROM assignments WHERE course_id=?",
      [course],
    );
    check(
      numericCount.parse(rows)[0].n === 1000,
      "Scale fixture setup was incomplete",
    );
  } finally {
    await db.end();
  }
}
await report.run("10/100/1000-result query and ordering invariants", main);
report.finish();
