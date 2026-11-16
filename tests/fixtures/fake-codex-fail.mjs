import "./sandbox-shim.mjs";
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(`${JSON.stringify({
    type: "thread.started",
    thread_id: "thread-failed"
  })}\n`);
  process.stderr.write("simulated worker failure\n");
  process.exitCode = 2;
});
