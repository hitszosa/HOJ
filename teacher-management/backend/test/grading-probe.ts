#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { zipSync } from "fflate";

// Run against isolated loopback services; all fixtures remain available for UI acceptance.
class ProbeFailure extends Error {}
let checks = 0;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new ProbeFailure(message);
  checks++;
}
function required(key: string): string {
  const value = process.env[key];
  check(value, `Missing environment variable ${key}`);
  return value;
}
function localURL(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProbeFailure("Invalid URL configuration or response");
  }
  check(
    ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      !url.username && !url.password,
    "Refusing non-loopback URL or URL credentials",
  );
  return url;
}
function parse<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  check(result.success, `${label}: invalid response shape`);
  return result.data;
}
const integer = z.number().int().safe();
const Rule = z.object({ id: z.string(), reason: z.string(), delta_cents: integer });
const Mark = Rule.extend({
  mark_id: z.string(), page: integer,
  x: z.number(), y: z.number(), width: z.number(), height: z.number(),
});
const Review = z.object({
  revision: integer.nonnegative(), base_cents: integer, marks: z.array(Mark),
  updated_by: integer.nullable(), updated_at: z.string().nullable(), score: z.number().nullable(),
});
const Rubric = z.object({
  user_id: integer, user_name: z.string(), revision: integer.nonnegative(),
  base_cents: integer, rules: z.array(Rule),
});
const Document = z.object({
  version: z.string().min(1), page_count: integer.positive(),
  url: z.string(), original_url: z.string(), original_name: z.string(), review: Review,
});
const ExportRow = z.object({
  user_id: integer, username: z.string(), real_name: z.string(),
  submission_id: integer.nullable(), score: z.number().nullable(), review: Review.nullable(),
  grader_name: z.string().nullable(),
});
const User = z.object({ id: integer, username: z.string(), role: integer });
const Submission = z.object({
  id: integer, assignment: integer, user: User, file: z.string(), status: integer, score: z.number().nullable(),
});
type ReviewData = z.infer<typeof Review>;
type DocumentData = z.infer<typeof Document>;
type RubricData = z.infer<typeof Rubric>;
type MarkData = z.infer<typeof Mark>;
type Reply = { status: number; data: unknown };

class Session {
  private cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  async request(method: string, path: string, body?: unknown, raw?: string | Uint8Array<ArrayBuffer>): Promise<Reply> {
    check(path.startsWith("/") && !path.startsWith("//"), "API path must be relative");
    const headers = new Headers({ accept: "application/json", "user-agent": "grader-grading-probe" });
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const csrf = this.cookies.get("csrftoken");
    if (csrf && !["GET", "HEAD"].includes(method)) headers.set("X-CSRFTOKEN", decodeURIComponent(csrf));
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    if (payload !== undefined) headers.set("content-type", raw instanceof Uint8Array ? "application/octet-stream" : "application/json");
    const response = await fetch(`${this.base}/api${path}`, {
      method, headers, body: payload, redirect: "manual", signal: AbortSignal.timeout(120_000),
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
    if (text) {
      try { data = JSON.parse(text); } catch { /* Status assertions handle non-JSON errors. */ }
    }
    return { status: response.status, data };
  }
  async ok(method: string, path: string, body?: unknown): Promise<unknown> {
    const reply = await this.request(method, path, body);
    check(reply.status >= 200 && reply.status < 300, `${method} ${path}: expected HTTP success, received ${reply.status}`);
    return reply.data;
  }
  async rejected(method: string, path: string, body: unknown, statuses: readonly number[], label: string, raw?: string) {
    const reply = await this.request(method, path, body, raw);
    check(statuses.includes(reply.status), `${label}: unexpected HTTP ${reply.status}`);
  }
  async login(username: string, password: string) {
    await this.ok("POST", "/auth/login/", { username, password });
    check(this.cookies.has("sessionid") && this.cookies.has("csrftoken"), "Login must issue session and CSRF cookies");
    const user = parse(User, await this.ok("GET", "/auth/current_user/"), "Login");
    check(user.username === username, "Login identity mismatch");
    return user;
  }
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const rubricPath = (assignment: number) => `/assignments/${assignment}/grading/rubric`;
const rubricsPath = (assignment: number) => `/assignments/${assignment}/grading/rubrics`;
const reportPath = (assignment: number) => `/assignments/${assignment}/grading/report`;
const reviewPath = (submission: number) => `/submissions/${submission}/grading`;
const documentPath = (submission: number) => `/submissions/${submission}/grading/document`;
const reviewBody = (document: DocumentData, review: ReviewData) => ({
  version: document.version, revision: review.revision, base_cents: review.base_cents, marks: review.marks,
});
function sameReview(actual: ReviewData, expected: ReviewData, label: string) {
  check(actual.revision === expected.revision && actual.base_cents === expected.base_cents &&
    actual.score === expected.score && actual.updated_by === expected.updated_by &&
    actual.updated_at === expected.updated_at && JSON.stringify(actual.marks) === JSON.stringify(expected.marks), label);
}
function emptyReview(review: ReviewData, label: string) {
  check(review.revision === 0 && review.marks.length === 0 && review.score === null &&
    review.updated_by === null && review.updated_at === null, label);
}
async function prepare(session: Session, submission: number) {
  return parse(Document, await session.ok("POST", documentPath(submission), {}), "Prepare document");
}
async function save(session: Session, submission: number, body: unknown) {
  return parse(Review, await session.ok("PUT", reviewPath(submission), body), "Save review");
}
async function rubrics(session: Session, assignment: number) {
  return parse(z.array(Rubric), await session.ok("GET", rubricsPath(assignment)), "Rubrics");
}
async function report(session: Session, assignment: number) {
  return parse(z.array(ExportRow), await session.ok("GET", reportPath(assignment)), "Batch report");
}
async function downloaded(url: string) {
  const response = await fetch(localURL(url), { redirect: "manual", signal: AbortSignal.timeout(120_000) });
  check(response.ok, "Real signed S3 download failed");
  return new Uint8Array(await response.arrayBuffer());
}
async function pdfBytes(document: DocumentData) {
  const bytes = await downloaded(document.url);
  check(new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-", "Preview must be a real PDF download");
  return bytes;
}
function objectIdentity(url: string) {
  const parsed = localURL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

async function main() {
  const base = localURL(required("PROBE_BASE_URL"));
  check(base.pathname === "/" && !base.search && !base.hash, "PROBE_BASE_URL must be a loopback origin");
  const adminUsername = required("PROBE_ADMIN_USERNAME");
  const adminPassword = required("PROBE_ADMIN_PASSWORD");
  const fixturePassword = required("PROBE_GRADING_PASSWORD");
  const manifestPath = required("PROBE_GRADING_MANIFEST");
  const pdf = new Uint8Array(await Bun.file(required("PROBE_GRADING_PDF")).arrayBuffer());
  const docx = new Uint8Array(await Bun.file(required("PROBE_GRADING_DOCX")).arrayBuffer());
  check(new TextDecoder().decode(pdf.subarray(0, 5)) === "%PDF-", "PROBE_GRADING_PDF must contain a PDF");
  check(docx.length > 4 && docx[0] === 0x50 && docx[1] === 0x4b, "PROBE_GRADING_DOCX must contain a DOCX archive");
  check(pdf.length <= 50 * 1024 * 1024 && docx.length <= 50 * 1024 * 1024, "Sample documents must fit the upload limit");
  check(!(await Bun.file(manifestPath).exists()), "Refusing to overwrite an existing manifest");
  const prefix = `probe_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  const admin = new Session(base.origin);
  const administrator = await admin.login(adminUsername, adminPassword);
  check(administrator.role === 2, "Probe credentials must identify a local administrator");
  async function person(label: string, role: number) {
    const username = `${prefix}_${label}`;
    const user = parse(User, await admin.ok("POST", "/users/", {
      username, real_name: username, role, password_expired: false,
    }), "Create fixture user");
    check(user.username === username && user.role === role, "Created user identity mismatch");
    await admin.ok("POST", "/users/change_password/", { username, password: fixturePassword });
    const session = new Session(base.origin);
    const loggedIn = await session.login(username, fixturePassword);
    check(loggedIn.id === user.id, "Fixture login ID mismatch");
    return { ...user, session };
  }
  const teacherA = await person("teacher_a", 1);
  const teacherB = await person("teacher_b", 1);
  const outsider = await person("outside_teacher", 1);
  const student = await person("student", 0);
  const pending = await person("pending", 0);
  const missing = await person("missing", 0);
  const course = parse(z.object({ id: integer }), await admin.ok("POST", "/courses/", {
    title: `${prefix}_course`, year: new Date().getUTCFullYear(), term: 2,
    teacher_ids: [teacherA.id, teacherB.id], student_ids: [student.id, pending.id, missing.id], assistant_ids: [],
  }), "Create course");
  async function assignment(extension: string) {
    const created = parse(z.object({ id: integer }), await teacherA.session.ok("POST", "/assignments/", {
      course: String(course.id), title: `${prefix}_${extension}`,
      start_time: new Date(Date.now() - 3600_000).toISOString(),
      due_time: new Date(Date.now() + 7 * 86400_000).toISOString(), max_file_size: 50 * 1024 * 1024,
    }), "Create assignment");
    await teacherA.session.ok("PATCH", `/assignments/${created.id}/`, {
      description: `${prefix} visual grading acceptance`, score: 100,
      allowed_extension: `.${extension}`, max_file_size: 50 * 1024 * 1024,
    });
    await teacherA.session.ok("POST", `/assignments/${created.id}/publish/`);
    return created.id;
  }
  const pdfAssignment = await assignment("pdf");
  const wordAssignment = await assignment("docx");
  async function uploadAndSubmit(session: Session, assignmentId: number, bytes: Uint8Array, extension: string, originalName?: string) {
    const filename = originalName ?? `${prefix}_${randomBytes(4).toString("hex")}.${extension}`;
    const cap = parse(z.object({ ident: z.string(), url: z.string(), params: z.record(z.string(), z.string()) }),
      await session.ok("POST", "/files/touch/", {
        original_file_name: filename, ident: { type: "submission", assignment_id: assignmentId },
      }), "S3 upload capability");
    check(cap.params.key === cap.ident, "S3 POST key must be the original file UUID");
    const form = new FormData();
    for (const [key, value] of Object.entries(cap.params)) form.append(key, value);
    form.append("file", new Blob([Uint8Array.from(bytes)]), filename);
    const response = await fetch(localURL(cap.url), {
      method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(120_000),
    });
    await response.arrayBuffer();
    check(response.ok, "Real S3 multipart POST failed");
    await session.ok("POST", "/files/finish/", { ident: cap.ident });
    const download = parse(z.object({ ident: z.string(), url: z.string() }),
      await session.ok("POST", "/files/download/", { ident: cap.ident }), "Original download");
    check(download.ident === cap.ident && digest(await downloaded(download.url)) === digest(bytes), "Uploaded original bytes mismatch");
    const submission = parse(Submission, await session.ok("POST",
      `/submissions/?assignment=${assignmentId}&file_ident=${encodeURIComponent(cap.ident)}`, {}), "Create submission");
    check(submission.assignment === assignmentId && submission.file === cap.ident && submission.status === 0,
      "Submission must reference uploaded original and start ungraded");
    return submission;
  }
  const pdfSubmission = await uploadAndSubmit(student.session, pdfAssignment, pdf, "pdf");
  const pendingSubmission = await uploadAndSubmit(pending.session, pdfAssignment, pdf, "pdf");
  const wordSubmission = await uploadAndSubmit(student.session, wordAssignment, docx, "docx");

  const bonus = { id: crypto.randomUUID(), reason: "完整论证", delta_cents: 1000 };
  const deduction = { id: crypto.randomUUID(), reason: "单位遗漏", delta_cents: -250 };
  const rubricBody = { revision: 0, base_cents: 10000, rules: [bonus, deduction] };
  const aInitial = parse(Rubric, await teacherA.session.ok("PUT", rubricPath(pdfAssignment), rubricBody), "Teacher A rubric");
  check(aInitial.user_id === teacherA.id && aInitial.revision === 1 && aInitial.base_cents === 10000 &&
    JSON.stringify(aInitial.rules) === JSON.stringify(rubricBody.rules), "Teacher A rubric save mismatch");
  const bCopy = parse(Rubric, await teacherB.session.ok("PUT", rubricPath(pdfAssignment), {
    revision: 0, base_cents: 9000, rules: aInitial.rules.map(rule => ({ ...rule, reason: `${rule.reason}副本`, delta_cents: rule.delta_cents + 25 })),
  }), "Teacher B copied rubric");
  check(bCopy.user_id === teacherB.id && bCopy.revision === 1 && bCopy.base_cents === 9000 &&
    bCopy.rules.every((rule, index) => rule.id === aInitial.rules[index].id && rule.reason !== aInitial.rules[index].reason &&
      rule.delta_cents === aInitial.rules[index].delta_cents + 25), "Legacy shared item IDs must still support teacher-specific values without cross-teacher writes");
  function ownRubric(rows: RubricData[], userId: number) {
    const matches = rows.filter(row => row.user_id === userId);
    check(matches.length === 1, "Exactly one rubric per assignment and teacher is required");
    return matches[0];
  }
  let rubricRows = await rubrics(teacherA.session, pdfAssignment);
  check(rubricRows.length === 2 && JSON.stringify(ownRubric(rubricRows, teacherA.id)) === JSON.stringify(aInitial),
    "Teacher B copying must not alter teacher A's rubric");
  const aUpdated = parse(Rubric, await teacherA.session.ok("PUT", rubricPath(pdfAssignment), {
    revision: aInitial.revision, base_cents: 10000,
    rules: aInitial.rules.map(rule => ({ ...rule, reason: `${rule.reason}更新` })),
  }), "Teacher A updated rubric");
  rubricRows = await rubrics(teacherB.session, pdfAssignment);
  check(JSON.stringify(ownRubric(rubricRows, teacherB.id)) === JSON.stringify(bCopy), "Source update must not silently overwrite copied rubric");
  const source = ownRubric(rubricRows, teacherA.id);
  const synced = parse(Rubric, await teacherB.session.ok("PUT", rubricPath(pdfAssignment), {
    revision: bCopy.revision, base_cents: source.base_cents, rules: source.rules,
  }), "Explicit copied-rubric synchronization");
  check(synced.revision === bCopy.revision + 1 && synced.base_cents === aUpdated.base_cents &&
    JSON.stringify(synced.rules) === JSON.stringify(aUpdated.rules), "Explicit synchronization mismatch");
  await teacherA.session.rejected("PUT", rubricPath(pdfAssignment), rubricBody, [409], "Stale rubric revision");
  check(JSON.stringify(ownRubric(await rubrics(teacherA.session, pdfAssignment), teacherA.id)) === JSON.stringify(aUpdated),
    "Stale rubric write must not overwrite current rubric");
  const rubricRaceBodies = [8000, 8500].map(base_cents => ({ revision: synced.revision, base_cents, rules: synced.rules }));
  const rubricRace = await Promise.all(rubricRaceBodies.map(body => teacherB.session.request("PUT", rubricPath(pdfAssignment), body)));
  const rubricWinners = rubricRace.map((reply, index) => ({ reply, index })).filter(({ reply }) => reply.status >= 200 && reply.status < 300);
  check(rubricWinners.length === 1 && rubricRace.filter(reply => reply.status === 409).length === 1, "Concurrent rubric CAS must yield one success and one 409");
  const rubricWinner = parse(Rubric, rubricWinners[0].reply.data, "Rubric CAS winner");
  check(rubricWinner.revision === synced.revision + 1 && rubricWinner.base_cents === rubricRaceBodies[rubricWinners[0].index].base_cents,
    "Rubric CAS winner content mismatch");
  rubricRows = await rubrics(teacherA.session, pdfAssignment);
  check(JSON.stringify(ownRubric(rubricRows, teacherB.id)) === JSON.stringify(rubricWinner) &&
    JSON.stringify(ownRubric(rubricRows, teacherA.id)) === JSON.stringify(aUpdated), "Concurrent rubric writes must remain teacher-isolated");

  let document = await prepare(teacherA.session, pdfSubmission.id);
  emptyReview(document.review, "New PDF review must be empty");
  check(objectIdentity(document.url) === objectIdentity(document.original_url), "PDF original and preview must use the same S3 object");
  check(digest(await pdfBytes(document)) === digest(pdf) && digest(await downloaded(document.original_url)) === digest(pdf),
    "PDF original and preview bytes must be identical");
  const wordDocument = await prepare(teacherA.session, wordSubmission.id);
  const wordAgain = await prepare(teacherB.session, wordSubmission.id);
  check(wordDocument.version === wordAgain.version &&
    wordDocument.page_count === wordAgain.page_count && objectIdentity(wordDocument.url) === objectIdentity(wordAgain.url),
    "Repeated Word prepare must reuse one stable converted PDF");
  check(objectIdentity(wordDocument.url) !== objectIdentity(wordDocument.original_url), "Word preview must be a distinct PDF object");
  await pdfBytes(wordDocument);
  await pdfBytes(wordAgain);
  check(digest(await downloaded(wordDocument.original_url)) === digest(docx), "Word original must remain downloadable unchanged");
  emptyReview(wordDocument.review, "New Word review must be empty");

  const marks: MarkData[] = aUpdated.rules.map((rule, index) => ({
    ...rule, mark_id: crypto.randomUUID(), page: 1, x: 0.1, y: 0.1 + index * 0.2, width: 0.3, height: 0.1,
  }));
  const initialBody = { version: document.version, revision: 0, base_cents: 10000, marks };
  for (const unauthorized of [outsider.session, student.session]) {
    await unauthorized.rejected("GET", rubricsPath(pdfAssignment), undefined, [403], "Unauthorized rubric read");
    await unauthorized.rejected("PUT", rubricPath(pdfAssignment), rubricBody, [403], "Unauthorized rubric write");
    await unauthorized.rejected("POST", documentPath(pdfSubmission.id), {}, [403], "Unauthorized document prepare");
    await unauthorized.rejected("PUT", reviewPath(pdfSubmission.id), initialBody, [403], "Unauthorized review write");
    await unauthorized.rejected("GET", reportPath(pdfAssignment), undefined, [403], "Unauthorized report read");
  }
  const ungradedRows = await report(teacherA.session, pdfAssignment);
  check(ungradedRows.length === 3 && ungradedRows.every(row => row.score === null), "Ungraded report scores must be null");
  let saved = await save(teacherA.session, pdfSubmission.id, initialBody);
  check(saved.revision === 1 && saved.base_cents === 10000 && saved.score === 107.5 &&
    saved.updated_by === teacherA.id && saved.updated_at !== null && JSON.stringify(saved.marks) === JSON.stringify(marks),
    "10000 + 1000 - 250 cents must save as 107.5 with full review metadata");
  async function storedScore(submissionId: number, expected: number) {
    const submission = parse(Submission, await teacherA.session.ok("GET", `/submissions/${submissionId}/`), "Scored submission");
    check(submission.status === 1 && submission.score === expected, "Review must update canonical submission score and graded status");
  }
  await storedScore(pdfSubmission.id, 107.5);
  const zero = await save(teacherB.session, wordSubmission.id, { version: wordDocument.version, revision: 0, base_cents: 0, marks: [] });
  check(zero.revision === 1 && zero.score === 0 && zero.base_cents === 0 && zero.marks.length === 0 && zero.updated_by === teacherB.id,
    "Zero-point review must persist as a graded zero, not missing");
  await storedScore(wordSubmission.id, 0);
  sameReview((await prepare(teacherA.session, wordSubmission.id)).review, zero, "Zero-point review must reload unchanged");

  const validBody = reviewBody(document, saved);
  const invalidBodies: { label: string; body: unknown }[] = [
    { label: "Duplicate mark ID", body: { ...validBody, marks: [marks[0], { ...marks[1], mark_id: marks[0].mark_id }] } },
    { label: "Page beyond actual count", body: { ...validBody, marks: [{ ...marks[0], page: document.page_count + 1 }] } },
    { label: "Page zero", body: { ...validBody, marks: [{ ...marks[0], page: 0 }] } },
    { label: "Fractional page", body: { ...validBody, marks: [{ ...marks[0], page: 1.5 }] } },
    ...[
      { x: -0.01 }, { y: -0.01 }, { width: 0 }, { height: 0 },
      { x: 0.9, width: 0.2 }, { y: 0.95, height: 0.1 }, { width: -0.1 }, { height: -0.1 },
    ].map((position, index) => ({ label: `Invalid normalized position ${index + 1}`, body: { ...validBody, marks: [{ ...marks[0], ...position }] } })),
    { label: "Fractional cents", body: { ...validBody, base_cents: 0.5 } },
    { label: "Base cents limit", body: { ...validBody, base_cents: 1000001 } },
    { label: "Negative base cents limit", body: { ...validBody, base_cents: -1000001 } },
    { label: "Delta cents limit", body: { ...validBody, marks: [{ ...marks[0], delta_cents: 1000001 }] } },
    { label: "Negative delta cents limit", body: { ...validBody, marks: [{ ...marks[0], delta_cents: -1000001 }] } },
    { label: "Reason length limit", body: { ...validBody, marks: [{ ...marks[0], reason: "界".repeat(121) }] } },
    { label: "Mark count limit", body: { ...validBody, marks: Array.from({ length: 501 }, () => ({ ...marks[0], mark_id: crypto.randomUUID() })) } },
    { label: "Total cents limit", body: { ...validBody, base_cents: 1000000,
      marks: Array.from({ length: 100 }, () => ({ ...marks[0], mark_id: crypto.randomUUID(), delta_cents: 1000000 })) } },
  ];
  for (const invalid of invalidBodies) {
    await teacherA.session.rejected("PUT", reviewPath(pdfSubmission.id), invalid.body, [400, 422], invalid.label);
  }
  for (const token of ["1e999", "-1e999", "NaN", "Infinity"]) {
    const raw = JSON.stringify({ ...validBody, marks: [{ ...marks[0], x: "NONFINITE_POSITION" }] })
      .replace('"NONFINITE_POSITION"', token);
    await teacherA.session.rejected("PUT", reviewPath(pdfSubmission.id), undefined, [400, 422], "Non-finite position", raw);
  }
  await teacherA.session.rejected("PUT", rubricPath(pdfAssignment), {
    revision: aUpdated.revision, base_cents: 10000,
    rules: Array.from({ length: 201 }, () => ({ ...bonus, id: crypto.randomUUID() })),
  }, [400, 422], "Rubric rule count limit");
  sameReview((await prepare(teacherB.session, pdfSubmission.id)).review, saved, "Invalid review requests must not change persisted review");
  await teacherB.session.rejected("PUT", reviewPath(pdfSubmission.id), { ...initialBody, base_cents: 1 }, [409], "Stale review revision");
  await teacherA.session.rejected("POST", "/submissions/score_update/", { submission: pdfSubmission.id, score: 3 }, [409], "Legacy score write on reviewed submission");
  sameReview((await prepare(teacherA.session, pdfSubmission.id)).review, saved, "Stale and legacy score writes must not overwrite review");
  await storedScore(pdfSubmission.id, 107.5);

  const raceBodies = [11000, 12000].map(base_cents => ({ ...reviewBody(document, saved), base_cents }));
  const racers = [teacherA, teacherB];
  const race = await Promise.all(racers.map((person, index) => person.session.request("PUT", reviewPath(pdfSubmission.id), raceBodies[index])));
  const winners = race.map((reply, index) => ({ reply, index })).filter(({ reply }) => reply.status >= 200 && reply.status < 300);
  check(winners.length === 1 && race.filter(reply => reply.status === 409).length === 1, "Concurrent review CAS must yield exactly one success and one 409");
  const winner = parse(Review, winners[0].reply.data, "Review CAS winner");
  check(winner.revision === saved.revision + 1 && winner.base_cents === raceBodies[winners[0].index].base_cents &&
    winner.score === (winner.base_cents + 750) / 100 && winner.updated_by === racers[winners[0].index].id &&
    JSON.stringify(winner.marks) === JSON.stringify(marks), "Concurrent review CAS winner mismatch");
  sameReview((await prepare(teacherA.session, pdfSubmission.id)).review, winner, "Concurrent CAS losing write must not persist");
  await storedScore(pdfSubmission.id, winner.score!);
  saved = await save(teacherA.session, pdfSubmission.id, { ...reviewBody(document, winner), base_cents: 10000 });

  async function verifyBatch(expected: ReviewData) {
    // This single request must contain both grades and marks for the entire student roster.
    const rows = await report(teacherB.session, pdfAssignment);
    check(rows.length === 3 && new Set(rows.map(row => row.user_id)).size === 3 &&
      rows.every(row => [student.id, pending.id, missing.id].includes(row.user_id)), "Batch report must cover exactly all course students");
    const graded = rows.find(row => row.user_id === student.id);
    const ungraded = rows.find(row => row.user_id === pending.id);
    const absent = rows.find(row => row.user_id === missing.id);
    check(graded?.submission_id === pdfSubmission.id && graded.score === 107.5 && graded.review !== null,
      "Batch report must return the graded score and review together");
    sameReview(graded.review, expected, "Batch report marks and score must match the saved review");
    check(graded.grader_name === teacherA.username, "Report must resolve the grading teacher's display name");
    check(ungraded?.submission_id === pendingSubmission.id && ungraded.score === null && ungraded.review === null,
      "Submitted but ungraded student must have null report score and no review");
    check(absent?.submission_id === null && absent.score === null && absent.review === null,
      "Unsubmitted student must have null submission, score and review");
  }
  await verifyBatch(saved);
  const wordRows = await report(teacherA.session, wordAssignment);
  const wordRow = wordRows.find(row => row.user_id === student.id);
  check(wordRows.length === 3 && wordRow?.submission_id === wordSubmission.id && wordRow.score === 0 && wordRow.review !== null,
    "Batch report must distinguish graded zero from missing submission");
  sameReview(wordRow.review, zero, "Word batch report must preserve the zero review");

  const oldVersion = document.version;
  const oldBody = reviewBody(document, saved);
  const resubmitted = await uploadAndSubmit(student.session, pdfAssignment, pdf, "pdf");
  check(resubmitted.id === pdfSubmission.id && resubmitted.file !== pdfSubmission.file &&
    resubmitted.status === 0 && resubmitted.score === null,
    "Student resubmit must replace the original, reset status and keep the score hidden");
  const resetRows = await report(teacherA.session, pdfAssignment);
  const resetRow = resetRows.find(row => row.user_id === student.id);
  check(resetRow?.submission_id === pdfSubmission.id && resetRow.score === null && resetRow.review === null,
    "Resubmit must remove the previous review from the report");
  await teacherA.session.rejected("PUT", reviewPath(pdfSubmission.id), oldBody, [409], "Old version after resubmit before prepare");
  document = await prepare(teacherB.session, pdfSubmission.id);
  check(document.version !== oldVersion, "Resubmission must get a new version even when bytes match");
  emptyReview(document.review, "Resubmission must not inherit old marks or revision");
  await teacherA.session.rejected("PUT", reviewPath(pdfSubmission.id), { ...oldBody, revision: 0 }, [409], "Old version after replacement prepare");
  emptyReview((await prepare(teacherA.session, pdfSubmission.id)).review, "Old-version rejection must leave replacement review empty");
  saved = await save(teacherA.session, pdfSubmission.id, { version: document.version, revision: 0, base_cents: 10000, marks });
  check(saved.revision === 1 && saved.score === 107.5, "Replacement review must start at revision one and preserve cents calculation");
  await storedScore(pdfSubmission.id, 107.5);
  await verifyBatch(saved);

  check(await teacherA.session.ok("GET", reviewPath(pdfSubmission.id)) === true, "Existing review availability must survive format changes");
  check(await teacherA.session.ok("GET", reviewPath(pendingSubmission.id)) === false, "Unprepared submissions must not advertise a visual document");
  await teacherA.session.ok("PATCH", `/assignments/${pdfAssignment}/`, { allowed_extension: ".pdf,.zip" });
  sameReview((await prepare(teacherA.session, pdfSubmission.id)).review, saved, "Widening formats must preserve access to existing reviews");
  saved = await save(teacherA.session, pdfSubmission.id, reviewBody(document, saved));
  await teacherA.session.rejected("POST", documentPath(pendingSubmission.id), {}, [400], "Mixed-format assignments must not create new visual documents");
  await teacherA.session.ok("PATCH", `/assignments/${pdfAssignment}/`, { allowed_extension: ".pdf", score: 20000 });
  const largeBaseDocument = await prepare(admin, pendingSubmission.id);
  check(largeBaseDocument.review.base_cents === 2000000, "An old assignment's large score must not prevent reading its document");
  await teacherA.session.ok("PATCH", `/assignments/${pdfAssignment}/`, { score: 100 });

  const sharedRule = { id: crypto.randomUUID(), reason: "跨作业复用扣分项", delta_cents: -350 };
  await teacherB.session.ok("PUT", rubricPath(wordAssignment), {
    revision: 0, base_cents: 0, rules: [{ ...aUpdated.rules[0], id: crypto.randomUUID() }, sharedRule],
  });
  const libraryPath = `/assignments/${pdfAssignment}/grading/library`;
  const sharedLibrary = parse(z.array(z.object({ rule: Rule, teachers: z.array(z.string()) })),
    await teacherA.session.ok("GET", libraryPath), "Assignment rubric library");
  check(!sharedLibrary.some(item => item.rule.id === sharedRule.id), "Library must exclude other assignments, even in the same course");
  check(new Set(sharedLibrary.map(item => JSON.stringify([item.rule.reason.trim(), item.rule.delta_cents]))).size === sharedLibrary.length,
    "Assignment rubric library must deduplicate by points and reason");
  const sharedBonus = sharedLibrary.find(item => item.rule.reason === aUpdated.rules[0].reason && item.rule.delta_cents === aUpdated.rules[0].delta_cents);
  check(sharedBonus?.teachers.includes(teacherA.username) && sharedBonus.teachers.includes(teacherB.username), "Library must show every adopting teacher's display name");
  await outsider.session.rejected("GET", libraryPath, undefined, [403], "Unrelated teachers cannot read the assignment library");
  await student.session.rejected("GET", libraryPath, undefined, [403], "Students cannot read the teacher rubric library");

  await Promise.all([
    (async () => {
      for (let index = 0; index < 8; index++) {
        saved = await save(teacherA.session, pdfSubmission.id, { ...reviewBody(document, saved), base_cents: 10000 + index * 100 });
      }
    })(),
    (async () => {
      for (let index = 0; index < 24; index++) {
        const rows = await report(teacherB.session, pdfAssignment);
        const row = rows.find(row => row.submission_id === pdfSubmission.id);
        check(row?.review != null && row.score === row.review.score, "Report score and review must come from the same committed version");
      }
    })(),
  ]);
  saved = await save(teacherA.session, pdfSubmission.id, { ...reviewBody(document, saved), base_cents: 10000 });
  await verifyBatch(saved);

  const rubricBeforeFork = ownRubric(await rubrics(teacherA.session, pdfAssignment), teacherA.id);
  const otherBeforeFork = ownRubric(await rubrics(teacherB.session, pdfAssignment), teacherB.id);
  const originalDeduction = rubricBeforeFork.rules.find(rule => rule.delta_cents < 0)!;
  const forkedRubric = parse(Rubric, await teacherA.session.ok("PUT", rubricPath(pdfAssignment), {
    revision: rubricBeforeFork.revision, base_cents: rubricBeforeFork.base_cents,
    rules: rubricBeforeFork.rules.map(rule => rule.id === originalDeduction.id ? { ...rule, delta_cents: -500 } : rule),
  }), "Locally modified scoring item");
  const variants = parse(z.array(z.object({ rule: Rule, teachers: z.array(z.string()) })),
    await admin.ok("GET", libraryPath), "Independent score variants");
  const sameReason = variants.filter(item => item.rule.reason === originalDeduction.reason);
  check(sameReason.length === 2 && sameReason.some(item => item.rule.delta_cents === -500) &&
    sameReason.some(item => item.rule.delta_cents === originalDeduction.delta_cents), "Same reason with different points must remain distinct library entries");
  check(JSON.stringify(ownRubric(await rubrics(teacherB.session, pdfAssignment), teacherB.id)) === JSON.stringify(otherBeforeFork),
    "Editing a copied scoring item must not modify the other teacher's configuration");
  sameReview((await prepare(teacherA.session, pdfSubmission.id)).review, saved, "Editing a rubric must never rewrite previously applied marks or scores");
  const separateCopy = { ...originalDeduction, id: crypto.randomUUID() };
  const withBoth = parse(Rubric, await teacherA.session.ok("PUT", rubricPath(pdfAssignment), {
    revision: forkedRubric.revision, base_cents: forkedRubric.base_cents, rules: [...forkedRubric.rules, separateCopy],
  }), "Two independent local scoring variants");
  check(withBoth.rules.some(rule => rule.id === originalDeduction.id && rule.delta_cents === -500) &&
    withBoth.rules.some(rule => rule.id === separateCopy.id && rule.delta_cents === originalDeduction.delta_cents),
    "Independent copies with the same reason and different points must coexist for one teacher");
  sameReview((await prepare(teacherA.session, pdfSubmission.id)).review, saved, "Importing another scoring variant must preserve the saved review snapshot");

  const clearPath = `/submissions/${pdfSubmission.id}/grading/reset`;
  const clearStatePath = `${clearPath}?source_file_ident=${encodeURIComponent(resubmitted.file!)}`;
  const clearToken = z.object({ version: z.string() });
  const beforeClear = parse(clearToken, await teacherA.session.ok("GET", clearStatePath), "Clear token");
  for (const denied of [student, outsider]) {
    await denied.session.rejected("GET", clearStatePath, undefined, [403], "Only course staff may prepare clearing");
    await denied.session.rejected("DELETE", clearStatePath, beforeClear, [403], "Only course staff may clear grading");
  }
  await teacherA.session.rejected("GET", `${clearPath}?source_file_ident=${encodeURIComponent(pdfSubmission.file!)}`,
    undefined, [409], "A stale submission view cannot clear a replacement");
  saved = await save(teacherB.session, pdfSubmission.id, reviewBody(document, saved));
  await teacherA.session.rejected("DELETE", clearStatePath, beforeClear, [409], "Clearing must not remove a newer review");
  sameReview((await prepare(teacherA.session, pdfSubmission.id)).review, saved, "Rejected clear must retain the review");
  const currentClear = parse(clearToken, await teacherA.session.ok("GET", clearStatePath), "Current clear token");
  const bodyBeforeClear = reviewBody(document, saved);
  const documentBeforeClear = document;
  const rubricBeforeClear = await rubrics(teacherA.session, pdfAssignment);
  check((await teacherA.session.request("DELETE", clearStatePath, currentClear)).status === 204, "Clearing must succeed");
  const clearedRow = (await report(teacherA.session, pdfAssignment)).find(row => row.submission_id === pdfSubmission.id);
  check(clearedRow?.score === null && clearedRow.review === null && clearedRow.grader_name === null,
    "Cleared submission must be ungraded in reports");
  await teacherA.session.rejected("DELETE", clearStatePath, currentClear, [409], "A clear token cannot be replayed");
  await teacherA.session.rejected("PUT", reviewPath(pdfSubmission.id), bodyBeforeClear, [409], "A stale save cannot revive cleared grading");
  document = await prepare(teacherA.session, pdfSubmission.id);
  emptyReview(document.review, "Clearing must remove every annotation and score");
  check(document.version !== documentBeforeClear.version &&
    objectIdentity(document.url) === objectIdentity(documentBeforeClear.url) &&
    objectIdentity(document.original_url) === objectIdentity(documentBeforeClear.original_url),
    "Clearing must invalidate old saves while preserving the original and preview");
  check(JSON.stringify(await rubrics(teacherA.session, pdfAssignment)) === JSON.stringify(rubricBeforeClear),
    "Clearing must preserve both teachers' scoring libraries");
  saved = await save(teacherA.session, pdfSubmission.id, { ...reviewBody(document, document.review), base_cents: 10000, marks });
  check(saved.score === 107.5, "Fresh grading must work after clearing");
  await teacherB.session.rejected("PUT", reviewPath(pdfSubmission.id), bodyBeforeClear, [409],
    "Recreated revision one must not accept the previous document version");
  await verifyBatch(saved);

  const codeAssignment = await assignment("zip");
  const codeImage = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64"));
  const codeBytes = zipSync({ "main.py": new TextEncoder().encode("print(1)\n"), "screenshot.png": codeImage });
  const codeSubmission = await uploadAndSubmit(student.session, codeAssignment, codeBytes, "zip");
  const codePath = `/submissions/${codeSubmission.id}/grading/code`;
  const codeClearPath = `/submissions/${codeSubmission.id}/grading/reset`;
  const codeTokenPath = `${codeClearPath}?source_file_ident=${encodeURIComponent(codeSubmission.file)}`;
  const CodeReview = Review.extend({
    files: z.array(z.object({ path: z.string(), patch: z.string() })),
    marks: z.array(z.union([
      Rule.extend({ mark_id: z.string(), path: z.string(), from: integer, to: integer }),
      Mark.extend({ path: z.string(), image_sha256: z.string() }),
      Mark.extend({ path: z.string(), original_sha256: z.string(), pdf_sha256: z.string() }),
    ])),
  });
  const CodeSource = z.object({
    source_version: z.string(), source_sha256: z.string().nullable(),
    original_url: z.string(), original_name: z.string(), review: CodeReview,
  });
  let codeSource = parse(CodeSource, await teacherA.session.ok("GET", codePath), "New code source");
  const codeBody = {
    source_version: codeSource.source_version, source_sha256: digest(codeBytes), revision: codeSource.review.revision,
    base_cents: 10000,
    files: [{ path: "main.py", patch: "--- a/main.py\n+++ b/main.py\n@@ -1 +1 @@\n-print(1)\n+print(2)\n" }],
    marks: [{ ...deduction, mark_id: crypto.randomUUID(), path: "main.py", from: 0, to: 8 }],
  };
  const unsavedToken = parse(clearToken, await teacherA.session.ok("GET", codeTokenPath), "Unsaved code clear token");
  await teacherA.session.ok("DELETE", codeTokenPath, unsavedToken);
  await teacherA.session.rejected("PUT", codePath, codeBody, [409], "Clearing an unsaved review must invalidate revision zero");
  codeSource = parse(CodeSource, await teacherA.session.ok("GET", codePath), "Cleared unsaved code source");
  let codeSaved = parse(CodeReview, await teacherA.session.ok("PUT", codePath,
    { ...codeBody, revision: codeSource.review.revision }), "First code grading after clear");
  check(codeSaved.score === 97.5 && codeSaved.revision > codeBody.revision, "Fresh code grading must calculate its score");
  const codeBeforeChange = parse(clearToken, await teacherA.session.ok("GET", codeTokenPath), "Code clear token before concurrent save");
  codeSaved = parse(CodeReview, await teacherB.session.ok("PUT", codePath,
    { ...codeBody, revision: codeSaved.revision }), "Another teacher's code save");
  await teacherA.session.rejected("DELETE", codeTokenPath, codeBeforeChange, [409], "Code clear must retain a newer teacher's review");
  const codeBeforeClear = { ...codeBody, revision: codeSaved.revision };
  const codeCurrentToken = parse(clearToken, await teacherA.session.ok("GET", codeTokenPath), "Current code clear token");
  await teacherA.session.ok("DELETE", codeTokenPath, codeCurrentToken);
  await teacherA.session.rejected("PUT", codePath, codeBeforeClear, [409], "Old code edits cannot return after clearing");
  await teacherA.session.rejected("DELETE", codeTokenPath, codeCurrentToken, [409], "Code clear tokens cannot be replayed");
  codeSource = parse(CodeSource, await teacherA.session.ok("GET", codePath), "Cleared graded code source");
  check(codeSource.source_sha256 === null && codeSource.review.score === null &&
    codeSource.review.revision > codeSaved.revision && codeSource.review.files.length === 0 &&
    codeSource.review.marks.length === 0 && codeSource.review.updated_by === null && codeSource.review.updated_at === null,
    "Cleared code must retain only its increasing revision, not grading contents or attribution");
  const codeRows = parse(z.array(ExportRow.extend({ code_review: CodeReview.nullable() })),
    await teacherA.session.ok("GET", reportPath(codeAssignment)), "Cleared code report");
  const codeRow = codeRows.find(row => row.submission_id === codeSubmission.id);
  check(codeRow?.score === null && codeRow.code_review === null && codeRow.grader_name === null,
    "Reports must not expose an empty revision tombstone as grading");
  check(digest(await downloaded(codeSource.original_url)) === digest(codeBytes), "Clearing must not change the original ZIP");
  codeSaved = parse(CodeReview, await teacherA.session.ok("PUT", codePath,
    { ...codeBody, revision: codeSource.review.revision }), "Recreated code review");
  check(codeSaved.score === 97.5, "Code grading must be saveable again after clear");
  await teacherB.session.rejected("PUT", codePath, codeBeforeClear, [409], "Recreated code grading must still reject old revisions");

  const imageMark = {
    ...deduction, mark_id: crypto.randomUUID(), path: "screenshot.png",
    image_sha256: digest(codeImage), page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.1,
  };
  const imageBody = { ...codeBody, revision: codeSaved.revision, marks: [...codeBody.marks, imageMark] };
  for (const denied of [student.session, outsider.session]) {
    await denied.rejected("PUT", codePath, imageBody, [403], "Only course staff may save image grading");
  }
  for (const invalid of [
    { ...imageMark, image_sha256: "invalid" },
    { ...imageMark, page: 0 },
    { ...imageMark, page: 501 },
    { ...imageMark, x: 0.9, width: 0.3 },
    { ...imageMark, height: 0 },
  ]) {
    await teacherA.session.rejected("PUT", codePath, { ...imageBody, marks: [invalid] }, [400, 422],
      "Invalid image hashes, page indexes and coordinates must be rejected");
  }
  codeSaved = parse(CodeReview, await teacherA.session.ok("PUT", codePath, imageBody), "Image and code grading");
  check(codeSaved.score === 95 && isDeepStrictEqual(codeSaved.marks, imageBody.marks),
    "Image and code marks must both contribute to the score and retain coordinates and source hash");
  const imageReopened = parse(CodeSource, await teacherA.session.ok("GET", codePath), "Reopened image grading");
  check(isDeepStrictEqual(imageReopened.review, codeSaved),
    "Saved image grading must survive reopening without changing marks");
  await teacherB.session.rejected("PUT", codePath, imageBody, [409], "Stale image review must not overwrite saved grading");
  await student.session.rejected("GET", codePath, undefined, [403], "Students must not read image grading details");
  check(digest(await downloaded(imageReopened.original_url)) === digest(codeBytes),
    "Image annotations must not replace the student's original ZIP");

  const archiveAssignment = await assignment("zip");
  const archiveBytes = zipSync({ "main.py": new TextEncoder().encode("print(1)\n"), "report.docx": docx });
  const missingName = crypto.randomUUID();
  const archiveSubmission = await uploadAndSubmit(student.session, archiveAssignment, archiveBytes, "zip", missingName);
  const archivePath = `/submissions/${archiveSubmission.id}/grading/code`;
  await teacherA.session.rejected("GET", archivePath, undefined, [400],
    "Missing filename extensions need metadata repair, not assignment-based guessing");
  const namedSubmission = await uploadAndSubmit(student.session, archiveAssignment, archiveBytes, "zip", "实验报告.ZIP");
  check(namedSubmission.id === archiveSubmission.id, "Resubmission must retain its submission identity");
  const archiveSource = parse(CodeSource, await teacherA.session.ok("GET", archivePath), "Named ZIP source");
  check(archiveSource.original_name === "实验报告.ZIP", "New uploads must preserve the original filename");
  const archiveDocumentPath = `/submissions/${archiveSubmission.id}/grading/code/document`;
  const archivePreviewQuery = `?source_version=${archiveSource.source_version}&original_sha256=${digest(docx)}`;
  check(await teacherA.session.ok("GET", archiveDocumentPath + archivePreviewQuery) === null,
    "ZIP member preview lookup must return a cache miss before conversion");
  const archivePreviewReply = await teacherA.session.request("POST",
    `${archiveDocumentPath}?source_version=${archiveSource.source_version}&extension=docx`, undefined, docx);
  check(archivePreviewReply.status === 200, "Named ZIP Word preview must pass source authorization");
  const ArchivePreview = z.object({ original_sha256: z.string(), sha256: z.string(), page_count: integer.positive(), url: z.string() });
  const archivePreview = parse(ArchivePreview, archivePreviewReply.data, "ZIP Word preview");
  const archivePreviewAgain = parse(ArchivePreview,
    await teacherA.session.ok("GET", archiveDocumentPath + archivePreviewQuery), "Reused ZIP preview");
  check(archivePreview.original_sha256 === digest(docx) && archivePreview.sha256 === archivePreviewAgain.sha256 &&
    objectIdentity(archivePreview.url) === objectIdentity(archivePreviewAgain.url),
    "ZIP member previews must remain reusable without changing the original");
  check(new TextDecoder().decode((await downloaded(archivePreview.url)).subarray(0, 5)) === "%PDF-",
    "ZIP Word preview must download as a real PDF");
  await teacherA.session.ok("PATCH", `/assignments/${codeAssignment}/`, { allowed_extension: ".zip,.pdf" });
  const explicitSource = parse(CodeSource, await teacherA.session.ok("GET", codePath), "Explicit ZIP under mixed settings");
  check(explicitSource.review.score === codeSaved.score, "Real ZIP filenames must remain gradable under mixed settings");

  // No passwords, cookies, source paths, signed URLs, or administrative identity leave the process.
  const identity = (person: { id: number; username: string }) => ({ id: person.id, username: person.username });
  await writeFile(manifestPath, JSON.stringify({
    prefix, course_id: course.id,
    users: {
      teacher_a: identity(teacherA), teacher_b: identity(teacherB), unrelated_teacher: identity(outsider),
      student: identity(student), pending_student: identity(pending), missing_student: identity(missing),
    },
    assignments: { pdf: pdfAssignment, docx: wordAssignment, zip: codeAssignment, archive: archiveAssignment },
    submissions: { pdf: pdfSubmission.id, docx: wordSubmission.id, pending_pdf: pendingSubmission.id, zip: codeSubmission.id, archive: archiveSubmission.id },
    documents: { pdf_version: document.version, docx_version: wordDocument.version },
  }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ checks }));
}

try {
  await main();
} catch (error) {
  // Network/S3/JSON errors may contain credentials or presigned URLs. Never print them.
  throw new ProbeFailure(error instanceof ProbeFailure ? error.message : "Grading probe failed due to an unexpected runtime error; sensitive details suppressed");
}
