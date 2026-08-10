import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REDACTION_VERSION,
  SUPPORTED_REDACTION_VERSIONS,
  redactText,
  redactTextFields
} from "../plugins/orchestrator/scripts/lib/redaction.mjs";

test("redaction removes common secrets without retaining matched values", () => {
  const secret = "sk-1234567890abcdefghijklmnop";
  const github = "ghp_1234567890abcdefghijklmnopqrst";
  const privateKey = "-----BEGIN PRIVATE KEY-----\nsecretmaterial\n-----END PRIVATE KEY-----";
  const result = redactText(
    `OpenAI ${secret}; GitHub ${github}; password=hunterhunter; ${privateKey}`
  );
  assert.equal(REDACTION_VERSION, 2);
  assert.deepEqual(SUPPORTED_REDACTION_VERSIONS, [1, 2]);
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
