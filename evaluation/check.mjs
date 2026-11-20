// Trusted grader. Candidate modules run only in child processes inside the
// executeCheck sandbox, never in the host CLI or this assertion process.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "cases.json"), "utf8"));
const fixture = manifest.cases.find((entry) => entry.id === process.argv[2]);
assert.ok(fixture, "known trusted case");
const read = (file) => fs.readFileSync(path.resolve(file), "utf8");

async function verifySandbox(port) {
  const marker = `.orch-evaluation-${randomUUID()}`;
  function writable(directory) {
    const file = path.join(directory, marker);
    try { fs.writeFileSync(file, "", { flag: "wx" }); }
    catch (error) {
      if (["EPERM", "EACCES", "EROFS"].includes(error.code)) return false;
      throw error;
    }
    fs.unlinkSync(file);
    return true;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      process.env.CODEX_SANDBOX_NETWORK_DISABLED !== "1" ||
      !writable(process.env.TMPDIR) || writable(process.cwd()) || writable(path.dirname(process.env.TMPDIR))) {
    return false;
  }
  return new Promise((resolve) => {
    // The host is listening on this port. A refused connection also covers
    // Linux sandboxes with an isolated network namespace.
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (isolated) => { socket.destroy(); resolve(isolated); };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish(["EPERM", "EACCES", "ECONNREFUSED", "ENETUNREACH"].includes(error.code)));
    socket.setTimeout(1000, () => finish(false));
  });
}

// The parent checks exact output, rather than allowing process.exit(0) in a
// candidate import to skip assertions. No candidate-controlled test scripts.
function probe(program) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    cwd: process.cwd(), encoding: "utf8", timeout: 2000, maxBuffer: 8192,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: process.env.TMPDIR }
  });
  assert.equal(result.error, undefined, "probe must finish within bounds");
  assert.equal(result.status, 0, "candidate probe must exit successfully");
  return JSON.parse(result.stdout);
}

function grade() {
  switch (fixture.id) {
    case "localized-bug":
      assert.deepEqual(probe(`import { clamp } from './clamp.mjs'; console.log(JSON.stringify([[0,-10,10],[-20,-10,10],[20,-10,10],[4,-10,10],[-4,-10,10],[0,2,9],[7,7,7]].map(x=>clamp(...x))));`), [0, -10, 10, 4, -4, 2, 7]);
      break;
    case "independent-parts":
      assert.deepEqual(probe(`import { slug } from './slug.mjs'; import { initials } from './initials.mjs'; console.log(JSON.stringify({slugs:[' Hello, WORLD!! ','a___b---c','','***','X9'].map(slug),initials:[' Ada   Lovelace ','grace brewster hopper','','one','  '].map(initials)}));`), {
        slugs: ["hello-world", "a-b-c", "", "", "x9"], initials: ["AL", "GB", "", "O", ""]
      });
      break;
    case "interface-dependent":
      assert.deepEqual(probe(`import { parsePrice } from './price.mjs'; import { receipt } from './receipt.mjs'; const invalid=['1x','1.2','-1.00',' 1','1.000','',1,null,undefined,{},[],true]; console.log(JSON.stringify({parsed:['0','12.34','001.09'].map(parsePrice),total:receipt(['12.34','0.66','2']),empty:receipt([]),rejected:invalid.map(x=>{try {parsePrice(x);return false;} catch(e){return e instanceof TypeError;}})}));`), {
        parsed: [{ cents: 0, currency: "USD" }, { cents: 1234, currency: "USD" }, { cents: 109, currency: "USD" }],
        total: "$15.00", empty: "$0.00", rejected: Array(12).fill(true)
      });
      break;
    case "offline-dependency":
      for (const [file, contents] of Object.entries(fixture.files)) assert.equal(read(file), contents, `preserve ${file}`);
      for (const name of ["package.json", "index.mjs"]) {
        assert.equal(read(`node_modules/@fixture/words/${name}`), fixture.files[`vendor/words/${name}`], `installed ${name}`);
      }
      assert.deepEqual(probe(`import { greet } from './app.mjs'; console.log(JSON.stringify(['Ada','world',''].map(greet)));`), ["HELLO ADA", "HELLO WORLD", "HELLO "]);
      break;
    case "dirty-review": {
      for (const [file, contents] of Object.entries(fixture.dirty)) assert.equal(read(file), contents, `review must preserve ${file}`);
      const findings = JSON.parse(read("findings.json"));
      assert.equal(findings.length, 2, "both dirty and untracked defects");
      assert.deepEqual(findings.map((item) => item.path).sort(), ["discount.mjs", "pricing.mjs"]);
      for (const finding of findings) {
        assert.equal(finding.line, 1);
        assert.ok(Array.isArray(finding.input) && finding.input.length === 2);
        const [a, b] = finding.input;
        assert.ok([a, b, finding.expected].every(Number.isFinite));
        assert.ok(a >= 0 && a <= 10000 && b >= 0);
        const pricing = finding.path === "pricing.mjs";
        assert.ok(pricing ? Number.isInteger(b) && b <= 1000 : b <= 100);
        const expected = pricing ? a * b : a * (1 - b / 100);
        assert.equal(finding.expected, expected, "independently computed expected result");
        const actual = probe(`import { ${pricing ? "total" : "discounted"} as fn } from './${finding.path}'; console.log(JSON.stringify(fn(...${JSON.stringify(finding.input)})));`);
        assert.notEqual(actual, expected, "counterexample must expose a real defect");
      }
      break;
    }
    case "interrupted-integration": {
      const states = [];
      for (const phase of ["interrupted", "conflict"]) for (const applied of [false, true]) for (const completed of [[], ["part-a"]]) states.push({ phase, applied, completed });
      const expected = states.map((state) => ({
        action: state.phase === "conflict" ? "request-resolution" : state.completed.length ? "noop" : state.applied ? "record" : "retry",
        integrated: state.completed.length || state.phase === "conflict" || !state.applied ? state.completed : ["part-a"]
      }));
      assert.deepEqual(probe(`import { recover } from './recover.mjs'; const states=${JSON.stringify(states)}; const before=JSON.stringify(states); const results=states.map(recover); console.log(JSON.stringify({results,unchanged:before===JSON.stringify(states),again:recover({phase:'interrupted',applied:true,completed:['part-a']})}));`), {
        results: expected, unchanged: true, again: { action: "noop", integrated: ["part-a"] }
      });
      break;
    }
    default: throw new Error("No trusted grader");
  }
}

const sandboxVerified = await verifySandbox(Number(process.argv[3])).catch(() => false);
if (!sandboxVerified) {
  console.log(JSON.stringify({ caseId: fixture.id, sandboxVerified, reason: "Could not verify read-only filesystem and disabled network. Candidate was not executed." }));
  process.exitCode = 2;
} else {
  try {
    grade();
    console.log(JSON.stringify({ caseId: fixture.id, sandboxVerified, passed: true }));
  } catch {
    // Do not echo arbitrary candidate output, paths, secrets, or huge assertions.
    console.log(JSON.stringify({ caseId: fixture.id, sandboxVerified, passed: false, reason: "Observable checks failed (including missing files, invalid witnesses, or bounded probe failure)." }));
    process.exitCode = 1;
  }
}
