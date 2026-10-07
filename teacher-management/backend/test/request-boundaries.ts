#!/usr/bin/env bun
import { connect, type Socket } from "node:net";
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

  skip(name: string, reason: string) {
    this.skipped++;
    console.log(`SKIP ${name}: ${reason}`);
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
const base = baseURL();
const poolSize = Number(required("PROBE_POOL_SIZE"));
check(
  Number.isInteger(poolSize) && poolSize >= 1 && poolSize <= 100,
  "PROBE_POOL_SIZE must match the local backend pool (1..100)",
);
const admin = new Session(base);
await admin.login(
  required("PROBE_ADMIN_USERNAME"),
  required("PROBE_ADMIN_PASSWORD"),
);

async function counter() {
  const text = await (await fetch(`${base}/metrics`)).text();
  const match = text.match(/^grader_database_queries_total (\d+)$/m);
  check(match, "Missing database counter");
  return Number(match[1]);
}

async function waitForQueries(minimum: number) {
  const deadline = Date.now() + 5000;
  while ((await counter()) < minimum) {
    check(Date.now() < deadline, "Request did not reach its database lock");
    await Bun.sleep(10);
  }
}

await report.run(
  "unfinished anonymous form bodies do not reserve database connections",
  async () => {
    const origin = new URL(base);
    check(origin.protocol === "http:", "Raw body probe requires local HTTP");
    const sockets: Socket[] = [];
    try {
      await Promise.all(
        Array.from(
          { length: poolSize },
          () =>
            new Promise<void>((resolve, reject) => {
              const socket = connect({
                host: origin.hostname,
                port: Number(origin.port || 80),
              });
              sockets.push(socket);
              socket.on("error", reject);
              socket.once("connect", () => {
                socket.write(
                  `POST /api/oauth/token HTTP/1.1\r\nHost: ${origin.host}\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 4096\r\n\r\ngrant_type=`,
                  () => resolve(),
                );
              });
            }),
        ),
      );
      await Bun.sleep(250);
      const response = await fetch(`${base}/healthz`, {
        signal: AbortSignal.timeout(1500),
      }).catch(() => null);
      check(
        response?.status === 200,
        "Incomplete request bodies exhausted the database pool",
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await Bun.sleep(100);
    }
  },
);

await report.run(
  "queued teacher self-update rejects a committed role revocation",
  async () => {
    const teacher = await createPerson(admin, "revoked_teacher", 1);
    const db = await connectLocal();
    let pending: Promise<Reply> | undefined;
    try {
      await db.beginTransaction();
      await db.execute("SELECT id FROM users WHERE id=? FOR UPDATE", [
        teacher.id,
      ]);
      const before = await counter();
      pending = teacher.session.request("PUT", `/users/${teacher.id}`, {
        id: teacher.id,
        username: teacher.username,
        real_name: teacher.username,
        role: 2,
        password_expired: false,
      });
      await waitForQueries(before + 3);
      await db.execute("UPDATE users SET role=0 WHERE id=?", [teacher.id]);
      await db.commit();
      const response = await pending;
      const [rows] = await db.execute("SELECT role FROM users WHERE id=?", [
        teacher.id,
      ]);
      const role = z.array(z.object({ role: z.number() })).parse(rows)[0]?.role;
      check(
        response.status === 403 && role === 0,
        "Revoked teacher completed a queued privilege-changing write",
      );
    } finally {
      await db.rollback();
      await pending?.catch(() => undefined);
      await db.end();
    }
  },
);

if (poolSize < 2) {
  report.skip(
    "cross-member concurrent course creation",
    "Needs at least two application connections; rerun with the normal pool size",
  );
} else {
  await report.run(
    "cross-member concurrent course creation uses consistent user lock order",
    async () => {
      const a = await createPerson(admin, "course_teacher_a", 1);
      const b = await createPerson(admin, "course_teacher_b", 1);
      const blockerA = await connectLocal();
      const blockerB = await connectLocal();
      let pending: Promise<Reply[]> | undefined;
      try {
        await blockerA.beginTransaction();
        await blockerB.beginTransaction();
        await blockerA.execute("SELECT id FROM users WHERE id=? FOR UPDATE", [
          a.id,
        ]);
        await blockerB.execute("SELECT id FROM users WHERE id=? FOR UPDATE", [
          b.id,
        ]);
        const before = await counter();
        pending = Promise.all([
          a.session.request("POST", "/courses", {
            title: `${prefix}_a`,
            year: 2026,
            term: 2,
            teacher_ids: [b.id],
            student_ids: [],
            assistant_ids: [],
          }),
          b.session.request("POST", "/courses", {
            title: `${prefix}_b`,
            year: 2026,
            term: 2,
            teacher_ids: [a.id],
            student_ids: [],
            assistant_ids: [],
          }),
        ]);
        await waitForQueries(before + 6);
        await blockerB.commit();
        // With the old order A advances to its own row while B waits for A.
        // The new sorted order leaves both waiting on the first user instead.
        await Bun.sleep(200);
        await blockerA.commit();
        const responses = await pending;
        check(
          responses.every((response) => response.status === 201),
          "Valid cross-member creations deadlocked or failed",
        );
      } finally {
        await blockerA.rollback();
        await blockerB.rollback();
        await pending?.catch(() => undefined);
        await blockerA.end();
        await blockerB.end();
      }
    },
  );
}

report.finish();
