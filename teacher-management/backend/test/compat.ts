#!/usr/bin/env bun
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
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

const report = new Report();
await report.run(
  "migrated password and legacy Rocket encrypted cookie",
  async () => {
    const api = new Session(baseURL());
    const user = await api.login(
      required("PROBE_LEGACY_USERNAME"),
      required("PROBE_LEGACY_PASSWORD"),
    );
    const db = await connectLocal();
    const key = randomBytes(16).toString("hex");
    try {
      await db.execute(
        "INSERT INTO user_sessions(session_key,user_id,expires_at) VALUES(?,?,UTC_TIMESTAMP()+INTERVAL 12 HOUR)",
        [key, user.id],
      );
      const secret = required("PROBE_SESSION_SECRET_KEY");
      const input = Buffer.from(
        secret,
        secret.length === 64 ? "hex" : "base64",
      );
      check(
        input.length === 32 || input.length === 64,
        "Invalid local cookie fixture key",
      );
      const info = Buffer.from(
        "COOKIE;SIGNED:HMAC-SHA256;PRIVATE:AEAD-AES-256-GCM",
      );
      const first = createHmac("sha256", input)
        .update(info)
        .update(Buffer.from([1]))
        .digest();
      const second = createHmac("sha256", input)
        .update(first)
        .update(info)
        .update(Buffer.from([2]))
        .digest();
      const master =
        input.length === 64 ? input : Buffer.concat([first, second]);
      // cookie 0.18.1 / Rocket 0.5.1: nonce || AES-GCM(value, AAD=name) || tag.
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", master.subarray(32), nonce);
      cipher.setAAD(Buffer.from("sessionid"));
      const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
      const encrypted = Buffer.concat([
        nonce,
        ciphertext,
        cipher.getAuthTag(),
      ]).toString("base64");
      const csrfNonce = randomBytes(32).toString("base64url");
      const csrfSecret = process.env.PROBE_CSRF_SECRET ?? secret;
      const csrf = `${csrfNonce}.${createHmac("sha256", csrfSecret).update(`${key}.${csrfNonce}`).digest("base64url")}`;
      const legacy = new Session(baseURL());
      legacy.cookies.set("sessionid", encodeURIComponent(encrypted));
      legacy.cookies.set("csrftoken", csrf);
      check(
        User.parse(await legacy.ok("GET", "/auth/current_user")).id === user.id,
        "Legacy encrypted session identity changed",
      );
      const [sessions] = await db.execute(
        "SELECT expires_at > UTC_TIMESTAMP()+INTERVAL 1 DAY AS renewed FROM user_sessions WHERE session_key=?",
        [key],
      );
      check(
        z.array(z.object({ renewed: z.coerce.number() })).parse(sessions)[0]
          ?.renewed === 1,
        "Legacy session did not renew",
      );
      await legacy.denied(
        "POST",
        "/files/download",
        { ident: "nonexistent-compat-file" },
        undefined,
        [404],
      );
      await legacy.ok("POST", "/auth/logout");
      await legacy.denied(
        "GET",
        "/auth/current_user",
        undefined,
        undefined,
        [401],
      );
    } finally {
      await db.execute("DELETE FROM user_sessions WHERE session_key=?", [key]);
      await db.end();
    }
  },
);
report.finish();
