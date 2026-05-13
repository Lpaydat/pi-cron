#!/usr/bin/env node

/**
 * pi-cron runner — standalone script invoked by crontab.
 *
 * Usage:
 *   node runner.mjs <job-id>           Run a specific job
 *   node runner.mjs --list             Show all configured jobs
 *   node runner.mjs --test <job-id>    Dry-run: show what would be executed
 */

import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── Paths ────────────────────────────────────────────────────────────
const HOME = homedir();
const CONFIG_PATH = join(HOME, ".pi", "agent", "pi-cron.json");
const LOGS_DIR = join(HOME, ".pi", "agent", "pi-cron-logs");

// ── Helpers ──────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function resolvePiPath(config) {
  // Priority: saved config → env → PATH lookup → common locations
  if (config.piPath && existsSync(config.piPath)) return config.piPath;
  if (process.env.PI_BIN) return process.env.PI_BIN;

  // Common pnpm / binary locations
  const candidates = [
    join(HOME, ".local/share/pnpm/pi"),
    join(HOME, ".local/bin/pi"),
    "/usr/local/bin/pi",
    "/usr/bin/pi",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return "pi"; // last resort — relies on PATH being set correctly
}

function replacePlaceholders(str) {
  const now = new Date();
  return str
    .replace(/\{date\}/g, now.toISOString().split("T")[0])
    .replace(
      /\{timestamp\}/g,
      now.toISOString().replace(/[:.]/g, "-")
    );
}

// ── Webhook delivery ─────────────────────────────────────────────────

async function sendWebhook(url, payload) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    log(`Webhook responded: ${response.status}`);
    return response.ok;
  } catch (e) {
    log(`Webhook failed: ${e.message}`);
    return false;
  }
}

// ── Job execution ────────────────────────────────────────────────────

function runJob(job, config) {
  const piPath = config.piPath || "pi";
  const timestamp = new Date().toISOString();
  const jobLogDir = join(LOGS_DIR, job.id);
  ensureDir(jobLogDir);

  const logFile = join(
    jobLogDir,
    `${timestamp.replace(/[:.]/g, "-")}.log`
  );

  log(`Starting job: "${job.name}" (${job.id})`);
  log(`  CWD: ${job.cwd}`);
  log(`  Schedule: ${job.schedule}`);
  log(`  Pi path: ${piPath}`);

  // Build pi args
  const args = ["-p"];
  if (job.model) {
    let modelStr = job.model;
    if (job.thinkingLevel) modelStr += `:${job.thinkingLevel}`;
    args.push("--model", modelStr);
  }
  args.push(job.prompt);

  log(`  Command: ${piPath} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);

  // Execute
  const result = spawnSync(piPath, args, {
    cwd: job.cwd,
    timeout: 30 * 60 * 1000, // 30 min timeout
    maxBuffer: 10 * 1024 * 1024, // 10MB
    encoding: "utf-8",
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const success = result.status === 0;
  const fullOutput = stdout + (stderr ? `\n\n--- STDERR ---\n${stderr}` : "");

  log(success ? "Job completed successfully" : `Job failed (exit ${result.status})`);
  if (stderr && !success) log(`Error: ${stderr.substring(0, 500)}`);

  // Save log
  writeFileSync(logFile, fullOutput);
  log(`Log: ${logFile}`);

  // Update config
  job.lastRun = timestamp;
  job.lastResult = fullOutput.substring(0, 10000);
  job.lastStatus = success ? "success" : "error";
  saveConfig(config);

  // Deliver results
  if (job.onComplete?.writeFile) {
    const outputPath = replacePlaceholders(job.onComplete.writeFile);
    ensureDir(dirname(outputPath));
    writeFileSync(outputPath, fullOutput);
    log(`Result written to: ${outputPath}`);
  }

  if (job.onComplete?.webhook) {
    const truncated = fullOutput.substring(0, 3000);
    sendWebhook(job.onComplete.webhook, {
      text: `🔔 *${job.name}* (${success ? "✅" : "❌"})\n\`\`\`\n${truncated}\n\`\`\``,
      job: { id: job.id, name: job.name },
      timestamp,
      status: success ? "success" : "error",
      outputLength: fullOutput.length,
    });
  }

  return success ? 0 : 1;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || action === "--help" || action === "-h") {
    console.log(`pi-cron runner — execute scheduled pi jobs

Usage:
  runner.mjs <job-id>       Run a specific job
  runner.mjs --list          List all configured jobs
  runner.mjs --test <id>     Dry-run: show what would execute
  runner.mjs --help          Show this help
`);
    process.exit(0);
  }

  const config = loadConfig();

  if (action === "--list") {
    if (config.jobs.length === 0) {
      console.log("No jobs configured.");
      process.exit(0);
    }
    console.log(
      config.jobs
        .map(
          (j) =>
            `  ${j.enabled ? "✓" : "✗"} ${j.id.padEnd(16)} ${j.name.padEnd(30)} ${j.schedule.padEnd(15)} ${j.lastStatus || "never"}`
        )
        .join("\n")
    );
    process.exit(0);
  }

  if (action === "--test") {
    const jobId = args[1];
    if (!jobId) {
      console.error("Usage: runner.mjs --test <job-id>");
      process.exit(1);
    }
    const job = config.jobs.find((j) => j.id === jobId);
    if (!job) {
      console.error(`Job not found: ${jobId}`);
      process.exit(1);
    }
    console.log("Dry run — would execute:");
    console.log(`  Job:     ${job.name} (${job.id})`);
    console.log(`  CWD:     ${job.cwd}`);
    console.log(`  Model:   ${job.model || "default"}`);
    console.log(`  Prompt:  ${job.prompt.substring(0, 200)}${job.prompt.length > 200 ? "..." : ""}`);
    console.log(`  Webhook: ${job.onComplete?.webhook || "none"}`);
    console.log(`  File:    ${job.onComplete?.writeFile || "none"}`);
    process.exit(0);
  }

  // Default: run a specific job
  const jobId = action;
  const job = config.jobs.find((j) => j.id === jobId);

  if (!job) {
    console.error(`Job not found: ${jobId}`);
    console.error(
      `Available: ${config.jobs.map((j) => j.id).join(", ") || "none"}`
    );
    process.exit(1);
  }

  if (!job.enabled) {
    log(`Job "${job.name}" is disabled. Skipping.`);
    process.exit(0);
  }

  const exitCode = runJob(job, config);
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("Runner error:", e);
  process.exit(1);
});
