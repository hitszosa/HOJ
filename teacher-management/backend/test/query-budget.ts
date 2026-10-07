#!/usr/bin/env bun
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { createConnection } from "mysql2/promise";

const User = z.object({
  id: z.number().int(),
  username: z.string(),
  real_name: z.string(),
  role: z.number().int(),
  password_expired: z.boolean(),
});

const Course = z.object({
  id: z.number().int(),
  title: z.string(),
  teachers: z.array(User),
  students: z.array(z.number()),
  assistants: z.array(z.number()),
});

const Assignment = z.object({
  id: z.number().int(),
  title: z.string(),
  course: z.number(),
  published: z.boolean(),
  submit_allowed: z.boolean(),
});

const Submission = z.object({
  id: z.number().int(),
  assignment: z.number(),
  user: User,
  file: z.string(),
  status: z.number(),
  score: z.number().nullable(),
});

const Statistics = z.object({
  id: z.number(),
  average: z.number(),
  median: z.number(),
  highest: z.number(),
  lowest: z.number(),
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

const prefix = `probe_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
const fixturePassword = `P!a9_${randomBytes(18).toString("hex")}`;

const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

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

async function createCourse(
  admin: Session,
  teacher: Person,
  students: readonly Person[],
  label: string,
  assistants: readonly Person[] = [],
) {
  return Course.parse(
    await admin.ok("POST", "/courses/", {
      title: `${prefix}_${label}`,
      year: 2026,
      term: 2,
      teacher_ids: [teacher.id],
      student_ids: students.map((s) => s.id),
      assistant_ids: assistants.map((s) => s.id),
    }),
  );
}

async function createAssignment(
  teacher: Session,
  course: number,
  label: string,
  publish = true,
  maxSize = 256,
) {
  const assignment = Assignment.parse(
    await teacher.ok("POST", "/assignments/", {
      course: String(course),
      title: `${prefix}_${label}`,
      start_time: iso(-3600_000),
      due_time: iso(86400_000),
      max_file_size: maxSize,
    }),
  );
  await teacher.ok("PATCH", `/assignments/${assignment.id}/`, {
    description: `${prefix} fixture`,
    score: 100,
    allowed_extension: ".txt",
    max_file_size: maxSize,
  });
  if (publish)
    await teacher.ok("POST", `/assignments/${assignment.id}/publish/`);
  return assignment;
}

type Capability = {
  ident: string;
  url: string;
  params: Record<string, string>;
};

async function touch(
  session: Session,
  assignment: number,
  filename = `${prefix}.txt`,
): Promise<Capability> {
  const cap = z
    .object({
      ident: z.string(),
      url: z.string(),
      params: z.record(z.string(), z.string()),
    })
    .parse(
      await session.ok("POST", "/files/touch/", {
        original_file_name: filename,
        ident: { type: "submission", assignment_id: assignment },
      }),
    );
  check(
    cap.params.key === cap.ident,
    "Touch must sign the file UUID as the exact multipart key",
  );
  localURL(cap.url);
  return cap;
}

async function upload(
  cap: Capability,
  bytes: Uint8Array,
  overrides: Record<string, string | null> = {},
  method = "POST",
) {
  const fields = { ...cap.params, ...overrides };
  const form = new FormData();
  for (const [key, value] of Object.entries(fields))
    if (value !== null) form.append(key, value);
  form.append("file", new Blob([Uint8Array.from(bytes)]), `${prefix}.txt`);
  const response = await fetch(localURL(cap.url), {
    method,
    body: form,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  await response.arrayBuffer();
  return response.status;
}

async function download(session: Session, ident: string) {
  const file = z
    .object({
      ident: z.string(),
      url: z.string(),
      original_file_name: z.string(),
    })
    .parse(await session.ok("POST", "/files/download/", { ident }));
  check(
    file.ident === ident && typeof file.original_file_name === "string",
    "Download metadata must preserve file identity",
  );
  const response = await fetch(localURL(file.url), {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  check(response.ok, "Presigned download failed");
  return new Uint8Array(await response.arrayBuffer());
}

async function submit(session: Session, assignment: number, ident: string) {
  return session.ok(
    "POST",
    `/submissions/?assignment=${assignment}&file_ident=${encodeURIComponent(ident)}`,
    {},
  );
}

async function uploadFinished(
  session: Session,
  assignment: number,
  bytes: Uint8Array,
) {
  const cap = await touch(session, assignment);
  check((await upload(cap, bytes)) < 300, "Real S3 multipart POST failed");
  await session.ok("POST", "/files/finish/", { ident: cap.ident });
  check(
    digest(await download(session, cap.ident)) === digest(bytes),
    "Downloaded bytes differ from uploaded bytes",
  );
  return cap;
}

const report = new Report();
const sizes = [1, 8, 24];
const counterSchema = z.array(z.object({ n: z.coerce.number() }));
const measurements: Record<string, { size: number; statements: number }[]> = {};

async function main() {
  const base = baseURL();
  const admin = new Session(base);
  const identity = await admin.login(
    required("PROBE_ADMIN_USERNAME"),
    required("PROBE_ADMIN_PASSWORD"),
  );
  check(identity.role === 2, "Query budget requires a local administrator");
  const source = process.env.PROBE_QUERY_SOURCE ?? "metrics";
  check(
    ["metrics", "header", "performance_schema"].includes(source),
    "Unknown PROBE_QUERY_SOURCE",
  );
  const header = process.env.PROBE_QUERY_COUNT_HEADER ?? "x-query-count";
  const observer =
    source === "performance_schema"
      ? await connectLocal("PROBE_OBSERVER_DATABASE_URL")
      : undefined;
  const sqlUser =
    source === "performance_schema"
      ? required("PROBE_BACKEND_DATABASE_USER")
      : "";
  async function counter() {
    if (observer) {
      const [who] = await observer.query(
        "SELECT SUBSTRING_INDEX(CURRENT_USER(),'@',1) AS name",
      );
      const rows = z.array(z.object({ name: z.string() })).parse(who);
      check(
        rows[0].name !== sqlUser,
        "Observer DB user must differ from backend DB user",
      );
      const [values] = await observer.execute(
        "SELECT COALESCE(SUM(COUNT_STAR),0) AS n FROM performance_schema.events_statements_summary_by_account_by_event_name WHERE USER=? AND EVENT_NAME LIKE 'statement/%'",
        [sqlUser],
      );
      return counterSchema.parse(values)[0].n;
    }
    const response = await fetch(`${base}/metrics`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    check(
      response.ok,
      "Metrics endpoint unavailable; choose performance_schema or a real response query header",
    );
    const text = await response.text();
    const matches = [
      ...text.matchAll(
        /^grader_database_queries_total(?:\{[^\n]*\})?\s+([0-9.eE+-]+)\s*$/gm,
      ),
    ];
    check(
      matches.length > 0,
      "Metrics response lacks grader_database_queries_total",
    );
    const total = matches.reduce((sum, match) => sum + Number(match[1]), 0);
    check(
      Number.isSafeInteger(total) && total >= 0,
      "Invalid database query counter",
    );
    return total;
  }
  async function measure(
    name: string,
    size: number,
    request: () => Promise<Reply>,
    validate: (data: unknown) => void,
  ) {
    // No parallel requests, health polling or fixture writes inside measured windows.
    const warm = await request();
    check(
      warm.status >= 200 && warm.status < 300,
      "Query-budget warmup request failed",
    );
    validate(warm.data);
    const samples: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      const before = source === "header" ? 0 : await counter();
      const result = await request();
      const after = source === "header" ? 0 : await counter();
      check(
        result.status >= 200 && result.status < 300,
        "Measured request failed",
      );
      validate(result.data);
      const rawHeader = result.headers.get(header);
      if (source === "header")
        check(
          rawHeader !== null && /^\d+$/.test(rawHeader),
          "Real per-request query count header missing or invalid",
        );
      const count = source === "header" ? Number(rawHeader) : after - before;
      check(
        Number.isSafeInteger(count) && count > 0,
        "No SQL statements observed; instrumentation is unavailable or misconfigured",
      );
      samples.push(count);
    }
    const count = Math.min(...samples);
    check(
      Math.max(...samples) - count <= 2,
      "Concurrent database traffic contaminated query measurement; run against an idle backend",
    );
    (measurements[name] ??= []).push({ size, statements: count });
    console.log(
      JSON.stringify({
        endpoint: name,
        results: size,
        statements: count,
        samples,
        source,
      }),
    );
  }
  try {
    // Fail before fixture creation if the requested instrumentation is unavailable.
    if (source !== "header") await counter();
    const teacher = await createPerson(admin, "budget_teacher", 1);
    const students: Person[] = [];
    const anchor = await createCourse(admin, teacher, [], "budget_anchor");
    const target = await createAssignment(
      teacher.session,
      anchor.id,
      "budget_target",
    );
    const courses = [anchor.id];
    const assignments = [target.id];
    const payload = new TextEncoder().encode("query budget fixture\n");
    for (const size of sizes) {
      while (students.length < size) {
        const n = students.length;
        const student = await createPerson(admin, `budget_student${n}`);
        students.push(student);
        await teacher.session.ok("PATCH", `/courses/${anchor.id}/`, {
          student_ids: students.map((x) => x.id),
        });
        if (courses.length < size) {
          const course = await createCourse(
            admin,
            teacher,
            [student],
            `budget_course${n}`,
          );
          courses.push(course.id);
        }
        if (assignments.length < size)
          assignments.push(
            (
              await createAssignment(
                teacher.session,
                anchor.id,
                `budget_assignment${n}`,
              )
            ).id,
          );
        const cap = await uploadFinished(student.session, target.id, payload);
        const submission = Submission.parse(
          await submit(student.session, target.id, cap.ident),
        );
        await teacher.session.ok("POST", "/submissions/score_update/", {
          submission: submission.id,
          score: n % 100,
        });
      }
      await measure(
        "course relations",
        size,
        () => teacher.session.request("GET", "/courses/?all=false"),
        (data) => {
          const rows = z.array(Course).parse(data);
          check(
            rows.length === size && rows.every((x) => courses.includes(x.id)),
            "Course result cardinality or isolation incorrect",
          );
        },
      );
      await measure(
        "recent assignments",
        size,
        () =>
          teacher.session.request("GET", "/courses/with_recent_assignments/"),
        (data) => {
          const rows = z
            .array(
              Course.omit({ students: true }).extend({
                recent_assignments: z.array(Assignment),
              }),
            )
            .parse(data);
          check(
            rows.length === size,
            "Recent-course result cardinality incorrect",
          );
        },
      );
      await measure(
        "assignments with submission counts",
        size,
        () =>
          teacher.session.request("GET", `/assignments/?course=${anchor.id}`),
        (data) => {
          const rows = z
            .array(Assignment.extend({ submit_count: z.number().nullable() }))
            .parse(data);
          check(rows.length === size, "Assignment cardinality incorrect");
          check(
            rows.find((x) => x.id === target.id)?.submit_count === size,
            "Submission count projection incorrect",
          );
        },
      );
      await measure(
        "submissions with users",
        size,
        () =>
          teacher.session.request(
            "GET",
            `/submissions/?course=${anchor.id}&assignment=${target.id}`,
          ),
        (data) => {
          const rows = z.array(Submission).parse(data);
          check(
            rows.length === size &&
              new Set(rows.map((x) => x.user.id)).size === size,
            "Submission cardinality or user projection incorrect",
          );
        },
      );
      await measure(
        "course statistics",
        size,
        () =>
          teacher.session.request("GET", `/courses/${anchor.id}/statistics/`),
        (data) => {
          const rows = z.array(Statistics).parse(data);
          check(rows.length === size, "Statistics cardinality incorrect");
          const stats = rows.find((x) => x.id === target.id);
          check(
            stats?.median === (size - 1) / 2 &&
              stats.average === (size - 1) / 2,
            "Measured statistics returned incorrect aggregates",
          );
        },
      );
      await measure(
        "batch users",
        size,
        () =>
          teacher.session.request("POST", "/users/user_batch_lookup/", {
            usernames: [],
            ids: students.map((x) => x.id),
          }),
        (data) => {
          const result = z
            .object({
              success: z.array(
                z.object({
                  idx: z.number(),
                  user: z.object({ id: z.number() }),
                }),
              ),
              fail: z.array(z.unknown()),
            })
            .parse(data);
          check(
            result.success.length === size &&
              result.fail.length === 0 &&
              result.success.every(
                (x, i) => x.idx === i && x.user.id === students[i].id,
              ),
            "Measured batch lookup changed order or cardinality",
          );
        },
      );
      await measure(
        "fuzzy user page",
        size,
        () =>
          teacher.session.request(
            "GET",
            `/users/user_fuzzy_lookup/?key=${prefix}_budget_student&page_size=${size}&page_num=1&include_count=true`,
          ),
        (data) => {
          const result = z
            .object({
              result: z.array(z.object({ id: z.number() })),
              length: z.number(),
              has_more_pages: z.boolean(),
            })
            .parse(data);
          check(
            result.result.length === size &&
              result.length === size &&
              !result.has_more_pages,
            "Measured fuzzy lookup cardinality incorrect",
          );
        },
      );
    }
    const maxStatements = Number(
      process.env.PROBE_QUERY_MAX_STATEMENTS ?? "30",
    );
    const maxGrowth = Number(process.env.PROBE_QUERY_MAX_GROWTH ?? "4");
    check(
      Number.isInteger(maxStatements) &&
        maxStatements > 0 &&
        Number.isInteger(maxGrowth) &&
        maxGrowth >= 0 &&
        maxGrowth < 23,
      "Invalid statement budget configuration",
    );
    for (const [name, samples] of Object.entries(measurements))
      await report.run(
        `${name}: bounded SQL across 1/8/24 results`,
        async () => {
          check(samples.length === sizes.length, "Missing query-budget sample");
          check(
            samples.every((x) => x.statements <= maxStatements),
            "Endpoint exceeded absolute SQL statement budget",
          );
          check(
            Math.max(...samples.map((x) => x.statements)) -
              Math.min(...samples.map((x) => x.statements)) <=
              maxGrowth,
            "SQL count scales with result cardinality (possible N+1)",
          );
        },
      );
  } finally {
    if (observer) await observer.end();
  }
}
await report.run("real query budget setup and measurements", main);
report.finish();
