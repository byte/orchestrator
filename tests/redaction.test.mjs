import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  collectLearningExamples,
  exportLearningExamples,
  validateLearningExample
} from "../plugins/orchestrator/scripts/lib/learning.mjs";
import {
  addCheckpoint,
  claimTask,
  createRun,
  recordTaskResult,
  replacePlan,
  verifyTask
} from "../plugins/orchestrator/scripts/lib/runs.mjs";
import {
  REDACTION_VERSION,
  SUPPORTED_REDACTION_VERSIONS,
  redactText,
  redactTextFields
} from "../plugins/orchestrator/scripts/lib/redaction.mjs";
import { cleanup, makeRepo, runCli } from "./helpers.mjs";

test("redaction removes common secrets without retaining matched values", () => {
  const secret = "sk-1234567890abcdefghijklmnop";
  const github = "ghp_1234567890abcdefghijklmnopqrst";
  const privateKey = "-----BEGIN PRIVATE KEY-----\nsecretmaterial\n-----END PRIVATE KEY-----";
  const result = redactText(
    `OpenAI ${secret}; GitHub ${github}; password=hunterhunter; ${privateKey}`
  );
  assert.equal(REDACTION_VERSION, 4);
  assert.deepEqual(SUPPORTED_REDACTION_VERSIONS, [1, 2, 3, 4]);
  assert.doesNotMatch(result.text, /1234567890abcdefghijklmnop/);
  assert.doesNotMatch(result.text, /hunterhunter|secretmaterial/);
  assert.match(result.text, /<redacted:openai_key>/);
  assert.match(result.text, /<redacted:github_token>/);
  assert.match(result.text, /password=<redacted:credential>/);
  assert.match(result.text, /<redacted:private_key>/);
  assert.deepEqual(result.findings, {
    private_key: 1,
    openai_key: 1,
    github_token: 1,
    credential: 1
  });
});

test("redaction consumes quoted credential keys and complete escaped values", () => {
  const result = redactText([
    '{"password":"canary_0123456789","api_key":"canary_9876543210"}',
    '"secret": "punctuation ! and \\"escaped\\" tail"',
    "'access_token': 'short'",
    "password='it''s a YAML secret!'",
    '"aws_secret_access_key": "canary with punctuation!"',
    'ordinary_key="keep this"'
  ].join("\n"));
  assert.doesNotMatch(result.text, /canary|punctuation|escaped|tail|short|YAML/);
  assert.match(result.text, /ordinary_key="keep this"/);
  assert.equal(result.findings.credential, 6);
});

test("redaction removes PII and absolute home paths", () => {
  const result = redactText(
    "Contact alice@example.com at +60 12-345 6789; inspect /Users/alice/work/private/file.js " +
      "or C:\\Users\\alice\\private\\file.js."
  );
  assert.doesNotMatch(result.text, /alice@example\.com|12-345|Users[\\/]alice/);
  assert.match(result.text, /<redacted:email>/);
  assert.match(result.text, /<redacted:phone>/);
  assert.equal(result.findings.home_path, 1);
  assert.equal(result.findings.windows_home_path, 1);
});

test("redaction covers authorization, service tokens, network data, and other paths", () => {
  const text = [
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "xoxb-123456789012-abcdefghijkl",
    "sk_live_1234567890abcdefghijkl",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123456",
    "https://alice:password@example.com/path?token=secretvalue",
    "postgres://dbuser:dbpassword@db.example.com/app",
    "aws_secret_access_key=AbCdEfGhIjKlMnOpQrStUvWxYz1234567890ABCD",
    "AIza1234567890abcdefghijklmnopqrst",
    "SSN 123-45-6789 from 192.168.10.5",
    "IPv6 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
    "/private/tmp/customer/file.txt",
    "/root/.ssh/id_rsa and /Users/Alice Smith/private/file.js",
    "\\\\server\\private$\\customer\\file.txt"
  ].join("\n");
  const result = redactText(text);
  assert.doesNotMatch(result.text,
    /abcdefghijklmnopqrstuvwxyz|xoxb-|sk_live_|eyJhbGci|alice:password|dbpassword|secretvalue|AbCdEfGh|AIza|123-45-6789|192\.168|2001:0db8|Alice Smith|id_rsa|customer[\\/]file/);
  for (const type of [
    "authorization",
    "slack_token",
    "stripe_key",
    "jwt",
    "url_credentials",
    "database_url_credentials",
    "aws_secret_key",
    "google_api_key",
    "sensitive_query",
    "ssn",
    "ipv4",
    "ipv6",
    "absolute_path",
    "unc_path"
  ]) {
    const expected = type === "absolute_path" ? 2 : 1;
    assert.equal(result.findings[type], expected, `expected ${expected} ${type} finding(s)`);
  }
});

test("IPv4 redaction rejects impossible addresses and stays privacy-first for ambiguous versions", () => {
  const result = redactText(
    "invalid 999.1.2.3; endpoint 192.168.10.5; release version 10.1.2.3"
  );
  assert.match(result.text, /999\.1\.2\.3/);
  assert.doesNotMatch(result.text, /192\.168\.10\.5|10\.1\.2\.3/);
  assert.equal(result.findings.ipv4, 2);
});

test("field redaction only copies explicitly selected fields", () => {
  const result = redactTextFields({
    objective: "Email owner@example.com",
    workerOutput: "never copy me",
    routingReason: "bounded task"
  }, ["objective", "routingReason"]);
  assert.deepEqual(Object.keys(result.text), ["objective", "routingReason"]);
  assert.equal(result.text.workerOutput, undefined);
  assert.match(result.text.objective, /<redacted:email>/);
  assert.equal(result.findings.email, 1);
});

test("redaction rejects invalid containers and field names", () => {
  assert.throws(() => redactTextFields([], []), /source must be an object/);
  assert.throws(() => redactTextFields({}, "objective"), /fields must be an array/);
  assert.throws(() => redactTextFields({}, [""]), /non-empty strings/);
});

test("credential assignments are consumed before nested rules destroy their boundaries", () => {
  for (const value of [
    'password="SENSITIVEprefix?token=abcdefghijk"',
    "password='SENSITIVEprefix?token=abcdefghijk'",
    'password="SENSITIVEprefix https://user:pass@example.com/ SENSITIVEtail"',
    'password="SENSITIVEprefix Bearer abcdefghijklmnop SENSITIVEtail"',
    'password="SENSITIVEprefix sk-abcdefghijklmnopqrst SENSITIVEtail"',
    'password="SENSITIVEprefix aws_secret_access_key=abcdefgh! SensitiveTail"',
    'password="SENSITIVEprefix\nsecret: |\n  SensitiveTail\n  end"',
    "password=abcdefgh!SensitiveTail",
    "password=abcdefgh!{SensitiveTail}[]<>!",
    "api_key=short!",
    "secret=abcdefgh!@#$%^&*()+=:;,SensitiveTail"
  ]) {
    const result = redactText(`${value}\nordinary_key="keep this"`);
    const key = value.split("=")[0];
    assert.equal(result.text, `${key}=<redacted:credential>\nordinary_key="keep this"`);
    assert.deepEqual(result.findings, { credential: 1 });
  }
  for (const key of ["password", "passwd", "access_token", "auth-token", "aws_secret_access_key"]) {
    for (const value of ["abcdefghijk", "prefix'SensitiveQueryTail", "'SensitiveQueryStart", "prefix!secret='inner'SensitiveQueryNested"]) {
      assert.equal(
        redactText(`https://example.com/?${key}=${value}&view=public#section`).text,
        `https://example.com/?${key}=<redacted:sensitive_query>&view=public#section`
      );
    }
  }
  assert.equal(redactText('"password":\n  "SensitiveValue", "ordinary": "keep"').text,
    '"password=<redacted:credential>, "ordinary": "keep"');
  assert.equal(redactText("password:\nordinary: keep").text, "password:\nordinary: keep");
});

test("YAML credential block scalars consume their indented body but not sibling text", () => {
  for (const indicator of ["|", ">", "|-", ">+", "|2-", ">-2"]) {
    for (const [prefix, bodyIndent] of [["", "  "], ["  ", "    "], ["- ", "    "]]) {
      const result = redactText([
        `${prefix}"password": ${indicator} # block credential`,
        `${bodyIndent}SensitiveBlock?token=abcdefghijk`,
        "",
        `${bodyIndent}  SensitiveContinuation!`,
        "ordinary: keep",
        "description: |",
        "  ordinary multiline text"
      ].join("\r\n"));
      assert.doesNotMatch(result.text, /Sensitive|abcdefghijk/);
      assert.match(result.text, /ordinary: keep\r\ndescription: \|\r\n  ordinary multiline text$/);
      assert.deepEqual(result.findings, { credential: 1 });
    }
  }
  const nested = redactText('password: |\n  secret="SensitiveBlock\npassword="SensitiveSibling"\nordinary: keep');
  assert.doesNotMatch(nested.text, /Sensitive/);
  assert.match(nested.text, /ordinary: keep$/);
  assert.equal(nested.findings.credential, 2);
});

test("consented learning export redacts complete credentials through public runtime APIs", () => {
  const root = makeRepo();
  try {
    assert.equal(runCli(root, ["init"]).code, 0);
    const objective = [
      'password="SENSITIVEprefix?token=abcdefghijk"',
      "password=abcdefgh!SensitiveTail",
      "api_key: |-",
      "  SensitiveBlock",
      "  SensitiveContinuation",
      "Inspect https://example.com/?token=prefix'SensitiveQueryTail&view=public",
      "Inspect https://example.com/?token='SensitiveQueryStart&view=public",
      "Inspect https://example.com/?token=prefix!secret='inner'SensitiveQueryNested&view=public",
      "ordinary: keep"
    ].join("\n");
    createRun(root, {
      id: "privacy", lane: "privacy", objective, workerModel: "sol", reasoningEffort: "high"
    });
    replacePlan(root, "privacy", [{
      id: "review", title: "Review privacy", objective, kind: "read"
    }]);
    addCheckpoint(root, "privacy", { summary: "Ready for review" });
    const dispatch = claimTask(root, "privacy", "review", { constraints: [] });
    recordTaskResult(root, "privacy", "review", {
      attemptId: dispatch.attemptId,
      resultText: JSON.stringify({
        summary: "Reviewed", files_touched: [], tests: [], decisions: [],
        assumptions: [], blockers: [], confidence: "high"
      })
    });
    verifyTask(root, "privacy", "review", { verdict: "pass", evidence: ["Reviewed"] });
    assert.equal(collectLearningExamples(root).created, 1);
    const exported = exportLearningExamples(root, {
      name: "privacy-regression",
      includeTextFields: ["runObjective", "taskObjective"],
      consentProvenance: "user",
      acknowledgeSensitiveExport: true
    });
    const bytes = fs.readFileSync(exported.examplesFile, "utf8");
    assert.doesNotMatch(bytes, /SENSITIVEprefix|SensitiveTail|SensitiveBlock|SensitiveContinuation|SensitiveQuery|abcdefghijk/);
    const record = JSON.parse(bytes.trim());
    assert.equal(record.consent.mode, "explicit_text_export");
    assert.equal(record.redaction.version, REDACTION_VERSION);
    assert.equal(exported.manifest.redactionVersion, REDACTION_VERSION);
    for (const version of SUPPORTED_REDACTION_VERSIONS) {
      assert.doesNotThrow(() => validateLearningExample({
        ...record.example, redaction: { ...record.example.redaction, version }
      }));
    }
    for (const field of ["runObjective", "taskObjective"]) {
      assert.match(record.text[field], /ordinary: keep/);
      assert.match(record.text[field], /<redacted:credential>/);
    }
    assert.equal(record.redaction.findings.credential, 8);
    assert.equal(record.redaction.findings.sensitive_query, 6);
  } finally {
    cleanup(root);
  }
});
