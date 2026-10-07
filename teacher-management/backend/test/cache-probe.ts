#!/usr/bin/env bun
import { RedisClient } from "bun";
import { createConnection } from "mysql2/promise";
import { randomBytes, randomUUID } from "node:crypto";
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
const databaseURL = localURL(required("PROBE_DATABASE_URL"), "mysql:");
const redisURL = localURL(required("PROBE_REDIS_URL"), "redis:");
check(
  process.env.PROBE_ALLOW_REDIS_PAUSE === "1",
  "Set PROBE_ALLOW_REDIS_PAUSE=1 only for a disposable Redis; this probe briefly pauses ALL Redis clients",
);
const db = await createConnection({ uri: databaseURL.href, timezone: "Z" });
const redis = new RedisClient(redisURL.href);
const prefix = `probe_cache_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const password = `P!9_${randomBytes(20).toString("hex")}`;
const User = z.object({
  id: z.number(),
  username: z.string(),
  real_name: z.string(),
  role: z.number(),
  password_expired: z.boolean(),
});
const Course = z.object({ id: z.number(), title: z.string() });
const Assignment = z.object({
  id: z.number(),
  title: z.string(),
  submit_allowed: z.boolean(),
});
const Submission = z.object({ id: z.number(), score: z.number().nullable(), user: User });
const Statistics = z.object({ average: z.number(), median: z.number() });

class Session {
  cookies = new Map<string, string>();
  async request(method: string, path: string, body?: unknown, origin = base) {
    const headers = new Headers({ "content-type": "application/json" });
    headers.set(
      "cookie",
      [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    );
    if (method !== "GET" && this.cookies.has("csrftoken"))
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
      `FAIL ${name}: ${error instanceof ProbeFailure ? error.message : "Runtime failure (credentials and responses redacted)"}`,
    );
  }
}
async function person(role: number, label: string) {
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
async function hitCount(origin = base) {
  const text = await (await fetch(`${origin}/metrics`)).text();
  const match = text.match(/^grader_cache_hits_total (\d+)$/m);
  return match ? Number(match[1]) : 0;
}
async function keys() {
  let cursor = "0";
  const found: string[] = [];
  do {
    const result = z
      .tuple([z.string(), z.array(z.string())])
      .parse(
        await redis.send("SCAN", [
          cursor,
          "MATCH",
          `${required("PROBE_REDIS_PREFIX")}*`,
          "COUNT",
          "100",
        ]),
      );
    cursor = result[0];
    found.push(...result[1]);
  } while (cursor !== "0");
  return found;
}

try {
  await admin.login(
    required("PROBE_ADMIN_USERNAME"),
    required("PROBE_ADMIN_PASSWORD"),
  );
  const teacher = await person(1, "teacher");
  const student = await person(0, "student");
  const assistant = await person(0, "assistant");
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
  let title = course.title;
  const detail = () =>
    teacher.session
      .ok("GET", `/courses/${course.id}`, undefined, peer)
      .then((value) => Course.parse(value));

  await scenario(
    "warm responses are reused across backend instances",
    async () => {
      await detail();
      const before = await hitCount(peer);
      check((await detail()).title === title, "Warm response changed");
      check((await hitCount(peer)) > before, "Redis hit did not occur");
      const beforeOther = await hitCount();
      await teacher.session.ok("GET", `/courses/${course.id}`);
      check(
        (await hitCount()) > beforeOther,
        "Second backend did not share Redis cache",
      );
    },
  );

  await scenario(
    "committed writes and late old fills never revive stale data",
    async () => {
      const oldKeys = await keys();
      const oldEntries: [string, Uint8Array][] = [];
      for (const key of oldKeys) {
        const data = await redis.getBuffer(key);
        if (data) oldEntries.push([key, data]);
      }
      title = `${prefix}_renamed`;
      await teacher.session.ok("PATCH", `/courses/${course.id}`, { title });
      for (const [key, data] of oldEntries)
        await redis.set(key, data, "EX", 60);
      check(
        (await detail()).title === title,
        "Late old cache fill overrode committed data",
      );
      const response = await teacher.session.request(
        "PATCH",
        `/courses/${course.id}`,
        { title: `${prefix}_rollback`, teacher_ids: [student.id] },
      );
      check(
        response.status === 400,
        "Invalid member mutation was not rejected",
      );
      check(
        (await detail()).title === title,
        "Rolled-back update changed cached data",
      );
    },
  );

  await scenario(
    "course membership and assistant revocation defeat warm caches",
    async () => {
      const list = () =>
        student.session
          .ok("GET", "/courses", undefined, peer)
          .then((value) => z.array(Course).parse(value));
      check(
        (await list()).some((value) => value.id === course.id),
        "Initial student membership missing",
      );
      await list();
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
      await teacher.session.ok("PATCH", `/courses/${course.id}`, {
        student_ids: [],
        assistant_ids: [],
      });
      check(
        !(await list()).some((value) => value.id === course.id),
        "Revoked student still sees cached course",
      );
      check(
        (
          await assistant.session.request(
            "GET",
            `/courses/${course.id}/statistics`,
            undefined,
            peer,
          )
        ).status === 403,
        "Revoked assistant bypassed live permission check",
      );
      await teacher.session.ok("PATCH", `/courses/${course.id}`, {
        student_ids: [student.id],
        assistant_ids: [assistant.id],
      });
    },
  );

  await scenario(
    "membership commit during delayed authentication rejects an old-version hit",
    async () => {
      await student.session.ok("GET", "/courses", undefined, peer);
      await student.session.ok("GET", "/courses", undefined, peer);
      await db.beginTransaction();
      await db.execute(
        "UPDATE user_sessions SET expires_at=UTC_TIMESTAMP()+INTERVAL 1 HOUR WHERE user_id=?",
        [student.id],
      );
      await db.query(
        "UPDATE cache_revision SET revision=UUID(),auth_revision=UUID() WHERE id=1",
      );
      await db.commit();
      await Bun.sleep(2100);
      await db.beginTransaction();
      let pending: Promise<unknown> | undefined;
      try {
        await db.execute(
          "SELECT id FROM user_sessions WHERE user_id=? FOR UPDATE",
          [student.id],
        );
        const text = await (await fetch(`${peer}/metrics`)).text();
        const before = Number(
          text.match(/^grader_database_queries_total (\d+)$/m)?.[1],
        );
        check(Number.isFinite(before), "Missing SQL counter");
        pending = student.session.ok("GET", "/courses", undefined, peer);
        const deadline = Date.now() + 5000;
        while (true) {
          const metrics = await (await fetch(`${peer}/metrics`)).text();
          if (
            Number(
              metrics.match(/^grader_database_queries_total (\d+)$/m)?.[1],
            ) >=
            before + 6
          )
            break;
          check(
            Date.now() < deadline,
            "Request did not reach session renewal lock",
          );
          await Bun.sleep(10);
        }
        await teacher.session.ok("PATCH", `/courses/${course.id}`, {
          student_ids: [],
        });
        await db.commit();
        const rows = z.array(Course).parse(await pending);
        check(
          !rows.some((row) => row.id === course.id),
          "An in-flight old epoch bypassed committed membership revocation",
        );
      } finally {
        await db.rollback();
        await pending?.catch(() => undefined);
        await teacher.session.ok("PATCH", `/courses/${course.id}`, {
          student_ids: [student.id],
        });
      }
    },
  );

  await scenario(
    "hidden openings and submission deadlines bound cached responses",
    async () => {
      const opens = Math.floor(Date.now() / 1000) * 1000 + 3000;
      const closes = opens + 3000;
      const assignment = Assignment.parse(
        await teacher.session.ok("POST", "/assignments", {
          course: course.id,
          title: `${prefix}_clock`,
          start_time: new Date(opens).toISOString(),
          due_time: new Date(closes).toISOString(),
          max_file_size: 4096,
        }),
      );
      await teacher.session.ok("POST", `/assignments/${assignment.id}/publish`);
      const list = () =>
        student.session
          .ok("GET", `/assignments?course=${course.id}`, undefined, peer)
          .then((value) => z.array(Assignment).parse(value));
      const recent = () =>
        student.session
          .ok("GET", "/courses/with_recent_assignments", undefined, peer)
          .then((value) =>
            z
              .array(
                z.object({
                  id: z.number(),
                  recent_assignments: z.array(Assignment),
                }),
              )
              .parse(value),
          );
      check(
        !(await list()).some((value) => value.id === assignment.id),
        "Future assignment visible early",
      );
      await list();
      await recent();
      await recent();
      await Bun.sleep(Math.max(0, opens - Date.now() + 100));
      check(
        (await list()).find((value) => value.id === assignment.id)
          ?.submit_allowed,
        "Opening boundary was hidden by cache TTL",
      );
      check(
        (await recent())
          .find((value) => value.id === course.id)
          ?.recent_assignments.some((value) => value.id === assignment.id),
        "Previously hidden assignment missing from cached recent list",
      );
      await list();
      await Bun.sleep(Math.max(0, closes - Date.now() + 100));
      check(
        (await list()).find((value) => value.id === assignment.id)
          ?.submit_allowed === false,
        "Deadline left cached submission permission true",
      );
      check(
        z
          .array(Assignment)
          .parse(
            await student.session.ok(
              "GET",
              `/assignments?course=${course.id}&submit_allowed=true`,
              undefined,
              peer,
            ),
          )
          .every((value) => value.id !== assignment.id),
        "Expired assignment remains in open-only list",
      );
    },
  );

  await scenario(
    "submission, grade and user changes refresh all dependent projections",
    async () => {
      const assignment = Assignment.parse(
        await teacher.session.ok("POST", "/assignments", {
          course: course.id,
          title: `${prefix}_graded`,
          start_time: new Date(Date.now() - 60000).toISOString(),
          due_time: new Date(Date.now() + 3600000).toISOString(),
          max_file_size: 4096,
        }),
      );
      await teacher.session.ok("POST", `/assignments/${assignment.id}/publish`);
      const ident = randomUUID();
      // A ready local metadata fixture exercises real submit/resubmit transactions without an external storage dependency.
      await db.beginTransaction();
      await db.execute(
        "INSERT INTO file_info(file_ident,uploaded_by,assignment_id,upload_finished_at,upload_state,upload_purpose) VALUES(?,?,?,UTC_TIMESTAMP(),'ready','submission')",
        [ident, student.id, assignment.id],
      );
      await db.execute("UPDATE cache_revision SET revision=? WHERE id=1", [
        randomUUID(),
      ]);
      await db.commit();
      const missing = () =>
        teacher.session
          .ok(
            "GET",
            `/submissions/no_submission_students?assignment=${assignment.id}`,
            undefined,
            peer,
          )
          .then((value) => z.array(User).parse(value));
      const stats = () =>
        teacher.session
          .ok(
            "GET",
            `/assignments/${assignment.id}/statistics`,
            undefined,
            peer,
          )
          .then((value) => Statistics.parse(value));
      const submissions = () =>
        teacher.session
          .ok(
            "GET",
            `/submissions?assignment=${assignment.id}`,
            undefined,
            peer,
          )
          .then((value) => z.array(Submission).parse(value));
      await missing();
      await stats();
      await submissions();
      const submission = Submission.parse(
        await student.session.ok(
          "POST",
          `/submissions?assignment=${assignment.id}&file_ident=${ident}`,
        ),
      );
      check(
        !(await missing()).some((value) => value.id === student.id),
        "New submission missing from cached roster",
      );
      check(
        (await submissions()).some((value) => value.id === submission.id),
        "New submission missing from cached list",
      );
      await teacher.session.ok("POST", "/submissions/score_update", {
        submission: submission.id,
        score: 87,
      });
      check(
        (await stats()).average === 87 &&
          (await submissions())[0]?.score === 87,
        "Grade update left stale statistics or submissions",
      );
      const renamed = `${prefix}_student_renamed`;
      await teacher.session.ok("PATCH", `/users/${student.id}`, {
        id: student.id,
        username: student.username,
        real_name: renamed,
        role: 0,
        password_expired: false,
      });
      check(
        (await submissions())[0]?.user.real_name === renamed,
        "User update did not invalidate joined cached response",
      );
      await student.session.ok(
        "POST",
        `/submissions?assignment=${assignment.id}&file_ident=${ident}`,
      );
      check(
        (await stats()).average === 0 && (await submissions())[0]?.score === 0,
        "Resubmission did not clear cached grade",
      );
    },
  );

  await scenario(
    "Redis timeout, outage writes and recovery preserve committed state",
    async () => {
      await detail();
      await detail();
      await redis.send("CLIENT", ["PAUSE", "1500", "ALL"]);
      const started = performance.now();
      title = `${prefix}_during_outage`;
      await teacher.session.ok("PATCH", `/courses/${course.id}`, { title });
      check((await detail()).title === title, "Redis outage served stale data");
      check(
        performance.now() - started < 1200,
        "Redis outage blocked database-backed request",
      );
      await Bun.sleep(2200);
      check(
        (await detail()).title === title,
        "Recovery resurrected pre-outage cache",
      );
      const before = await hitCount(peer);
      await detail();
      check(
        (await hitCount(peer)) > before,
        "Redis did not recover without restarting backend",
      );
    },
  );

  await scenario(
    "corrupt and expired Redis entries fall back to fresh JSON",
    async () => {
      await detail();
      const cached = await keys();
      const selected = cached.filter((key) =>
        key.endsWith(`courses:detail:${course.id}:${teacher.id}:1`),
      );
      check(selected.length > 0, "Missing seeded cache entry");
      for (const key of selected)
        await redis.set(key, "invalid-cache-frame", "EX", 60);
      check(
        (await detail()).title === title,
        "Corrupt cache entry escaped to response",
      );
      for (const key of selected) {
        const value = await redis.getBuffer(key);
        if (!value || value.length < 12) continue;
        const expired = Buffer.concat([
          Buffer.from(value.subarray(0, 12)),
          Buffer.from(
            JSON.stringify({ id: course.id, title: "expired-stale-title" }),
          ),
        ]);
        expired.writeBigInt64BE(1n, 4);
        await redis.set(key, expired, "EX", 60);
      }
      check(
        (await detail()).title === title,
        "Expired framed response escaped to caller",
      );
    },
  );

  await scenario(
    "deactivated identity cannot use warm cached responses",
    async () => {
      await student.session.ok("GET", "/courses", undefined, peer);
      await student.session.ok("GET", "/courses", undefined, peer);
      await teacher.session.ok("DELETE", `/users/${student.id}`);
      check(
        (await student.session.request("GET", "/courses", undefined, peer))
          .status === 401,
        "Deactivated session used cached authorization",
      );
    },
  );
} catch (error) {
  failed++;
  console.log(
    `FAIL cache probe setup: ${error instanceof ProbeFailure ? error.message : "Runtime failure (details redacted)"}`,
  );
} finally {
  await db.rollback();
  await db.end();
  redis.close();
}
console.log(JSON.stringify({ passed, failed }));
if (failed) process.exitCode = 1;
