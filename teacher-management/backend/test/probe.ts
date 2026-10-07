#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { strToU8, zipSync } from "fflate";
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
  show_score: z.boolean(),
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

// Inventory copied from grader-rs/src/routes and auth/sso.rs, with the /api mount.
const routes = [
  "POST /auth/login",
  "POST /auth/logout",
  "POST /auth/change_password",
  "GET /auth/current_user",
  "POST /clean_all_sessions",
  "GET /users/:id",
  "POST /users",
  "PUT /users/:id",
  "PATCH /users/:id",
  "DELETE /users/:id",
  "POST /users/user_batch_lookup",
  "GET /users/user_prefix_lookup",
  "POST /users/batch_create",
  "POST /users/change_password",
  "POST /users/set_assistant",
  "POST /users/remove_assistant",
  "GET /users/user_fuzzy_lookup",
  "GET /courses",
  "GET /courses/:id",
  "GET /courses/with_recent_assignments",
  "POST /courses",
  "PUT /courses/:id",
  "PATCH /courses/:id",
  "DELETE /courses/:id",
  "GET /assignments",
  "GET /assignments/:id",
  "POST /assignments",
  "PUT /assignments/:id",
  "PATCH /assignments/:id",
  "DELETE /assignments/:id",
  "POST /assignments/:id/publish",
  "GET /submissions",
  "GET /submissions/:id",
  "POST /submissions",
  "POST /submissions/score_update",
  "GET /submissions/no_submission_students",
  "GET /assignments/:id/statistics",
  "GET /courses/:id/statistics",
  "POST /files/touch",
  "POST /files/finish",
  "POST /files/download",
  "POST /file/cleanup_unused_uploads",
  "POST /manage/announcement",
  "GET /manage/announcement",
  "GET /manage/recent_actions",
  "GET /oauth/authorize",
  "POST /oauth/authorize",
  "POST /oauth/token",
  "POST /external/v1/courses/search",
  "POST /external/v1/assignments/search",
  "POST /external/v1/submissions/search",
  "POST /external/v1/submissions/:id/suggestions/extract",
  "GET /login/sso",
  "GET /auth/callback",
] as const;
const visited = new Set<string>();
const routeSkips: Record<string, string> = {
  "POST /clean_all_sessions":
    "Global session deletion is unsafe on a shared local snapshot",
  "POST /file/cleanup_unused_uploads":
    "Global upload cleanup could delete non-probe local snapshot data",
  "GET /login/sso":
    "Requires real upstream SSO and interactive account consent; no upstream credentials supplied",
  "GET /auth/callback":
    "Requires real upstream SSO callback; no fabricated provider responses",
};

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
    const route = `${method} ${path
      .split("?")[0]
      .replace(/\/$/, "")
      .replace(/\/\d+(?=\/|$)/g, "/:id")}`;
    visited.add(route);
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
  async denied(
    method: string,
    path: string,
    body?: unknown,
    options?: Options,
    allowed: readonly number[] = [400, 401, 403, 404, 409, 422],
  ): Promise<Reply> {
    const result = await this.request(method, path, body, options);
    check(
      allowed.includes(result.status),
      `Expected rejected request, got HTTP ${result.status}`,
    );
    return result;
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
  skip(name: string, reason: string) {
    this.skipped++;
    console.log(`SKIP ${name}: ${reason}`);
  }
  inventory() {
    for (const route of routes) {
      if (visited.has(route)) console.log(`EXERCISED ${route}`);
      else
        this.skip(
          route,
          routeSkips[route] ?? "Prerequisite scenario did not complete",
        );
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

async function registerOAuth(adminId: number) {
  const db = await connectLocal();
  const clientId = `${prefix}_oauth`;
  const redirect = `${baseURL()}/probe-oauth-callback`;
  const scopes =
    "courses:read assignments:read submissions:read grades:read files:read";
  try {
    await db.execute(
      "INSERT INTO oauth_clients (client_id,name,redirect_uri,allowed_scopes,active,created_by,created_at,updated_at) VALUES (?,?,?,?,1,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())",
      [clientId, clientId, redirect, scopes, adminId],
    );
  } finally {
    await db.end();
  }
  return { clientId, redirect, scopes };
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
const bytes = new TextEncoder().encode(
  "# Suggestions\nImprove the explanation and include boundary cases.\n",
);
const batchSchema = z.object({
  success: z.array(z.object({ idx: z.number(), user: User })),
  fail: z.array(z.object({ idx: z.number(), message: z.string() })),
});
const errorSchema = z.object({
  error: z.string(),
  message: z.string(),
  code: z.number(),
});
const policySchema = z.object({ expiration: z.string() });

async function main() {
  const base = baseURL();
  const admin = new Session(base);
  const me = await admin.login(
    required("PROBE_ADMIN_USERNAME"),
    required("PROBE_ADMIN_PASSWORD"),
  );
  check(me.role === 2, "Probe credentials must identify a local administrator");
  let teacher: Person, assistant: Person, outsider: Person, students: Person[];
  // Fixtures remain namespaced in the disposable local DB. No global cleanup or snapshot data deletion.
  teacher = await createPerson(admin, "teacher", 1);
  assistant = await createPerson(admin, "assistant");
  outsider = await createPerson(admin, "outsider");
  students = [];
  for (let n = 0; n < 5; n++)
    students.push(await createPerson(admin, `student${n}`));
  const course = await createCourse(admin, teacher, students, "course", [
    assistant,
  ]);
  const privateCourse = await createCourse(admin, teacher, [], "private");
  const assignment = await createAssignment(
    teacher.session,
    course.id,
    "graded",
  );
  const empty = await createAssignment(teacher.session, course.id, "empty");
  const otherAssignment = await createAssignment(
    teacher.session,
    course.id,
    "other",
  );

  await report.run(
    "teachers retain full backoffice access; course assistants do not",
    async () => {
      const managed = await createPerson(teacher.session, "teacher_managed");
      const promoted = User.parse(
        await teacher.session.ok("PATCH", `/users/${managed.id}/`, {
          id: managed.id,
          username: managed.username,
          real_name: managed.username,
          role: 2,
          password_expired: false,
        }),
      );
      check(
        promoted.role === 2,
        "Teacher could not manage an administrator role",
      );
      check(
        User.parse(await managed.session.ok("GET", "/auth/current_user/"))
          .role === 2,
        "Teacher role changes were not visible to the managed user",
      );
      await teacher.session.ok("POST", "/users/batch_create/", [
        {
          username: `${prefix}_teacher_batch`,
          real_name: `${prefix}_teacher_batch`,
          role: 0,
          password_expired: false,
        },
      ]);
      await teacher.session.ok("POST", "/users/user_batch_lookup/", {
        ids: [managed.id],
        usernames: [],
      });
      await teacher.session.ok(
        "GET",
        `/users/user_prefix_lookup/?username_prefix=${prefix}`,
      );
      await teacher.session.ok(
        "GET",
        `/users/user_fuzzy_lookup/?key=${prefix}&page_num=1&page_size=20`,
      );
      await teacher.session.ok("GET", "/manage/recent_actions/");
      const created = await createCourse(
        teacher.session,
        teacher,
        [],
        "teacher_created",
      );
      await teacher.session.ok("DELETE", `/courses/${created.id}/`);

      const denied: [string, string, unknown][] = [
        [
          "POST",
          "/users/",
          {
            username: `${prefix}_denied`,
            real_name: "Denied",
            role: 0,
            password_expired: false,
          },
        ],
        ["PATCH", `/users/${managed.id}/`, promoted],
        ["DELETE", `/users/${managed.id}/`, undefined],
        ["POST", "/users/batch_create/", []],
        ["POST", "/users/change_password/", { username: managed.username }],
        [
          "POST",
          "/users/user_batch_lookup/",
          { ids: [managed.id], usernames: [] },
        ],
        [
          "GET",
          `/users/user_prefix_lookup/?username_prefix=${prefix}`,
          undefined,
        ],
        [
          "GET",
          `/users/user_fuzzy_lookup/?key=${prefix}&page_num=1&page_size=20`,
          undefined,
        ],
        [
          "POST",
          "/users/set_assistant/",
          { course_id: course.id, user_id: managed.id },
        ],
        [
          "POST",
          "/users/remove_assistant/",
          { course_id: course.id, user_id: assistant.id },
        ],
        [
          "POST",
          "/courses/",
          {
            title: "Denied",
            teacher_ids: [],
            student_ids: [],
            assistant_ids: [],
          },
        ],
        ["PATCH", `/courses/${course.id}/`, { title: "Denied" }],
        ["DELETE", `/courses/${course.id}/`, undefined],
        ["GET", "/manage/recent_actions/", undefined],
        ["POST", "/manage/announcement/", {}],
        ["POST", "/file/cleanup_unused_uploads/", undefined],
        ["POST", "/clean_all_sessions/", undefined],
      ];
      for (const [method, path, body] of denied) {
        await assistant.session.denied(method, path, body, undefined, [403]);
      }
      await assistant.session.ok("GET", `/courses/${course.id}/statistics/`);
      await teacher.session.ok("DELETE", `/users/${managed.id}/`);
    },
  );

  await report.run(
    "identity CRUD, batch indexes and literal-prefix lookup",
    async () => {
      const disposable = await createPerson(admin, "disposable");
      await admin.ok("PUT", `/users/${disposable.id}/`, {
        id: disposable.id,
        username: disposable.username,
        real_name: `${prefix}_renamed`,
        role: 0,
        password_expired: false,
      });
      await admin.ok("PATCH", `/users/${disposable.id}/`, {
        id: disposable.id,
        username: disposable.username,
        real_name: `${prefix}_patched`,
        role: 0,
        password_expired: false,
      });
      check(
        User.parse(await admin.ok("GET", `/users/${disposable.id}/`))
          .real_name === `${prefix}_patched`,
        "User patch did not persist",
      );
      check(
        User.parse(await disposable.session.ok("GET", "/auth/current_user/"))
          .real_name === `${prefix}_patched`,
        "Metadata update revoked target session or left stale user info",
      );
      await admin.ok("POST", "/users/change_password/", {
        username: disposable.username,
      });
      check(
        User.parse(await disposable.session.ok("GET", "/auth/current_user/"))
          .id === disposable.id,
        "Password-omitted admin request revoked target session",
      );
      const result = batchSchema.parse(
        await admin.ok("POST", "/users/user_batch_lookup/", {
          usernames: [
            students[0].username,
            `${prefix}_missing`,
            students[0].username,
          ],
          ids: [],
        }),
      );
      check(
        result.success.length === 2 &&
          result.success[0].idx === 0 &&
          result.success[1].idx === 2 &&
          result.success.every((x) => x.user.id === students[0].id),
        "Batch lookup lost order or duplicate inputs",
      );
      check(
        result.fail.length === 1 && result.fail[0].idx === 1,
        "Batch lookup failed-index contract differs",
      );
      const ids = batchSchema.parse(
        await admin.ok("POST", "/users/user_batch_lookup/", {
          usernames: [],
          ids: [students[0].id, students[1].id],
        }),
      );
      check(
        ids.success.map((x) => x.user.id).join() ===
          [students[0].id, students[1].id].join(),
        "ID batch lookup changed order",
      );
      await admin.denied("POST", "/users/user_batch_lookup/", {
        usernames: [],
        ids: [],
      });
      const bulk = [0, 1].map((n) => ({
        username: `${prefix}_batch${n}`,
        real_name: `${prefix}_batch${n}`,
        role: 0,
        password_expired: false,
      }));
      await admin.ok("POST", "/users/batch_create/", bulk);
      const found = batchSchema.parse(
        await admin.ok("POST", "/users/user_batch_lookup/", {
          usernames: bulk.map((x) => x.username),
          ids: [],
        }),
      );
      check(
        found.success.length === 2 && found.fail.length === 0,
        "Batch-created users not readable",
      );
      const prefixed = z
        .array(User)
        .parse(
          await admin.ok(
            "GET",
            `/users/user_prefix_lookup/?username_prefix=${prefix}_batch`,
          ),
        );
      check(
        prefixed.length === 2 &&
          prefixed.every((x) => x.username.startsWith(`${prefix}_batch`)),
        "Prefix search returned wrong fixtures",
      );
      const fuzzy = z
        .object({
          result: z.array(User),
          length: z.number().nullable(),
          has_more_pages: z.boolean(),
        })
        .parse(
          await admin.ok(
            "GET",
            `/users/user_fuzzy_lookup/?key=${prefix}_batch&page_size=1&page_num=1&include_count=true`,
          ),
        );
      check(
        fuzzy.result.length === 1 && fuzzy.length === 2 && fuzzy.has_more_pages,
        "Fuzzy lookup pagination/count incorrect",
      );
      await admin.ok("DELETE", `/users/${disposable.id}/`);
      await disposable.session.denied(
        "GET",
        "/auth/current_user/",
        undefined,
        undefined,
        [401, 403],
      );
      await new Session(base).denied(
        "POST",
        "/auth/login/",
        { username: disposable.username, password: fixturePassword },
        undefined,
        [400, 401, 403],
      );
      await students[0].session.denied(
        "POST",
        "/users/",
        bulk[0],
        undefined,
        [403],
      );
    },
  );

  await report.run(
    "password changes, CSRF binding, logout and malformed JSON",
    async () => {
      const person = await createPerson(admin, "password");
      const replacementPassword = `K!b7_${randomBytes(18).toString("hex")}`;
      await person.session.denied(
        "POST",
        "/auth/change_password/",
        { old_password: fixturePassword, new_password: `${fixturePassword}N` },
        { csrf: false },
        [403],
      );
      await person.session.denied(
        "POST",
        "/auth/change_password/",
        { old_password: fixturePassword, new_password: `${fixturePassword}N` },
        { csrf: admin.cookies.get("csrftoken")! },
        [403],
      );
      await person.session.denied(
        "POST",
        "/auth/change_password/",
        { old_password: "wrong-password", new_password: `${fixturePassword}N` },
        undefined,
        [400, 401, 403],
      );
      const secondSession = new Session(base);
      await secondSession.login(person.username, fixturePassword);
      await person.session.ok("POST", "/auth/change_password/", {
        old_password: fixturePassword,
        new_password: replacementPassword,
      });
      await secondSession.denied(
        "GET",
        "/auth/current_user/",
        undefined,
        undefined,
        [401],
      );
      await new Session(base).denied(
        "POST",
        "/auth/login/",
        { username: person.username, password: fixturePassword },
        undefined,
        [400, 401, 403],
      );
      await person.session.login(person.username, replacementPassword);
      const current = User.parse(
        await person.session.ok("GET", "/auth/current_user"),
      );
      check(current.id === person.id, "Slashless current-user route differs");
      await person.session.ok("POST", "/auth/logout/");
      await person.session.denied(
        "GET",
        "/auth/current_user/",
        undefined,
        undefined,
        [401],
      );
      const resetTarget = await createPerson(admin, "reset_target");
      await admin.ok("POST", "/users/change_password/", {
        username: resetTarget.username,
        password: `${fixturePassword}R`,
      });
      await resetTarget.session.denied(
        "GET",
        "/auth/current_user/",
        undefined,
        undefined,
        [401],
      );
      const malformed = await admin.denied(
        "POST",
        "/courses/",
        undefined,
        { raw: "{broken" },
        [400, 422],
      );
      errorSchema.parse(malformed.data);
      const wrongShape = await admin.denied(
        "POST",
        "/courses/",
        { teacher_ids: "not-an-array" },
        undefined,
        [400, 422],
      );
      errorSchema.parse(wrongShape.data);
    },
  );

  await report.run(
    "course relations, replacement, assistant revocation and role boundaries",
    async () => {
      const got = Course.parse(
        await students[0].session.ok("GET", `/courses/${course.id}/`),
      );
      check(
        got.teachers.some((x) => x.id === teacher.id) &&
          got.students.length === 5 &&
          got.assistants.includes(assistant.id),
        "Course relation projection incorrect",
      );
      const enrolled = z
        .array(Course)
        .parse(await students[0].session.ok("GET", "/courses/?all=false"));
      check(
        enrolled.some((x) => x.id === course.id) &&
          !enrolled.some((x) => x.id === privateCourse.id),
        "Own course listing leaks unrelated courses",
      );
      await admin.ok("GET", "/courses/?all=true");
      const recent = z
        .array(
          Course.omit({ students: true }).extend({
            recent_assignments: z.array(Assignment),
          }),
        )
        .parse(
          await students[0].session.ok(
            "GET",
            "/courses/with_recent_assignments/",
          ),
        );
      check(
        recent
          .find((x) => x.id === course.id)
          ?.recent_assignments.some((x) => x.id === assignment.id),
        "Recent assignments missing published fixture",
      );
      await outsider.session.denied(
        "GET",
        `/courses/${course.id}/`,
        undefined,
        undefined,
        [403, 404],
      );
      await students[0].session.denied(
        "PATCH",
        `/courses/${course.id}/`,
        { title: "unauthorized" },
        undefined,
        [403],
      );
      await teacher.session.ok("PATCH", `/courses/${course.id}/`, {
        title: `${prefix}_patched_course`,
      });
      await teacher.session.ok("PUT", `/courses/${course.id}/`, {
        title: course.title,
        year: 2026,
        term: 2,
        teacher_ids: [teacher.id],
        student_ids: students.map((x) => x.id),
        assistant_ids: [],
      });
      await assistant.session.denied(
        "GET",
        `/courses/${course.id}/statistics/`,
        undefined,
        undefined,
        [403, 404],
      );
      await teacher.session.ok("POST", "/users/set_assistant/", {
        course_id: course.id,
        user_id: assistant.id,
      });
      await assistant.session.ok("GET", `/courses/${course.id}/statistics/`);
      await teacher.session.ok("POST", "/users/remove_assistant/", {
        course_id: course.id,
        user_id: assistant.id,
      });
      await assistant.session.denied(
        "GET",
        `/courses/${course.id}/statistics/`,
        undefined,
        undefined,
        [403, 404],
      );
      await teacher.session.ok("POST", "/users/set_assistant/", {
        course_id: course.id,
        user_id: assistant.id,
      });
      const disposableCourse = await createCourse(
        admin,
        teacher,
        [],
        "delete_course",
      );
      await teacher.session.ok("DELETE", `/courses/${disposableCourse.id}/`);
      await admin.denied(
        "GET",
        `/courses/${disposableCourse.id}/`,
        undefined,
        undefined,
        [404],
      );
    },
  );

  await report.run(
    "assignment publish, time windows, visibility and delete",
    async () => {
      const draft = await createAssignment(
        teacher.session,
        course.id,
        "draft",
        false,
      );
      const before = z
        .array(Assignment)
        .parse(
          await students[0].session.ok(
            "GET",
            `/assignments/?course=${course.id}`,
          ),
        );
      check(
        !before.some((x) => x.id === draft.id),
        "Student list includes draft assignment",
      );
      await students[0].session.denied(
        "GET",
        `/assignments/${draft.id}/`,
        undefined,
        undefined,
        [403, 404],
      );
      await students[0].session.denied(
        "POST",
        `/assignments/${draft.id}/publish/`,
        undefined,
        undefined,
        [403],
      );
      await teacher.session.ok("POST", `/assignments/${draft.id}/publish/`);
      check(
        Assignment.parse(
          await students[0].session.ok("GET", `/assignments/${draft.id}/`),
        ).submit_allowed,
        "Published active assignment disallows submission",
      );
      await teacher.session.ok("PUT", `/assignments/${draft.id}/`, {
        title: `${prefix}_future`,
        course: String(course.id),
        start_time: iso(3600_000),
        due_time: iso(7200_000),
      });
      await students[0].session.denied(
        "GET",
        `/assignments/${draft.id}/`,
        undefined,
        undefined,
        [403, 404],
      );
      check(
        !Assignment.parse(
          await teacher.session.ok("GET", `/assignments/${draft.id}/`),
        ).submit_allowed,
        "Future assignment permits submission",
      );
      const futureUpload = await uploadFinished(
        students[0].session,
        draft.id,
        bytes,
      );
      await students[0].session.denied(
        "POST",
        `/submissions/?assignment=${draft.id}&file_ident=${futureUpload.ident}`,
        {},
      );
      await teacher.session.ok("PATCH", `/assignments/${draft.id}/`, {
        start_time: iso(-7200_000),
        due_time: iso(-3600_000),
      });
      check(
        !Assignment.parse(
          await students[0].session.ok("GET", `/assignments/${draft.id}/`),
        ).submit_allowed,
        "Closed assignment permits submission",
      );
      const closedUpload = await uploadFinished(
        students[0].session,
        draft.id,
        bytes,
      );
      await students[0].session.denied(
        "POST",
        `/submissions/?assignment=${draft.id}&file_ident=${closedUpload.ident}`,
        {},
      );
      await teacher.session.ok("DELETE", `/assignments/${draft.id}/`);
      await teacher.session.denied(
        "GET",
        `/assignments/${draft.id}/`,
        undefined,
        undefined,
        [404],
      );
      const allowed = z
        .array(Assignment)
        .parse(
          await students[0].session.ok(
            "GET",
            `/assignments/?course=${course.id}&submit_allowed=true`,
          ),
        );
      check(
        allowed.some((x) => x.id === assignment.id) &&
          allowed.every((x) => x.submit_allowed),
        "submit_allowed filter incorrect",
      );
    },
  );

  let finalized: Capability | undefined;
  let finalizedBytes = bytes;
  let submissionId: number | undefined;
  await report.run(
    "real multipart upload, concurrent finish/submission, same-key overwrite",
    async () => {
      const student = students[0].session;
      const cap = await touch(student, assignment.id);
      check((await upload(cap, bytes)) < 300, "S3 POST upload failed");
      await students[1].session.denied(
        "POST",
        "/files/finish/",
        { ident: cap.ident },
        undefined,
        [403, 404],
      );
      const finishes = await Promise.all([
        student.request("POST", "/files/finish/", { ident: cap.ident }),
        student.request("POST", "/files/finish/", { ident: cap.ident }),
      ]);
      check(
        finishes.some((x) => x.status >= 200 && x.status < 300) &&
          finishes.every(
            (x) => (x.status >= 200 && x.status < 300) || x.status === 409,
          ),
        "Concurrent finish must succeed or conflict without server error",
      );
      check(
        digest(await download(student, cap.ident)) === digest(bytes),
        "Finished object bytes incorrect",
      );
      const published = z
        .object({ url: z.string() })
        .parse(
          await student.ok("POST", "/files/download/", { ident: cap.ident }),
        );
      check(
        localURL(published.url).pathname ===
          `${localURL(cap.url).pathname.replace(/\/$/, "")}/${cap.ident}`,
        "Finished download must use the uploaded UUID object, not a copied path",
      );
      await teacher.session.denied(
        "POST",
        "/files/download/",
        { ident: cap.ident },
        undefined,
        [403, 404],
      );
      await students[1].session.denied(
        "POST",
        "/files/download/",
        { ident: cap.ident },
        undefined,
        [403, 404],
      );
      await students[1].session.denied(
        "POST",
        `/submissions/?assignment=${assignment.id}&file_ident=${cap.ident}`,
        {},
        undefined,
        [400, 403, 404],
      );
      await student.denied(
        "POST",
        `/submissions/?assignment=${otherAssignment.id}&file_ident=${cap.ident}`,
        {},
        undefined,
        [400, 403, 404],
      );
      const submissions = await Promise.all([
        student.request(
          "POST",
          `/submissions/?assignment=${assignment.id}&file_ident=${cap.ident}`,
          {},
        ),
        student.request(
          "POST",
          `/submissions/?assignment=${assignment.id}&file_ident=${cap.ident}`,
          {},
        ),
      ]);
      check(
        submissions.some((x) => x.status >= 200 && x.status < 300) &&
          submissions.every(
            (x) => (x.status >= 200 && x.status < 300) || x.status === 409,
          ),
        "Concurrent submissions must succeed or conflict without server error",
      );
      const list = z
        .array(Submission)
        .parse(
          await teacher.session.ok(
            "GET",
            `/submissions/?course=${course.id}&assignment=${assignment.id}`,
          ),
        );
      const mine = list.filter((x) => x.user.id === students[0].id);
      check(
        mine.length === 1 && mine[0].file === cap.ident,
        "Concurrent submission produced duplicates or wrong file",
      );
      submissionId = mine[0].id;
      check(
        Submission.parse(
          await student.ok("GET", `/submissions/${submissionId}/`),
        ).id === submissionId,
        "Submission detail differs from list",
      );
      await outsider.session.denied(
        "GET",
        `/submissions/${submissionId}/`,
        undefined,
        undefined,
        [403, 404],
      );
      const replacement = new TextEncoder().encode("Replacement upload\n");
      const replay = await upload(cap, replacement);
      check(
        replay >= 200 && replay < 300,
        "Valid POST capability must allow overwriting the same UUID",
      );
      const overwritten = await fetch(localURL(published.url), {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      check(
        overwritten.ok,
        "Original download URL stopped resolving after overwrite",
      );
      check(
        digest(new Uint8Array(await overwritten.arrayBuffer())) ===
          digest(replacement),
        "Repeated POST must replace the original object without another finish or copy",
      );
      await student.ok("POST", "/files/finish/", { ident: cap.ident });
      check(
        digest(await download(student, cap.ident)) === digest(replacement),
        "Repeated finish must preserve the replacement bytes",
      );
      const resubmitted = Submission.parse(
        await submit(student, assignment.id, cap.ident),
      );
      check(
        resubmitted.id === submissionId && resubmitted.file === cap.ident,
        "Resubmitting the overwritten UUID must update the existing submission",
      );
      finalizedBytes = replacement;
      finalized = cap;
      if (process.env.PROBE_DATABASE_URL) {
        const db = await connectLocal();
        try {
          const [rows] = await db.execute(
            "SELECT COUNT(*) AS n FROM submissions WHERE assignment_id=? AND user_id=?",
            [assignment.id, students[0].id],
          );
          const counts = z
            .array(z.object({ n: z.coerce.number() }))
            .parse(rows);
          check(
            counts[0].n === 1,
            "Database contains duplicate concurrent submissions",
          );
          const [files] = await db.execute(
            "SELECT file_ident, file_size, upload_state FROM file_info WHERE file_ident=?",
            [cap.ident],
          );
          const stored = z
            .array(
              z.object({
                file_size: z.coerce.number(),
                file_ident: z.string(),
                upload_state: z.literal("ready"),
              }),
            )
            .parse(files);
          check(
            stored.length === 1 &&
              stored[0].file_size === replacement.byteLength &&
              stored[0].file_ident === cap.ident,
            "Repeated finish and resubmission must retain the UUID and refresh the ready file size",
          );
        } finally {
          await db.end();
        }
      } else
        report.skip(
          "MariaDB submission uniqueness and refreshed file-size cross-check",
          "PROBE_DATABASE_URL not provided; HTTP overwrite and resubmission still asserted",
        );
    },
  );

  await report.run(
    "signed upload key, field, method, size and unfinished-file negatives",
    async () => {
      const student = students[0].session;
      const cap = await touch(student, empty.id);
      await student.denied("POST", "/files/finish/", { ident: cap.ident });
      await student.denied(
        "POST",
        `/submissions/?assignment=${empty.id}&file_ident=${cap.ident}`,
        {},
      );
      await outsider.session.denied(
        "POST",
        "/files/touch/",
        {
          original_file_name: "bad.txt",
          ident: { type: "submission", assignment_id: empty.id },
        },
        undefined,
        [403, 404],
      );
      const negatives: [
        string,
        Record<string, string | null>,
        string,
        Uint8Array,
      ][] = [
        ["key", { key: `${cap.params.key}_different` }, "POST", bytes],
        ["content type", { "Content-Type": "text/plain" }, "POST", bytes],
        ["public ACL", { acl: "public-read" }, "POST", bytes],
        ["missing signature", { "x-amz-signature": null }, "POST", bytes],
        ["method", {}, "PUT", bytes],
        ["size", {}, "POST", new Uint8Array(257)],
      ];
      for (const [name, fields, method, body] of negatives) {
        const status = await upload(cap, body, fields, method);
        check(
          status >= 400 && status < 500,
          `S3 ${name} tampering must be rejected`,
        );
      }
      await student.denied("POST", "/files/download/", { ident: cap.ident });
    },
  );

  await report.run(
    "graded statistics, odd/even median, empty and missing submissions",
    async () => {
      check(
        submissionId !== undefined && finalized,
        "Upload scenario prerequisite failed",
      );
      const emptyStats = Statistics.parse(
        await teacher.session.ok("GET", `/assignments/${empty.id}/statistics/`),
      );
      check(
        [
          emptyStats.average,
          emptyStats.median,
          emptyStats.highest,
          emptyStats.lowest,
        ].every((x) => x === 0),
        "Empty statistics must be finite zeroes",
      );
      await students[0].session.denied(
        "POST",
        "/submissions/score_update/",
        { submission: submissionId, score: 99 },
        undefined,
        [403],
      );
      const scores = [10, 30, 80, 100];
      const ids = [submissionId];
      for (let n = 1; n < 4; n++) {
        const cap = await uploadFinished(
          students[n].session,
          assignment.id,
          bytes,
        );
        ids.push(
          Submission.parse(
            await submit(students[n].session, assignment.id, cap.ident),
          ).id,
        );
      }
      for (let n = 0; n < 3; n++)
        await teacher.session.ok("POST", "/submissions/score_update/", {
          submission: ids[n],
          score: scores[n],
        });
      const odd = Statistics.parse(
        await teacher.session.ok(
          "GET",
          `/assignments/${assignment.id}/statistics/`,
        ),
      );
      check(
        odd.median === 30 &&
          odd.lowest === 10 &&
          odd.highest === 80 &&
          Math.abs(odd.average - 40) < 1e-9,
        "Odd median or graded-only aggregate incorrect",
      );
      await assistant.session.ok("POST", "/submissions/score_update/", {
        submission: ids[3],
        score: scores[3],
      });
      const even = Statistics.parse(
        await teacher.session.ok(
          "GET",
          `/assignments/${assignment.id}/statistics/`,
        ),
      );
      check(
        even.median === 55 &&
          even.average === 55 &&
          even.highest === 100 &&
          even.lowest === 10,
        "Even median or aggregates incorrect",
      );
      const courseStats = z
        .array(Statistics)
        .parse(
          await teacher.session.ok("GET", `/courses/${course.id}/statistics/`),
        );
      check(
        courseStats.find((x) => x.id === assignment.id)?.median === 55 &&
          courseStats.find((x) => x.id === empty.id)?.median === 0,
        "Course aggregate disagrees with assignment aggregates",
      );
      const missing = z
        .array(User)
        .parse(
          await teacher.session.ok(
            "GET",
            `/submissions/no_submission_students/?course=${course.id}&assignment=${assignment.id}`,
          ),
        );
      check(
        missing.length === 1 && missing[0].id === students[4].id,
        "No-submission roster incorrect",
      );
      const own = z
        .array(Submission)
        .parse(
          await students[0].session.ok(
            "GET",
            `/submissions/?course=${course.id}&assignment=${assignment.id}`,
          ),
        );
      check(
        own.length === 1 && own[0].user.id === students[0].id,
        "Student submission listing leaks peer submissions",
      );
      await students[0].session.denied(
        "GET",
        `/assignments/${assignment.id}/statistics/`,
        undefined,
        undefined,
        [403],
      );
    },
  );

  await report.run(
    "announcement persistence, authorization and audit actor/resource",
    async () => {
      const announcement = {
        enable: true,
        publish_date: iso(-60_000),
        effective_until: iso(3600_000),
        display: "banner",
        title: `${prefix}_announcement`,
        content: `${prefix} local fixture`,
      };
      await students[0].session.denied(
        "POST",
        "/manage/announcement/",
        announcement,
        undefined,
        [403],
      );
      await teacher.session.ok("POST", "/manage/announcement/", announcement);
      const read = z
        .object({ title: z.string(), content: z.string(), enable: z.boolean() })
        .parse(await admin.ok("GET", "/manage/announcement/"));
      check(
        read.title === announcement.title &&
          read.content === announcement.content &&
          read.enable,
        "Announcement write/read differs",
      );
      const audit = z
        .array(
          z
            .object({
              username: z.string(),
              resource_type: z.string(),
              description: z.string(),
              user_agent: z.string().nullable(),
              ip_address: z.string().nullable(),
            })
            .passthrough(),
        )
        .parse(
          await teacher.session.ok("GET", "/manage/recent_actions/?limit=100"),
        );
      check(
        audit.some(
          (x) =>
            x.description.includes(prefix) &&
            x.user_agent === "grader-backend-external-probe" &&
            x.ip_address !== null,
        ),
        "Audit feed missing fixture operation",
      );
      check(
        !JSON.stringify(audit).includes(fixturePassword),
        "Audit leaked plaintext fixture password",
      );
      await students[0].session.denied(
        "GET",
        "/manage/recent_actions/",
        undefined,
        undefined,
        [403],
      );
    },
  );

  if (process.env.PROBE_DATABASE_URL)
    await report.run(
      "real OAuth PKCE, consent, one-use code and scoped external search",
      async () => {
        const client = await registerOAuth(me.id);
        const bearerClient = new Session(base);
        async function grant(session: Session, scope: string) {
          const verifier = randomBytes(32).toString("base64url");
          const state = randomBytes(12).toString("hex");
          const params = new URLSearchParams({
            response_type: "code",
            client_id: client.clientId,
            redirect_uri: client.redirect,
            scope,
            state,
            code_challenge: createHash("sha256")
              .update(verifier)
              .digest("base64url"),
            code_challenge_method: "S256",
          });
          // Mutate only this run's uniquely namespaced fixture session, never an imported user.
          if (session === teacher.session) {
            const db = await connectLocal();
            try {
              await db.beginTransaction();
              await db.execute(
                "UPDATE user_sessions s JOIN users u ON u.id=s.user_id SET s.expires_at=UTC_TIMESTAMP()+INTERVAL 1 HOUR WHERE s.user_id=? AND u.username=?",
                [teacher.id, teacher.username],
              );
              await db.query(
                "UPDATE cache_revision SET revision=UUID(),auth_revision=UUID() WHERE id=1",
              );
              await db.commit();
              // Direct maintenance writes bypass the HTTP invalidation callback.
              await Bun.sleep(2100);
            } finally {
              await db.end();
            }
          }
          const info = z
            .object({ csrf_token: z.string(), scope: z.string() })
            .parse(await session.ok("GET", `/oauth/authorize/?${params}`));
          if (session === teacher.session) {
            const db = await connectLocal();
            try {
              const [rows] = await db.execute(
                "SELECT MIN(TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),s.expires_at)) AS remaining FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=? AND u.username=?",
                [teacher.id, teacher.username],
              );
              const expiry = z
                .array(z.object({ remaining: z.coerce.number() }))
                .parse(rows);
              check(
                expiry[0].remaining > 86400,
                "OAuth authorization GET failed to renew near-expiry session",
              );
            } finally {
              await db.end();
            }
          }
          const badForm = new URLSearchParams(params);
          badForm.set("csrf_token", "wrong");
          badForm.set("decision", "approve");
          await session.denied(
            "POST",
            "/oauth/authorize/",
            undefined,
            { form: badForm, csrf: false },
            [403],
          );
          const form = new URLSearchParams(params);
          form.set("csrf_token", info.csrf_token);
          form.set("decision", "deny");
          const denied = await session.request(
            "POST",
            "/oauth/authorize/",
            undefined,
            { form, csrf: false },
          );
          check(
            [302, 303].includes(denied.status),
            "Consent denial must redirect",
          );
          const deniedURL = localURL(denied.headers.get("location") ?? "");
          check(
            deniedURL.searchParams.get("error") === "access_denied" &&
              deniedURL.searchParams.get("state") === state,
            "Consent denial lost error or state",
          );
          form.set("decision", "approve");
          const approved = await session.request(
            "POST",
            "/oauth/authorize/",
            undefined,
            { form, csrf: false },
          );
          check(
            [302, 303].includes(approved.status),
            "Consent approval must redirect",
          );
          const location = localURL(approved.headers.get("location") ?? "");
          check(
            location.searchParams.get("state") === state,
            "OAuth approval lost state",
          );
          const code = location.searchParams.get("code");
          check(code, "OAuth approval omitted authorization code");
          const tokenForm = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: client.redirect,
            client_id: client.clientId,
            code_verifier: verifier,
          });
          const wrongVerifier = new URLSearchParams(tokenForm);
          wrongVerifier.set(
            "code_verifier",
            randomBytes(32).toString("base64url"),
          );
          await bearerClient.denied(
            "POST",
            "/oauth/token/",
            undefined,
            { form: wrongVerifier },
            [400, 401],
          );
          const token = z
            .object({ access_token: z.string(), token_type: z.string() })
            .parse(
              await bearerClient.ok("POST", "/oauth/token/", undefined, {
                form: tokenForm,
              }),
            );
          check(
            token.token_type.toLowerCase() === "bearer",
            "OAuth token type must be Bearer",
          );
          await bearerClient.denied(
            "POST",
            "/oauth/token/",
            undefined,
            { form: tokenForm },
            [400, 401],
          );
          return token.access_token;
        }
        const token = await grant(teacher.session, client.scopes);
        const courses = z
          .object({ items: z.array(z.object({ id: z.number() })) })
          .parse(
            await bearerClient.ok(
              "POST",
              "/external/v1/courses/search/",
              { q: [prefix], limit: 100 },
              { bearer: token },
            ),
          );
        check(
          courses.items.some((x) => x.id === course.id),
          "External course search lost authorized fixture",
        );
        const assignments = z
          .object({ items: z.array(z.object({ id: z.number() })) })
          .parse(
            await bearerClient.ok(
              "POST",
              "/external/v1/assignments/search/",
              { q: [prefix], course_id: course.id },
              { bearer: token },
            ),
          );
        check(
          assignments.items.some((x) => x.id === assignment.id),
          "External assignment search lost fixture",
        );
        const submissions = z
          .object({
            items: z.array(
              z.object({ id: z.number(), score: z.number().nullable() }),
            ),
            unsubmitted: z.array(User.omit({ password_expired: true })),
          })
          .parse(
            await bearerClient.ok(
              "POST",
              "/external/v1/submissions/search/",
              { q: [], assignment_id: assignment.id },
              { bearer: token },
            ),
          );
        check(
          submissions.items.length === 4 &&
            submissions.unsubmitted.some((x) => x.id === students[4].id),
          "External submission search or missing roster incorrect",
        );
        const limited = await grant(teacher.session, "courses:read");
        await bearerClient.denied(
          "POST",
          "/external/v1/assignments/search/",
          { q: [], course_id: course.id },
          { bearer: limited },
          [403],
        );
        const outsiderToken = await grant(outsider.session, client.scopes);
        await bearerClient.denied(
          "POST",
          "/external/v1/submissions/search/",
          { q: [], assignment_id: assignment.id },
          { bearer: outsiderToken },
          [403, 404],
        );
        await bearerClient.denied(
          "POST",
          "/external/v1/courses/search/",
          { q: [] },
          undefined,
          [401],
        );
        if (process.env.PROBE_EXTRACTOR_AVAILABLE === "1") {
          await report.run(
            "real upstream DOCX suggestion extraction",
            async () => {
              const document = zipSync({
                "[Content_Types].xml": strToU8(
                  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
                ),
                "_rels/.rels": strToU8(
                  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
                ),
                "word/document.xml": strToU8(
                  '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>建议</w:t></w:r></w:p><w:p><w:r><w:t>建议增加 boundary cases 以改善实验。</w:t></w:r></w:p><w:sectPr/></w:body></w:document>',
                ),
              });
              const extractionAssignment = await createAssignment(
                teacher.session,
                course.id,
                "extract",
                true,
                65536,
              );
              await teacher.session.ok(
                "PATCH",
                `/assignments/${extractionAssignment.id}/`,
                { allowed_extension: ".docx" },
              );
              const extractionCap = await touch(
                students[0].session,
                extractionAssignment.id,
                `${prefix}.docx`,
              );
              check(
                (await upload(extractionCap, document)) < 300,
                "DOCX fixture upload failed",
              );
              await students[0].session.ok("POST", "/files/finish/", {
                ident: extractionCap.ident,
              });
              const extractionSubmission = Submission.parse(
                await submit(
                  students[0].session,
                  extractionAssignment.id,
                  extractionCap.ident,
                ),
              );
              const extracted = z
                .object({
                  submission_id: z.number(),
                  file_ident: z.string(),
                  files: z.array(
                    z.object({
                      sections: z.array(z.object({ text: z.string() })),
                    }),
                  ),
                })
                .parse(
                  await bearerClient.ok(
                    "POST",
                    `/external/v1/submissions/${extractionSubmission.id}/suggestions/extract/`,
                    undefined,
                    { bearer: token },
                  ),
                );
              check(
                extracted.submission_id === extractionSubmission.id &&
                  extracted.file_ident === extractionCap.ident,
                "Extractor returned wrong submission identity",
              );
              check(
                extracted.files.some((file) =>
                  file.sections.some((section) =>
                    section.text.includes("boundary cases"),
                  ),
                ),
                "Real extractor did not return fixture suggestion text",
              );
            },
          );
        } else
          report.skip(
            "real upstream suggestion extraction",
            "Set PROBE_EXTRACTOR_AVAILABLE=1 only with a running real extractor; no fake upstream pass",
          );
      },
    );
  else {
    for (const route of [
      "GET /oauth/authorize",
      "POST /oauth/authorize",
      "POST /oauth/token",
      "POST /external/v1/courses/search",
      "POST /external/v1/assignments/search",
      "POST /external/v1/submissions/search",
    ])
      routeSkips[route] =
        "PROBE_DATABASE_URL required to register isolated local OAuth client";
  }

  // Perform last: wall-clock expiry must be genuine, not a DB timestamp edit.
  const cap = await touch(students[0].session, empty.id);
  const policyEntry = Object.entries(cap.params).find(
    ([key]) => key.toLowerCase() === "policy",
  );
  check(policyEntry, "Upload must include an expiring POST policy");
  const policy = policySchema.parse(
    JSON.parse(Buffer.from(policyEntry[1], "base64").toString("utf8")),
  );
  const wait = Date.parse(policy.expiration) - Date.now() + 1500;
  check(Number.isFinite(wait), "Upload policy expiration is invalid");
  const maxWait =
    Number(process.env.PROBE_MAX_EXPIRY_WAIT_SECONDS ?? "120") * 1000;
  if (wait > maxWait)
    report.skip(
      "real S3 capability expiry",
      "Backend upload TTL exceeds PROBE_MAX_EXPIRY_WAIT_SECONDS; use short local UPLOAD_TTL_SECONDS",
    );
  else
    await report.run("real S3 capability expiry", async () => {
      check((await upload(cap, bytes)) < 300, "Pre-expiry upload failed");
      await Bun.sleep(Math.max(0, wait));
      const result = await upload(cap, bytes);
      check(result >= 400 && result < 500, "Expired S3 policy accepted upload");
      await students[0].session.ok("POST", "/files/finish/", {
        ident: cap.ident,
      });
      check(
        digest(await download(students[0].session, cap.ident)) ===
          digest(bytes),
        "Policy expiry must reject new uploads without preventing finish of an existing object",
      );
    });
  if (process.env.PROBE_ALLOW_GLOBAL_ACTIONS === "1")
    await report.run(
      "concurrent cleanup/finish/submission preserves referenced objects and global logout revokes sessions",
      async () => {
        check(finalized, "Finalized upload prerequisite missing");
        const db = await connectLocal();
        try {
          const [rows] = await db.execute(
            "SELECT COUNT(*) AS n FROM users WHERE username NOT LIKE ?",
            ["probe\\_%"],
          );
          const counts = z
            .array(z.object({ n: z.coerce.number() }))
            .parse(rows);
          check(
            counts[0].n === 0,
            "Refusing global actions in a database containing non-probe users",
          );
          const orphan = await uploadFinished(
            students[0].session,
            empty.id,
            bytes,
          );
          const orphanPolicy = policySchema.parse(
            JSON.parse(
              Buffer.from(orphan.params.policy, "base64").toString("utf8"),
            ),
          );
          const waitUntilExpired =
            Date.parse(orphanPolicy.expiration) - Date.now() + 1500;
          check(
            waitUntilExpired <= maxWait,
            "Global cleanup requires short local upload TTL",
          );
          await Bun.sleep(Math.max(0, waitUntilExpired));
          const prior = z.object({ url: z.string() }).parse(
            await students[0].session.ok("POST", "/files/download/", {
              ident: orphan.ident,
            }),
          );
          await db.execute(
            "UPDATE file_info SET upload_finished_at=UTC_TIMESTAMP()-INTERVAL 2 DAY, upload_expires_at=UTC_TIMESTAMP()-INTERVAL 2 DAY WHERE file_ident IN (?,?)",
            [orphan.ident, finalized.ident],
          );
          const [, , resubmitted] = await Promise.all([
            teacher.session.ok("POST", "/file/cleanup_unused_uploads/"),
            students[0].session.ok("POST", "/files/finish/", {
              ident: finalized.ident,
            }),
            submit(students[0].session, assignment.id, finalized.ident),
          ]);
          const retained = Submission.parse(resubmitted);
          check(
            retained.id === submissionId && retained.file === finalized.ident,
            "Concurrent cleanup and finish must preserve the resubmitted file",
          );
          await students[0].session.denied(
            "POST",
            "/files/download/",
            { ident: orphan.ident },
            undefined,
            [404],
          );
          const removed = await fetch(localURL(prior.url));
          check(
            removed.status === 404,
            "Cleanup left the unreferenced UUID object readable",
          );
          await removed.arrayBuffer();
          check(
            digest(await download(students[0].session, finalized.ident)) ===
              digest(finalizedBytes),
            "Cleanup deleted or changed a referenced submission",
          );
          await teacher.session.ok("POST", "/clean_all_sessions/");
          await teacher.session.denied(
            "GET",
            "/auth/current_user/",
            undefined,
            undefined,
            [401],
          );
          await admin.denied(
            "GET",
            "/auth/current_user/",
            undefined,
            undefined,
            [401],
          );
        } finally {
          await db.end();
        }
      },
    );
}

await report.run("local probe setup and scenario orchestration", main);
report.inventory();
report.finish();
