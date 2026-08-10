process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(`${JSON.stringify({
    type: "thread.started",
    thread_id: "thread-no-result"
  })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "turn.completed" })}\n`);
});
