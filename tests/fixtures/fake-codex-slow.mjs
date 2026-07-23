process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(`${JSON.stringify({
    type: "thread.started",
    thread_id: "thread-slow"
  })}\n`);
});

process.on("SIGTERM", () => {
  process.exit(143);
});

setTimeout(() => {
  process.exit(1);
}, 10000);
