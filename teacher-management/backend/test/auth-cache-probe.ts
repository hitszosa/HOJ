#!/usr/bin/env bun
import { RedisClient } from "bun";
import { createConnection } from "mysql2/promise";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

class ProbeFailure extends Error {}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new ProbeFailure(message);
}
function required(name: string) {
  const value = process.env[name];
  check(value, `Missing ${name}`);
  return value;
}
function localURL(raw: string, protocol: string) {
  const url = new URL(raw);
  check(
    url.protocol === protocol &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    "Only isolated loopback services are allowed",
  );
  return url;
}
const base = localURL(required("PROBE_BASE_URL"), "http:").origin;
const peer = localURL(required("PROBE_PEER_URL"), "http:").origin;
// Hash the raw URL: this must exactly match the backend's DATABASE_URL, including credentials/options.
const databaseURL = required("PROBE_DATABASE_URL");
const db = await createConnection({
  uri: localURL(databaseURL, "mysql:").href,
  timezone: "Z",
});
const redis = new RedisClient(
  localURL(required("PROBE_REDIS_URL"), "redis:").href,
);
check(
  process.env.PROBE_ALLOW_REDIS_PAUSE === "1",
  "Use a disposable Redis and set PROBE_ALLOW_REDIS_PAUSE=1",
);
const prefix = `probe_auth_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const password = `Auth!9_${randomBytes(20).toString("hex")}`;
const User = z.object({
  id: z.number(),
  username: z.string(),
  real_name: z.string(),
  role: z.number(),
  password_expired: z.boolean(),
});
const Course = z.object({ id: z.number(), title: z.string() });
const SessionRows = z.array(
  z.object({ session_key: z.string(), remaining: z.coerce.number() }),
);
interface Reply {
  status: number;
  data: unknown;
  headers: Headers;
}

class Session {
  cookies = new Map<string, string>();
  copy() {
    const result = new Session();
    result.cookies = new Map(this.cookies);
    return result;
  }
  async request(
    method: string,
    path: string,
    body?: unknown,
    origin = base,
    csrf = true,
  ): Promise<Reply> {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(
      "cookie",
      [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    );
    if (csrf && method !== "GET" && this.cookies.has("csrftoken"))
      headers.set(
        "x-csrftoken",
        decodeURIComponent(this.cookies.get("csrftoken")!),
      );
    const response = await fetch(`${origin}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const split = pair.indexOf("=");
      this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return {
      status: response.status,
      data: (await response.json().catch(() => null)) as unknown,
      headers: response.headers,
    };
  }
  async ok(method: string, path: string, body?: unknown, origin = base) {
    const response = await this.request(method, path, body, origin);
    check(
      response.status >= 200 && response.status < 300,
      `${method} ${path.split("?")[0]} returned ${response.status}`,
    );
    return response.data;
  }
  async login(username: string, secret: string) {
    await this.ok("POST", "/auth/login", { username, password: secret });
    return User.parse(await this.ok("GET", "/auth/current_user"));
  }
}
const admin = new Session();
let passed = 0;
let failed = 0;
async function scenario(name: string, run: () => Promise<void>) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.log(
      `FAIL ${name}: ${error instanceof ProbeFailure ? error.message : "Runtime failure (details redacted)"}`,
    );
  }
}
async function person(label: string, role = 0) {
  const username = `${prefix}_${label}`;
  const user = User.parse(
    await admin.ok("POST", "/users", {
      username,
      real_name: username,
      role,
      password_expired: false,
    }),
  );
  await admin.ok("POST", "/users/change_password", { username, password });
  const session = new Session();
  await session.login(username, password);
  return { ...user, session };
}
async function sqlCount(origin: string) {
  const text = await (await fetch(`${origin}/metrics`)).text();
  const value = Number(
    text.match(/^grader_database_queries_total (\d+)$/m)?.[1],
  );
  check(Number.isFinite(value), "Missing SQL counter");
  return value;
}
async function seedExpiry(user: number, seconds: number) {
  await db.beginTransaction();
  await db.execute(
    "UPDATE user_sessions SET expires_at=TIMESTAMPADD(SECOND,?,UTC_TIMESTAMP()) WHERE user_id=?",
    [seconds, user],
  );
  await db.execute(
    "UPDATE cache_revision SET revision=?,auth_revision=? WHERE id=1",
    [randomUUID(), randomUUID()],
  );
  await db.commit();
  // Direct maintenance SQL has no HTTP invalidation callback; let the bounded epoch lease expire.
  await Bun.sleep(2100);
}
async function sessionRows(user: number) {
  const [rows] = await db.execute(
    "SELECT session_key,TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(),expires_at) AS remaining FROM user_sessions WHERE user_id=? ORDER BY id",
    [user],
  );
  return SessionRows.parse(rows);
}

async function authEpochKey() {
  const identity = createHash("sha256").update(databaseURL).digest("hex");
  const suffix = `:auth-v1:${identity}:epoch`;
  const expected = `${process.env.REDIS_KEY_PREFIX ?? "grader-backend"}${suffix}`;
  let cursor = "0";
  for (let page = 0; page < 100; page++) {
    const result = z
      .tuple([z.string(), z.array(z.string())])
      .parse(
        await redis.send("SCAN", [
          cursor,
          "MATCH",
          `*${suffix}`,
          "COUNT",
          "100",
        ]),
      );
    if (result[1].includes(expected)) return expected;
    cursor = result[0];
    if (cursor === "0") break;
  }
  throw new ProbeFailure(
    "Auth epoch not found in bounded SCAN; PROBE_DATABASE_URL must exactly match backend DATABASE_URL and REDIS_KEY_PREFIX must match both backends",
  );
}

async function freshAuthEpoch(session: Session, key: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await session.ok("GET", "/auth/current_user", undefined, peer);
    const began = performance.now();
    const value = await redis.get(key);
    const ttl = z.coerce.number().parse(await redis.send("PTTL", [key]));
    if (value !== null && !value.startsWith("fill:")) {
      const epoch = z
        .object({
          revision: z.string(),
          expires_at_ms: z.number(),
        })
        .parse(JSON.parse(value));
      const deadline = Math.min(
        began + ttl,
        performance.now() + epoch.expires_at_ms - Date.now(),
      );
      if (deadline - performance.now() > 1000) return { value, deadline };
    }
    // Wait out an old lease naturally; the probe must not delete/extend it itself.
    await Bun.sleep(Math.max(25, Math.min(ttl + 25, 2025)));
  }
  throw new ProbeFailure(
    "Could not obtain an auth epoch with over one second remaining",
  );
}

try {
  await admin.login(
    required("PROBE_ADMIN_USERNAME"),
    required("PROBE_ADMIN_PASSWORD"),
  );
  const teacher = await person("teacher", 1);
  const assistant = await person("assistant");
  const student = await person("student");
  const course = Course.parse(
    await teacher.session.ok("POST", "/courses", {
      title: `${prefix}_course`,
      year: 2026,
      term: 2,
      teacher_ids: [teacher.id],
      student_ids: [student.id],
      assistant_ids: [assistant.id],
    }),
  );

  await scenario(
    "hot session and profile authentication performs no SQL",
    async () => {
      await teacher.session.ok("GET", "/auth/current_user", undefined, peer);
      await teacher.session.ok("GET", "/auth/current_user", undefined, peer);
      const before = await sqlCount(peer);
      const responses = await Promise.all(
        Array.from({ length: 16 }, () =>
          teacher.session.request("GET", "/auth/current_user", undefined, peer),
        ),
      );
      check(
        responses.every(
          (response) =>
            response.status === 200 &&
            User.parse(response.data).id === teacher.id,
        ),
        "Cached identity changed",
      );
      const queries = (await sqlCount(peer)) - before;
      check(queries === 0, `Hot identity used ${queries} SQL statements`);
      console.log(
        JSON.stringify({
          hot_auth_requests: responses.length,
          sql_statements: queries,
        }),
      );
    },
  );

  await scenario(
    "successful read-only POST preserves the auth epoch and peer hot authentication",
    async () => {
      await teacher.session.ok("GET", "/auth/current_user", undefined, peer);
      const key = await authEpochKey();
      const epoch = await freshAuthEpoch(teacher.session, key);
      const lookup = z
        .object({
          success: z.array(z.object({ user: User, idx: z.number() })),
          fail: z.array(z.unknown()),
        })
        .parse(
          await teacher.session.ok("POST", "/users/user_batch_lookup", {
            usernames: [],
            ids: [student.id],
          }),
        );
      check(
        lookup.fail.length === 0 &&
          lookup.success.length === 1 &&
          lookup.success[0].user.id === student.id,
        "Read-only POST did not return the requested user",
      );
      const afterPost = await redis.get(key);
      check(
        performance.now() < epoch.deadline - 100,
        "Read-only POST exceeded the lease observation window; eviction cannot be distinguished from expiry",
      );
      check(
        afterPost === epoch.value,
        "Successful read-only POST erased or replaced a still-live auth epoch",
      );
      const before = await sqlCount(peer);
      const current = User.parse(
        await teacher.session.ok("GET", "/auth/current_user", undefined, peer),
      );
      const queries = (await sqlCount(peer)) - before;
      const afterPeer = await redis.get(key);
      check(
        performance.now() < epoch.deadline - 100,
        "Peer authentication exceeded the lease observation window; rerun without competing traffic",
      );
      check(
        current.id === teacher.id,
        "Peer hot authentication changed identity",
      );
      check(
        afterPeer === epoch.value,
        "Peer authentication replaced the retained epoch",
      );
      check(
        queries === 0,
        `Peer hot identity after read-only POST used ${queries} SQL statements`,
      );
      console.log(
        JSON.stringify({
          readonly_post_epoch_retained: true,
          peer_auth_sql_statements: queries,
        }),
      );
    },
  );

  await scenario(
    "cached authentication still enforces CSRF and encrypted cookies",
    async () => {
      await teacher.session.ok("GET", "/auth/current_user", undefined, peer);
      const response = await teacher.session.request(
        "POST",
        "/manage/announcement",
        {},
        peer,
        false,
      );
      check(response.status === 403, "Cached identity bypassed CSRF");
      const tampered = teacher.session.copy();
      tampered.cookies.set("sessionid", "not-an-encrypted-ticket");
      check(
        (await tampered.request("GET", "/auth/current_user", undefined, peer))
          .status === 401,
        "Invalid cookie accepted through cache",
      );
    },
  );

  await scenario(
    "near-expiry sessions renew silently across concurrent requests",
    async () => {
      const user = await person("renew");
      await seedExpiry(user.id, 3600);
      const before = await sessionRows(user.id);
      const originalCsrf = user.session.cookies.get("csrftoken");
      const requests = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          user.session
            .copy()
            .request(
              "GET",
              "/auth/current_user",
              undefined,
              index % 2 ? base : peer,
            ),
        ),
      );
      check(
        requests.every((response) => response.status === 200),
        "Concurrent renewal logged a tab out",
      );
      const after = await sessionRows(user.id);
      check(
        after.length === 1 &&
          after[0].session_key === before[0].session_key &&
          after[0].remaining > 6 * 86400,
        "Renewal lost the session or failed to persist expiry",
      );
      const cookies = requests.flatMap((response) =>
        response.headers.getSetCookie(),
      );
      check(
        cookies.some((cookie) => cookie.startsWith("sessionid=")),
        "Renewal did not refresh browser ticket",
      );
      check(
        cookies
          .filter((cookie) => cookie.startsWith("csrftoken="))
          .every(
            (cookie) => cookie.split(";", 1)[0] === `csrftoken=${originalCsrf}`,
          ),
        "Renewal broke existing CSRF tokens",
      );
      await user.session.ok("GET", "/auth/current_user", undefined, peer);
      const queries = await sqlCount(peer);
      await user.session.ok("GET", "/auth/current_user", undefined, peer);
      check(
        (await sqlCount(peer)) === queries,
        "Renewed session did not return to cached hot path",
      );
    },
  );

  await scenario(
    "renewed cookies survive a downstream resource failure",
    async () => {
      const user = await person("renew_error");
      await seedExpiry(user.id, 3600);
      const response = await user.session.request(
        "POST",
        "/files/download",
        { ident: `${prefix}_missing` },
        peer,
      );
      check(
        response.status === 404,
        "Missing file did not produce expected failure",
      );
      check(
        response.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith("sessionid=")),
        "Resource failure discarded renewed session cookie",
      );
      check(
        (await sessionRows(user.id))[0]?.remaining > 6 * 86400,
        "Renewal was not persisted before downstream failure",
      );
    },
  );

  await scenario(
    "logout wins over a renewal waiting on the user lock",
    async () => {
      const user = await person("renew_logout");
      await seedExpiry(user.id, 3600);
      await db.beginTransaction();
      let pending: Promise<Reply> | undefined;
      try {
        await db.execute("SELECT id FROM users WHERE id=? FOR UPDATE", [
          user.id,
        ]);
        const before = await sqlCount(base);
        pending = user.session.copy().request("GET", "/auth/current_user");
        const deadline = Date.now() + 5000;
        while ((await sqlCount(base)) < before + 7) {
          check(Date.now() < deadline, "Renewal did not reach the locked user");
          await Bun.sleep(10);
        }
        await user.session.ok("POST", "/auth/logout", undefined, peer);
        await db.commit();
        check(
          (await pending).status === 401,
          "Concurrent logout was undone by renewal",
        );
        check(
          (await sessionRows(user.id)).length === 0,
          "Renewal recreated a deleted session",
        );
      } finally {
        await db.rollback();
        await pending?.catch(() => undefined);
      }
    },
  );

  await scenario(
    "expiry grace refreshes retained tickets but does not revive old sessions",
    async () => {
      const user = await person("grace");
      await seedExpiry(user.id, -3600);
      check(
        (
          await user.session.request(
            "GET",
            "/auth/current_user",
            undefined,
            peer,
          )
        ).status === 200,
        "Grace-period session forced login",
      );
      check(
        (await sessionRows(user.id))[0]?.remaining > 6 * 86400,
        "Grace renewal was not persisted",
      );
      await seedExpiry(user.id, -2 * 86400);
      check(
        (
          await user.session.request(
            "GET",
            "/auth/current_user",
            undefined,
            peer,
          )
        ).status === 401,
        "Session outside grace accepted",
      );
    },
  );

  await scenario(
    "logout and password changes revoke warmed sessions on every backend",
    async () => {
      const user = await person("logout");
      const replay = user.session.copy();
      await replay.ok("GET", "/auth/current_user", undefined, peer);
      await user.session.ok("POST", "/auth/logout");
      check(
        (await replay.request("GET", "/auth/current_user", undefined, peer))
          .status === 401,
        "Logged-out session survived Redis hit",
      );
      await user.session.login(user.username, password);
      const other = user.session.copy();
      await other.ok("GET", "/auth/current_user", undefined, peer);
      await admin.ok("POST", "/users/change_password", {
        username: user.username,
        password: `Changed!9_${randomBytes(20).toString("hex")}`,
      });
      check(
        (await other.request("GET", "/auth/current_user", undefined, peer))
          .status === 401,
        "Reset password left cached session active",
      );
    },
  );

  await scenario(
    "role, profile and course-assistant changes invalidate cached authorization",
    async () => {
      await assistant.session.ok(
        "GET",
        `/courses/${course.id}/statistics`,
        undefined,
        peer,
      );
      await assistant.session.ok(
        "GET",
        `/courses/${course.id}/statistics`,
        undefined,
        peer,
      );
      await teacher.session.ok("POST", "/users/remove_assistant", {
        course_id: course.id,
        user_id: assistant.id,
      });
      check(
        (
          await assistant.session.request(
            "GET",
            `/courses/${course.id}/statistics`,
            undefined,
            peer,
          )
        ).status === 403,
        "Cached assistant grant survived removal",
      );
      const renamed = `${prefix}_new_profile`;
      await admin.ok("PATCH", `/users/${student.id}`, {
        id: student.id,
        username: student.username,
        real_name: renamed,
        role: 1,
        password_expired: false,
      });
      const changed = User.parse(
        await student.session.ok("GET", "/auth/current_user", undefined, peer),
      );
      check(
        changed.role === 1 && changed.real_name === renamed,
        "Cached identity ignored new role/profile",
      );
      await student.session.ok(
        "GET",
        "/manage/recent_actions",
        undefined,
        peer,
      );
      await admin.ok("PATCH", `/users/${student.id}`, {
        id: student.id,
        username: student.username,
        real_name: renamed,
        role: 0,
        password_expired: false,
      });
      check(
        (
          await student.session.request(
            "GET",
            "/manage/recent_actions",
            undefined,
            peer,
          )
        ).status === 403,
        "Demoted teacher retained backoffice read access",
      );
    },
  );

  await scenario(
    "missed invalidation is bounded by the two-second identity lease",
    async () => {
      const user = await person("lease");
      await user.session.ok("GET", "/auth/current_user", undefined, peer);
      await db.beginTransaction();
      await db.execute("DELETE FROM user_sessions WHERE user_id=?", [user.id]);
      await db.execute(
        "UPDATE cache_revision SET revision=?,auth_revision=? WHERE id=1",
        [randomUUID(), randomUUID()],
      );
      await db.commit();
      await Bun.sleep(2100);
      check(
        (
          await user.session.request(
            "GET",
            "/auth/current_user",
            undefined,
            peer,
          )
        ).status === 401,
        "Old identity outlived its epoch lease",
      );
    },
  );

  await scenario(
    "Redis failure falls back and recovery does not restore revoked identity",
    async () => {
      const user = await person("outage");
      const replay = user.session.copy();
      await replay.ok("GET", "/auth/current_user", undefined, peer);
      await redis.send("CLIENT", ["PAUSE", "1500", "ALL"]);
      const began = performance.now();
      check(
        (
          await user.session.request(
            "GET",
            "/auth/current_user",
            undefined,
            peer,
          )
        ).status === 200,
        "Redis outage rejected valid identity",
      );
      await user.session.ok("POST", "/auth/logout");
      check(
        performance.now() - began < 1200,
        "Redis outage blocked DB fallback",
      );
      await Bun.sleep(2200);
      check(
        (await replay.request("GET", "/auth/current_user", undefined, peer))
          .status === 401,
        "Redis recovery resurrected revoked session",
      );
    },
  );

  await scenario(
    "disabled users cannot authenticate from warm cache",
    async () => {
      const user = await person("disabled");
      await user.session.ok("GET", "/auth/current_user", undefined, peer);
      await admin.ok("DELETE", `/users/${user.id}`);
      check(
        (
          await user.session.request(
            "GET",
            "/auth/current_user",
            undefined,
            peer,
          )
        ).status === 401,
        "Disabled user retained cached identity",
      );
    },
  );
} catch (error) {
  failed++;
  console.log(
    `FAIL auth probe setup: ${error instanceof ProbeFailure ? error.message : "Runtime failure (details redacted)"}`,
  );
} finally {
  await db.rollback();
  await db.end();
  redis.close();
}
console.log(JSON.stringify({ passed, failed }));
if (failed) process.exitCode = 1;
