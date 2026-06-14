import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitIndex = trimmed.indexOf("=");
    if (splitIndex <= 0) continue;
    const key = trimmed.slice(0, splitIndex).trim();
    let value = trimmed.slice(splitIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));

const { route } = await import("./ai-workflow-server.mjs");
const port = Number(process.env.AI_WORKFLOW_PORT || 8787);

createServer(route).listen(port, "127.0.0.1", () => {
  console.log(`Local workflow service: http://127.0.0.1:${port}`);
  console.log(`Provider: ${process.env.OPENAI_PROVIDER_LABEL || "configured provider"}`);
  console.log(`API key: ${process.env.OPENAI_API_KEY ? "configured" : "missing"}`);
});
