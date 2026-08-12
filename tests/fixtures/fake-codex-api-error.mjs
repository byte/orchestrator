// Reproduces an API-level rejection: Codex reports the failure as a JSON event
// on stdout, writes nothing to stderr, and exits non-zero.
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(`${JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "invalid_json_schema",
      message: "Invalid schema for response_format 'codex_output_schema'."
    }
  })}\n`);
  process.exitCode = 1;
});
