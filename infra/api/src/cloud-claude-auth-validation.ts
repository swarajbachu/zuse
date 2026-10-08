/** Shared by the authority's configure and explicit verification scripts. */
export const CLAUDE_AUTH_VALIDATION_SOURCE = String.raw`
const normalizeClaudeSetupToken = (secret) => secret.replace(/\s/gu, "");
const verifyClaudeCredential = async (credential) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { spawn } = await import("node:child_process");
  const directory = await mkdtemp("/tmp/zuse-claude-verification-");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: directory };
  // A different ambient credential must never make the submitted token pass.
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete env[key];
  env[credential.method === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = credential.secret;
  if (credential.baseUrl) env.ANTHROPIC_BASE_URL = credential.baseUrl;
  try {
    return await new Promise((resolve) => {
      const child = spawn("claude", ["-p", "Reply only OK.", "--max-turns", "1", "--tools", "", "--output-format", "json", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", ""], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      }, 30000);
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); resolve(result); };
      child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1048576); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-65536); });
      child.once("error", (error) => finish({ code: 127, error: error.code === "ENOENT" ? "missing-tool" : "verification-failed" }));
      child.once("close", (code) => {
        if (timedOut) return finish({ code: 1, error: "verification-timeout" });
        let result;
        try { result = JSON.parse(stdout); } catch {}
        if (code === 0 && result?.type === "result" && result.subtype === "success" && result.is_error === false && typeof result.result === "string" && result.result.trim().length > 0) return finish({ code: 0 });
        const text = stdout + stderr;
        const authenticationFailed = /authentication_error|authentication_failed|Failed to authenticate|OAuth (?:access token|session|token).*?(?:invalid|expired)|401/iu.test(text);
        finish({ code: code || 1, error: authenticationFailed ? "authentication-required" : "verification-failed" });
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
`;
