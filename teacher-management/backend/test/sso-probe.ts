#!/usr/bin/env bun
import { z } from "zod";

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

const report = new Report();
await report.run(
  "SSO redirect, state binding, and rejected callbacks",
  async () => {
    const session = new Session(baseURL());
    const login = await session.request("GET", "/login/sso?next=%2Fcourses");
    check(
      [302, 303, 307].includes(login.status),
      "Configured SSO must redirect to its provider",
    );
    const location = login.headers.get("location");
    check(location, "Missing SSO authorization redirect");
    const authorization = new URL(location);
    const state = authorization.searchParams.get("state");
    check(
      authorization.searchParams.get("response_type") === "code" && state,
      "Missing SSO protocol parameters",
    );
    check(session.cookies.has("sso_state"), "Missing SSO state cookie");
    await session.denied(
      "GET",
      "/auth/callback?code=unused&state=wrong",
      undefined,
      undefined,
      [403],
    );
    check(
      !session.cookies.has("sso_state"),
      "Rejected callback must clear state cookie",
    );
    const clean = await session.request(
      "GET",
      "/login/sso?next=%2F%2Foutside.invalid",
    );
    const nextLocation = clean.headers.get("location");
    check(nextLocation, "Missing repeat authorization redirect");
    const nextState = new URL(nextLocation).searchParams.get("state");
    check(nextState, "Missing repeat state");
    const denied = await session.request(
      "GET",
      `/auth/callback?error=access_denied&state=${encodeURIComponent(nextState)}`,
    );
    check(
      [302, 303, 307].includes(denied.status),
      "Provider denial must redirect locally",
    );
    check(
      denied.headers.get("location")?.startsWith("/login/error?"),
      "Provider denial redirected outside local login flow",
    );
    await session.denied(
      "GET",
      `/auth/callback?code=unused&state=${encodeURIComponent(nextState)}`,
      undefined,
      undefined,
      [403],
    );
  },
);
report.finish();
