import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn, execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import {
  loadConfig,
  saveConfig,
  addJob,
  removeJob,
  findJob,
  updateJob,
  generateId,
  validateCron,
  formatCronDescription,
  getConfigPath,
  getLogsDir,
  getRunnerPath,
} from "./config";
import type { CronJob } from "./types";

// ── Natural language schedule parser ─────────────────────────────────

/**
 * Converts natural language schedule descriptions to cron expressions.
 * Handles patterns like:
 *   "every day at 2am", "nightly at 3am", "every hour", "every 15 minutes",
 *   "weekdays at 9am", "monday at 10am", "daily at 3:30pm",
 *   "every monday at 9am", "twice a day at 9am and 5pm",
 *   "every weekday at 8:30am", "hourly", "daily", "weekly"
 */
function parseNaturalSchedule(input: string): { cron: string; description: string } | null {
  const s = input.toLowerCase().trim().replace(/\s+/g, " ");

  // ── Direct cron pass-through (5 numeric fields) ────────────────
  if (/^[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+\s+[\d*/,\-]+$/.test(s)) {
    return { cron: s, description: formatCronDescription(s) };
  }

  // ── Helper: parse time like "2am", "3:30pm", "14:00", "2:30 am" ─
  const parseTime = (str: string): { hour: number; minute: number } | null => {
    const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return null;
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = m[3]?.toLowerCase();
    if (ampm === "pm" && hour !== 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return { hour, minute };
  };

  const dayNames: Record<string, number> = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };

  const dayAliases: Record<string, string> = {
    weekday: "1-5", weekdays: "1-5",
    "work day": "1-5", "work days": "1-5", workday: "1-5", workdays: "1-5",
    "business day": "1-5", "business days": "1-5",
    weekend: "0,6", weekends: "0,6",
  };

  // ── "every N minutes" ──────────────────────────────────────────
  let m = s.match(/every\s+(\d+)\s+min(?:ute)?s?/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 59) return { cron: `*/${n} * * * *`, description: `every ${n} minutes` };
  }

  // ── "every N hours [at M]" ─────────────────────────────────────
  m = s.match(/every\s+(\d+)\s+hours?(?:\s+at\s+(\d(?::\d{2})?(?:\s*[ap]m)?))?/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 23) {
      if (m[2]) {
        const t = parseTime(m[2]);
        if (t) return { cron: `${t.minute} */${n} * * *`, description: `every ${n} hours at ${t.hour}:${String(t.minute).padStart(2, "0")}` };
      }
      return { cron: `0 */${n} * * *`, description: `every ${n} hours` };
    }
  }

  // ── "every minute" ─────────────────────────────────────────────
  if (/\bevery\s+minute\b/.test(s)) {
    return { cron: "* * * * *", description: "every minute" };
  }

  // ── "hourly" / "every hour" ────────────────────────────────────
  if (/\bhourly\b/.test(s) || /\bevery\s+hour\b/.test(s)) {
    return { cron: "0 * * * *", description: "every hour" };
  }

  // ── Extract optional "at <time>" ──────────────────────────────
  const timeMatch = s.match(/\bat\s+(\d{1,2}(?::\d{2})?(?:\s*[ap]m)?)/);
  const time = timeMatch ? parseTime(timeMatch[1]) : null;

  // ── Extract day-of-week patterns ───────────────────────────────
  let dow: string | null = null;
  for (const [alias, expr] of Object.entries(dayAliases)) {
    if (s.includes(alias)) { dow = expr; break; }
  }
  if (!dow) {
    for (const [name, num] of Object.entries(dayNames)) {
      // Match "monday", "mondays", "on mon", "every mon"
      const re = new RegExp(`\\b(?:every\\s+)?(?:on\\s+)?${name}s?\\b`);
      if (re.test(s)) { dow = String(num); break; }
    }
  }

  // ── "daily" / "every day" / "nightly" ──────────────────────────
  if (/\b(daily|every\s+day|nightly|each\s+day)\b/.test(s)) {
    if (time) return { cron: `${time.minute} ${time.hour} * * *`, description: `daily at ${time.hour}:${String(time.minute).padStart(2, "0")}` };
    if (/\bnightly\b/.test(s)) return { cron: "0 0 * * *", description: "nightly at midnight" };
    return { cron: "0 0 * * *", description: "daily at midnight" };
  }

  // ── "weekly" / "every week" ────────────────────────────────────
  if (/\b(weekly|every\s+week)\b/.test(s)) {
    if (time) return { cron: `${time.minute} ${time.hour} * * 1`, description: `weekly on Monday at ${time.hour}:${String(time.minute).padStart(2, "0")}` };
    return { cron: "0 0 * * 1", description: "weekly on Monday at midnight" };
  }

  // ── "monthly" / "every month" ──────────────────────────────────
  if (/\b(monthly|every\s+month)\b/.test(s)) {
    if (time) return { cron: `${time.minute} ${time.hour} 1 * *`, description: `monthly on the 1st at ${time.hour}:${String(time.minute).padStart(2, "0")}` };
    return { cron: "0 0 1 * *", description: "monthly on the 1st at midnight" };
  }

  // ── Day-of-week without "daily" keyword ────────────────────────
  if (dow && time) {
    const dayLabel = Object.entries(dayNames).find(([, v]) => String(v) === dow)?.[0] ?? dow;
    const aliasLabel = Object.entries(dayAliases).find(([, v]) => v === dow)?.[0] ?? null;
    const label = aliasLabel || dayLabel;
    return { cron: `${time.minute} ${time.hour} * * ${dow}`, description: `every ${label} at ${time.hour}:${String(time.minute).padStart(2, "0")}` };
  }
  if (dow) {
    const dayLabel = Object.entries(dayNames).find(([, v]) => String(v) === dow)?.[0] ?? dow;
    const aliasLabel = Object.entries(dayAliases).find(([, v]) => v === dow)?.[0] ?? null;
    const label = aliasLabel || dayLabel;
    return { cron: `0 0 * * ${dow}`, description: `every ${label} at midnight` };
  }

  // ── Just a time: "at 2am", "3:30pm" ────────────────────────────
  if (time && !dow) {
    return { cron: `${time.minute} ${time.hour} * * *`, description: `daily at ${time.hour}:${String(time.minute).padStart(2, "0")}` };
  }

  return null;
}

// ── Auto-generate job name from prompt ───────────────────────────────

function deriveNameFromPrompt(prompt: string): string {
  // Take first sentence, trim to 60 chars
  const first = prompt.replace(/\n/g, " ").split(/[.!?\n]/)[0].trim();
  if (first.length <= 60) return first;
  return first.substring(0, 57) + "...";
}

// ── Extract prompt + schedule from a single natural text ─────────────
//
// Given: "review code every day at 2am"
//   → { prompt: "review code", when: "every day at 2am" }
//
// Given: "send a daily standup report at 9am"
//   → { prompt: "send a daily standup report", when: "at 9am" }
//
// Given: "run the test suite"  (no schedule found)
//   → { prompt: "run the test suite" }
//
function extractPromptAndSchedule(text: string): { prompt: string; when?: string } {
  const schedulePatterns = [
    // "every N minutes/hours [at time]"
    /\s+every\s+\d+\s+(?:min(?:ute)?s?|hours?)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s*$/i,
    // "every day/week/month/hour/minute/weekday/Monday etc [at time]"
    /\s+every\s+(?:day|week|month|hour|minute|night|weekday|weekend|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\w*(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s*$/i,
    // "daily/nightly/hourly/weekly/monthly [at time]"
    /\s+(?:daily|nightly|hourly|weekly|monthly)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s*$/i,
    // "on weekdays/weekends/Monday [at time]"
    /\s+on\s+(?:weekdays?|weekends?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\w*(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\s*$/i,
    // "at 2am/3:30pm" (time-only → daily)
    /\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*$/i,
  ];

  for (const pattern of schedulePatterns) {
    const match = text.match(pattern);
    if (match) {
      const when = match[0].trim();
      const prompt = text.substring(0, text.length - match[0].length).trim();
      // Only use if there's actual prompt content left
      if (prompt) return { prompt, when };
    }
  }

  return { prompt: text };
}

// ── Helpers ──────────────────────────────────────────────────────────

function ensureLogsDir(jobId: string): string {
  const dir = join(getLogsDir(), jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolvePlaceholders(str: string): string {
  const now = new Date();
  return str
    .replace(/\{date\}/g, now.toISOString().split("T")[0])
    .replace(/\{timestamp\}/g, now.toISOString().replace(/[:.]/g, "-"));
}

function runJobInBackground(job: CronJob, ctx: any) {
  const args = ["-p"];
  if (job.model) {
    let modelStr = job.model;
    if (job.thinkingLevel) modelStr += `:${job.thinkingLevel}`;
    args.push("--model", modelStr);
  }
  args.push(job.prompt);

  ctx.ui.setStatus("cron", `⏳ Running: ${job.name}...`);

  const proc = spawn("pi", args, {
    cwd: job.cwd,
  });

  let output = "";
  proc.stdout.on("data", (data: Buffer) => {
    output += data.toString();
  });

  proc.stderr.on("data", (data: Buffer) => {
    output += data.toString();
  });

  proc.on("close", (code: number) => {
    const success = code === 0;
    const timestamp = new Date().toISOString();

    // Save log
    const logDir = ensureLogsDir(job.id);
    const logFile = join(logDir, `${timestamp.replace(/[:.]/g, "-")}.log`);
    writeFileSync(logFile, output);

    // Update config
    updateJob(job.id, {
      lastRun: timestamp,
      lastResult: output.substring(0, 10000),
      lastStatus: success ? "success" : "error",
    });

    // Deliver results
    deliverResults(job, output, success);

    ctx.ui.setStatus("cron", undefined);
    ctx.ui.notify(
      `Cron "${job.name}" ${success ? "✅ completed" : "❌ failed"}. Log: ${logFile}`,
      success ? "success" : "error"
    );
  });

  proc.on("error", (err: Error) => {
    ctx.ui.setStatus("cron", undefined);
    ctx.ui.notify(`Cron "${job.name}" failed to start: ${err.message}`, "error");
  });
}

function deliverResults(job: CronJob, output: string, success: boolean) {
  // File output
  if (job.onComplete?.writeFile) {
    try {
      const outputPath = resolvePlaceholders(job.onComplete.writeFile);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, output);
    } catch (e: any) {
      console.error(`[pi-cron] writeFile failed: ${e.message}`);
    }
  }

  // Webhook delivery
  if (job.onComplete?.webhook) {
    const payload = JSON.stringify({
      text: `🔔 *${job.name}* (${success ? "✅" : "❌"})\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\``,
      job: { id: job.id, name: job.name },
      timestamp: new Date().toISOString(),
      status: success ? "success" : "error",
    });

    try {
      spawn("curl", [
        "-s",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        payload,
        job.onComplete.webhook,
      ]);
    } catch {
      // Best effort
    }
  }
}

// ── Crontab management ───────────────────────────────────────────────

function detectPiPath(): string {
  try {
    return execSync("which pi", { encoding: "utf-8" }).trim();
  } catch {
    // Fallback to common pnpm locations
    const candidates = [
      join(homedir(), ".local/share/pnpm/pi"),
      join(homedir(), ".local/bin/pi"),
      "/usr/local/bin/pi",
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return "pi";
  }
}

function readCrontab(): string {
  try {
    return execSync("crontab -l 2>/dev/null", { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function writeCrontab(content: string): boolean {
  try {
    const proc = spawn("crontab", ["-"]);
    proc.stdin.write(content);
    proc.stdin.end();
    return true;
  } catch {
    return false;
  }
}

const CRON_MARKER_START = "# PI-CRON:";
const CRON_MARKER_END = "# END-PI-CRON:";

function stripPicroNEntries(crontab: string): string {
  const lines = crontab.split("\n");
  const filtered: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (line.includes(CRON_MARKER_START)) {
      skip = true;
      continue;
    }
    if (line.includes(CRON_MARKER_END)) {
      skip = false;
      continue;
    }
    if (!skip) filtered.push(line);
  }
  return filtered.join("\n");
}

// ── Command handlers ─────────────────────────────────────────────────

async function cmdList(ctx: any) {
  const config = loadConfig();
  if (config.jobs.length === 0) {
    ctx.ui.notify("No cron jobs configured. Use /cron add to create one.", "info");
    return;
  }

  const header = "  Status  ID               Name                            Schedule        Last Run";
  const sep = "  " + "─".repeat(95);
  const rows = config.jobs.map((j) => {
    const status = j.enabled ? "✓ ON " : "✗ OFF";
    const last = j.lastRun ? `${j.lastStatus || "?"} @ ${j.lastRun.slice(0, 16)}` : "never run";
    return `  ${status}  ${j.id.padEnd(16)} ${j.name.substring(0, 30).padEnd(31)} ${j.schedule.padEnd(15)} ${last}`;
  });

  ctx.ui.notify([header, sep, ...rows, "", `Config: ${getConfigPath()}`].join("\n"), "info");
}

async function cmdAdd(rest: string[], ctx: any) {
  // Accept full natural text as args, or prompt once if empty
  let text = rest.join(" ").trim();

  // Strip surrounding quotes
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }

  if (!text) {
    text = await ctx.ui.input(
      "What should pi do and when?",
      "review code every day at 2am"
    );
    if (!text) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }
  }

  // Try to extract schedule from the natural text
  const extracted = extractPromptAndSchedule(text);
  let prompt = extracted.prompt;
  let schedule: string | null = null;
  let scheduleDesc = "";

  if (extracted.when) {
    const parsed = parseNaturalSchedule(extracted.when);
    if (parsed) {
      schedule = parsed.cron;
      scheduleDesc = parsed.description;
    }
  }

  // If we still don't have a schedule, ask ONE follow-up
  if (!schedule) {
    const whenInput = await ctx.ui.input(
      "When should this run?",
      "every day at midnight"
    );
    if (!whenInput) {
      ctx.ui.notify("Cancelled.", "info");
      return;
    }

    const parsed = parseNaturalSchedule(whenInput);
    if (parsed) {
      schedule = parsed.cron;
      scheduleDesc = parsed.description;
    } else {
      // Last resort: try as raw cron expression
      const v = validateCron(whenInput);
      if (v.valid) {
        schedule = whenInput;
        scheduleDesc = formatCronDescription(whenInput);
      } else {
        ctx.ui.notify(
          `Could not understand that schedule. Try something like:\n  "every day at 2am"\n  "weekdays at 9am"\n  "every 15 minutes"\n  "hourly"\n  "0 2 * * *" (cron expression)`,
          "error"
        );
        return;
      }
    }
  }

  const name = deriveNameFromPrompt(prompt);

  const job: CronJob = {
    id: generateId(),
    name,
    schedule,
    cwd: ctx.cwd,
    prompt,
    enabled: true,
    lastRun: null,
    lastResult: null,
    lastStatus: null,
    createdAt: new Date().toISOString(),
  };

  addJob(job);
  ctx.ui.notify(
    `✅ Created "${job.name}"\n  Schedule: ${scheduleDesc} (${schedule})\n  CWD: ${job.cwd}\n  Prompt: ${prompt.substring(0, 200)}${prompt.length > 200 ? "..." : ""}\n\nRun /cron install to register with crontab, or /cron run ${job.id} to test.`,
    "success"
  );
}

async function cmdRemove(rest: string[], ctx: any) {
  const jobId = rest[0];
  if (!jobId) {
    ctx.ui.notify("Usage: /cron remove <job-id>", "info");
    return;
  }

  const job = findJob(jobId);
  if (!job) {
    ctx.ui.notify(`Job not found: ${jobId}`, "error");
    return;
  }

  const ok = await ctx.ui.confirm("Remove this job?", `${job.name} (${job.id}) — ${job.schedule}`);
  if (!ok) {
    ctx.ui.notify("Cancelled.", "info");
    return;
  }

  removeJob(jobId);
  ctx.ui.notify(`Removed job: ${job.name} (${jobId})\nRun /cron install to update crontab.`, "success");
}

async function cmdToggle(rest: string[], enable: boolean, ctx: any) {
  const jobId = rest[0];
  if (!jobId) {
    ctx.ui.notify(`Usage: /cron ${enable ? "enable" : "disable"} <job-id>`, "info");
    return;
  }

  const ok = updateJob(jobId, { enabled: enable });
  if (!ok) {
    ctx.ui.notify(`Job not found: ${jobId}`, "error");
    return;
  }

  ctx.ui.notify(`Job ${jobId} ${enable ? "enabled ✓" : "disabled ✗"}`, "success");
}

async function cmdRun(rest: string[], ctx: any) {
  const jobId = rest[0];
  if (!jobId) {
    ctx.ui.notify("Usage: /cron run <job-id>", "info");
    return;
  }

  const job = findJob(jobId);
  if (!job) {
    ctx.ui.notify(`Job not found: ${jobId}`, "error");
    return;
  }

  if (!existsSync(job.cwd)) {
    ctx.ui.notify(`Project directory does not exist: ${job.cwd}`, "error");
    return;
  }

  ctx.ui.notify(`Starting job "${job.name}" in background...\n  CWD: ${job.cwd}\n  Model: ${job.model || "default"}`, "info");
  runJobInBackground(job, ctx);
}

async function cmdInstall(ctx: any) {
  const config = loadConfig();
  const enabledJobs = config.jobs.filter((j) => j.enabled);

  if (enabledJobs.length === 0) {
    ctx.ui.notify("No enabled jobs to install. Use /cron add first.", "warning");
    return;
  }

  // Resolve and save paths
  const piPath = detectPiPath();
  config.piPath = piPath;
  config.nodePath = process.execPath;
  saveConfig(config);

  const runnerPath = getRunnerPath();

  // Build crontab
  let crontab = readCrontab();
  crontab = stripPicroNEntries(crontab);

  // Ensure trailing newline
  if (crontab.length > 0 && !crontab.endsWith("\n")) {
    crontab += "\n";
  }

  for (const job of enabledJobs) {
    const logFile = join(getLogsDir(), job.id, "runner.log");
    ensureLogsDir(job.id);

    crontab += `${CRON_MARKER_START}${job.id} — ${job.name}\n`;
    crontab += `${job.schedule} ${process.execPath} ${runnerPath} ${job.id} >> ${logFile} 2>&1\n`;
    crontab += `${CRON_MARKER_END}${job.id}\n`;
  }

  const ok = writeCrontab(crontab);
  if (ok) {
    ctx.ui.notify(
      `✅ Installed ${enabledJobs.length} job(s) to crontab:\n` +
        enabledJobs.map((j) => `  ${j.schedule}  ${j.name}`).join("\n") +
        `\n\nRunner: ${process.execPath} ${runnerPath}\nPi: ${piPath}`,
      "success"
    );
  } else {
    ctx.ui.notify("Failed to write crontab. Check permissions.", "error");
  }
}

async function cmdUninstall(ctx: any) {
  let crontab = readCrontab();
  crontab = stripPicroNEntries(crontab);

  const ok = writeCrontab(crontab);
  if (ok) {
    ctx.ui.notify("✅ Removed all pi-cron entries from crontab.", "success");
  } else {
    ctx.ui.notify("Failed to update crontab.", "error");
  }
}

async function cmdLogs(rest: string[], ctx: any) {
  const jobId = rest[0];

  if (jobId) {
    // Show logs for specific job
    const job = findJob(jobId);
    if (!job) {
      ctx.ui.notify(`Job not found: ${jobId}`, "error");
      return;
    }

    const logDir = join(getLogsDir(), job.id);
    if (!existsSync(logDir)) {
      ctx.ui.notify(`No logs found for ${job.name}`, "info");
      return;
    }

    // Show the latest log
    const files = execSync(`ls -t "${logDir}"`, { encoding: "utf-8" })
      .trim()
      .split("\n")
      .filter(Boolean);

    if (files.length === 0) {
      ctx.ui.notify("No log files found.", "info");
      return;
    }

    const latest = join(logDir, files[0]);
    const content = readFileSync(latest, "utf-8");
    const preview = content.substring(0, 3000);
    ctx.ui.notify(
      `📋 Latest log for "${job.name}" (${files[0]}):\n${preview}${content.length > 3000 ? "\n... (truncated)" : ""}`,
      "info"
    );
  } else {
    // Show summary for all jobs
    const config = loadConfig();
    if (config.jobs.length === 0) {
      ctx.ui.notify("No jobs configured.", "info");
      return;
    }

    const lines = config.jobs.map((j) => {
      const logDir = join(getLogsDir(), j.id);
      let logCount = 0;
      try {
        logCount = execSync(`ls "${logDir}" 2>/dev/null | wc -l`, {
          encoding: "utf-8",
        }).trim();
      } catch {}
      return `  ${j.id}  ${j.name.padEnd(30)} logs: ${logCount}  last: ${j.lastStatus || "never"}`;
    });

    ctx.ui.notify(
      `Logs directory: ${getLogsDir()}\n\n` + lines.join("\n"),
      "info"
    );
  }
}

async function cmdShow(rest: string[], ctx: any) {
  const scope = rest[0]; // "all" | undefined (project scope)
  const crontab = readCrontab();

  if (!crontab.trim()) {
    ctx.ui.notify("No crontab entries found.", "info");
    return;
  }

  // Parse pi-cron entries from crontab
  const entries: { jobId: string; jobName: string; schedule: string; line: string }[] = [];
  const lines = crontab.split("\n");
  let currentMarker = "";

  for (const line of lines) {
    if (line.includes(CRON_MARKER_START)) {
      // Extract job name from marker: "# PI-CRON:job-xxx — Job Name"
      currentMarker = line;
      continue;
    }
    if (line.includes(CRON_MARKER_END)) {
      currentMarker = "";
      continue;
    }
    if (currentMarker) {
      const markerMatch = currentMarker.match(/PI-CRON:(\S+)\s*—\s*(.+)/);
      const jobId = markerMatch?.[1] || "?";
      const jobName = markerMatch?.[2]?.trim() || "?";
      // The actual cron line (skip comment-like lines)
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        entries.push({ jobId, jobName, schedule: trimmed.split(/\s+/).slice(0, 5).join(" "), line: trimmed });
      }
    }
  }

  // Load config to resolve cwd per job
  const config = loadConfig();
  const jobMap = new Map(config.jobs.map((j) => [j.id, j]));
  const cwd = ctx.cwd;

  if (entries.length === 0) {
    ctx.ui.notify("No pi-cron entries in crontab. Run /cron install to register jobs.", "info");
    return;
  }

  const isProjectScope = !scope || scope === "project" || scope === ".";

  if (isProjectScope && scope !== "all") {
    // Show only jobs matching current project directory
    const projectEntries = entries.filter((e) => {
      const job = jobMap.get(e.jobId);
      return job && job.cwd === cwd;
    });

    if (projectEntries.length === 0) {
      ctx.ui.notify(
        `No pi-cron entries for this project (${cwd}).\nUse \`/cron show all\` to see all entries.`,
        "info"
      );
      return;
    }

    const rows = projectEntries.map((e) => {
      const job = jobMap.get(e.jobId);
      const status = job?.enabled ? "✓" : "✗";
      const last = job?.lastStatus || "never";
      return `  ${status}  ${e.schedule.padEnd(15)} ${e.jobName.padEnd(30)} last: ${last}`;
    });

    ctx.ui.notify(
      `📋 Pi-cron entries for this project:\n  ${cwd}\n\n` +
      `  Status  Schedule        Name                            Last Run\n` +
      `  ${"─".repeat(80)}\n` +
      rows.join("\n") +
      `\n\n${projectEntries.length} job(s) — use \`/cron show all\` for all entries`,
      "info"
    );
  } else {
    // Show all pi-cron entries, grouped by project
    const byProject = new Map<string, typeof entries>();
    for (const e of entries) {
      const job = jobMap.get(e.jobId);
      const projectCwd = job?.cwd || "unknown";
      if (!byProject.has(projectCwd)) byProject.set(projectCwd, []);
      byProject.get(projectCwd)!.push(e);
    }

    const sections: string[] = ["📋 All pi-cron crontab entries:\n"];
    for (const [projectCwd, projectEntries] of byProject) {
      const isCurrentProject = projectCwd === cwd;
      sections.push(`  ${isCurrentProject ? "▸" : " "} Project: ${projectCwd}${isCurrentProject ? "  (current)" : ""}`);

      for (const e of projectEntries) {
        const job = jobMap.get(e.jobId);
        const status = job?.enabled ? "✓" : "✗";
        const last = job?.lastStatus || "never";
        sections.push(`    ${status}  ${e.schedule.padEnd(15)} ${e.jobName.padEnd(30)} last: ${last}`);
      }
      sections.push("");
    }

    sections.push(`${entries.length} job(s) across ${byProject.size} project(s)`);
    ctx.ui.notify(sections.join("\n"), "info");
  }
}

// ── Extension entry point ────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── /cron command ──────────────────────────────────────────────────
  pi.registerCommand("cron", {
    description:
      "Manage scheduled cron jobs (list|show|add|remove|enable|disable|run|install|uninstall|logs)",
    getArgumentCompletions(prefix: string) {
      const subs = [
        "list",
        "show",
        "add",
        "remove",
        "enable",
        "disable",
        "run",
        "install",
        "uninstall",
        "logs",
      ];
      return subs
        .filter((s) => s.startsWith(prefix))
        .map((s) => ({ value: s, label: s }));
    },
    handler: async (args: string, ctx: any) => {
      const parts = (args || "").trim().split(/\s+/);
      const sub = parts[0];
      const rest = parts.slice(1);

      switch (sub) {
        case "list":
        case "ls":
          return cmdList(ctx);
        case "show":
        case "status":
          return cmdShow(rest, ctx);
        case "add":
          return cmdAdd(rest, ctx);
        case "remove":
        case "rm":
        case "delete":
          return cmdRemove(rest, ctx);
        case "enable":
          return cmdToggle(rest, true, ctx);
        case "disable":
          return cmdToggle(rest, false, ctx);
        case "run":
          return cmdRun(rest, ctx);
        case "install":
          return cmdInstall(ctx);
        case "uninstall":
          return cmdUninstall(ctx);
        case "logs":
          return cmdLogs(rest, ctx);
        default:
          ctx.ui.notify(
            "Usage: /cron <list|show|add|remove|enable|disable|run|install|uninstall|logs>",
            "info"
          );
      }
    },
  });

  // ── cron_manage tool (for the LLM) ─────────────────────────────────
  pi.registerTool({
    name: "cron_manage",
    label: "Cron Manager",
    description:
      "Schedule and manage automated pi tasks. The agent must auto-derive the job name and cron schedule from the user's natural language request. Only requires the prompt (what to run) and when to run it.",
    promptSnippet: "Schedule automated cron jobs for pi",
    promptGuidelines: [
      "YOU are the schedule parser. Convert the user's natural language directly to a 5-field cron expression. NEVER pass natural language to the 'schedule' field — convert it yourself.",
      "Cron reference — 5 fields: minute hour day-of-month month day-of-week",
      "  Examples: '0 2 * * *' = daily 2am, '*/15 * * * *' = every 15min, '0 9 * * 1-5' = weekdays 9am, '0 0 * * 0' = weekly sunday midnight, '30 8 1 * *' = monthly 1st 8:30am",
      "  Time: 0=midnight, 2=2am, 14=2pm, 23=11pm. Days: 0=Sun, 1=Mon, ..., 6=Sat",
      "NEVER ask the user for a cron expression or job name. Derive them from what the user says.",
      "The 'name' parameter is optional — if omitted, it's auto-generated from the prompt",
      "Each job targets a project directory and uses that project's pi settings (extensions, skills, AGENTS.md)",
      "After creating a job, tell the user to run /cron install to register with crontab, or /cron run <id> to test",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "list",
        "show",
        "add",
        "remove",
        "enable",
        "disable",
        "run",
      ] as const),
      jobId: Type.Optional(
        Type.String({ description: "Job ID (for remove/enable/disable/run)" })
      ),
      name: Type.Optional(
        Type.String({ description: "Job name. Auto-generated from prompt if omitted." })
      ),
      schedule: Type.Optional(
        Type.String({
          description: "5-field cron expression. YOU must convert the user's natural language to this. e.g. '0 2 * * *' for daily 2am, '*/15 * * * *' for every 15min, '0 9 * * 1-5' for weekdays 9am",
        })
      ),
      prompt: Type.Optional(
        Type.String({ description: "The pi prompt to execute (for add). Required for add action." })
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Project directory path (defaults to current cwd)",
        })
      ),
      model: Type.Optional(
        Type.String({
          description: "Model override, e.g. 'anthropic/claude-sonnet-4-20250514'",
        })
      ),
      thinkingLevel: Type.Optional(
        StringEnum(
          ["off", "minimal", "low", "medium", "high", "xhigh"] as const
        )
      ),
      scope: Type.Optional(
        StringEnum(["all", "project"] as const, { description: "For 'show' action: 'all' shows every crontab entry, 'project' shows only current project (default)" })
      ),
      webhook: Type.Optional(
        Type.String({ description: "Webhook URL for result delivery (Slack/Discord)" })
      ),
      writeFile: Type.Optional(
        Type.String({
          description: "File path for result output. Supports {date} and {timestamp} placeholders",
        })
      ),
    }),
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: any
    ) {
      switch (params.action) {
        case "list": {
          const config = loadConfig();
          if (config.jobs.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No cron jobs configured. Use action='add' to create one.",
                },
              ],
              details: {},
            };
          }
          const lines = config.jobs.map(
            (j) =>
              `[${j.enabled ? "ON" : "OFF"}] ${j.id} | ${j.name} | ${j.schedule} (${formatCronDescription(j.schedule)}) | ${j.cwd} | last: ${j.lastStatus || "never"}`
          );
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { jobs: config.jobs },
          };
        }

        case "show": {
          const crontab = readCrontab();
          if (!crontab.trim()) {
            return {
              content: [{ type: "text", text: "No crontab entries found." }],
              details: {},
            };
          }

          const entries: { jobId: string; jobName: string; schedule: string; line: string }[] = [];
          const crLines = crontab.split("\n");
          let currentMarker = "";
          for (const line of crLines) {
            if (line.includes(CRON_MARKER_START)) {
              currentMarker = line;
              continue;
            }
            if (line.includes(CRON_MARKER_END)) {
              currentMarker = "";
              continue;
            }
            if (currentMarker) {
              const m = currentMarker.match(/PI-CRON:(\S+)\s*—\s*(.+)/);
              const jobId = m?.[1] || "?";
              const jobName = m?.[2]?.trim() || "?";
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith("#")) {
                entries.push({ jobId, jobName, schedule: trimmed.split(/\s+/).slice(0, 5).join(" "), line: trimmed });
              }
            }
          }

          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No pi-cron entries in crontab. Run /cron install to register jobs." }],
              details: {},
            };
          }

          const showConfig = loadConfig();
          const jobMap = new Map(showConfig.jobs.map((j) => [j.id, j]));
          const isAll = params.scope === "all";

          if (!isAll) {
            const projectEntries = entries.filter((e) => {
              const job = jobMap.get(e.jobId);
              return job && job.cwd === ctx.cwd;
            });
            if (projectEntries.length === 0) {
              return {
                content: [{ type: "text", text: `No pi-cron entries for this project (${ctx.cwd}). Use scope='all' to see all entries.` }],
                details: { cwd: ctx.cwd, totalEntries: entries.length },
              };
            }
            const rows = projectEntries.map((e) => {
              const job = jobMap.get(e.jobId);
              return `${e.schedule}  ${e.jobName}  [${job?.enabled ? "ON" : "OFF"}]  last: ${job?.lastStatus || "never"}`;
            });
            return {
              content: [{ type: "text", text: `Pi-cron entries for ${ctx.cwd}:\n${rows.join("\n")}` }],
              details: { cwd: ctx.cwd, entries: projectEntries },
            };
          } else {
            const byProject = new Map<string, typeof entries>();
            for (const e of entries) {
              const job = jobMap.get(e.jobId);
              const projectCwd = job?.cwd || "unknown";
              if (!byProject.has(projectCwd)) byProject.set(projectCwd, []);
              byProject.get(projectCwd)!.push(e);
            }
            const sections: string[] = [];
            for (const [projectCwd, projectEntries] of byProject) {
              const isCurrent = projectCwd === ctx.cwd;
              sections.push(`${isCurrent ? "▸" : " " } ${projectCwd}${isCurrent ? " (current)" : ""}`);
              for (const e of projectEntries) {
                const job = jobMap.get(e.jobId);
                sections.push(`  ${e.schedule}  ${e.jobName}  [${job?.enabled ? "ON" : "OFF"}]  last: ${job?.lastStatus || "never"}`);
              }
            }
            return {
              content: [{ type: "text", text: `All pi-cron crontab entries:\n${sections.join("\n")}\n\n${entries.length} job(s) across ${byProject.size} project(s)` }],
              details: { entries, projectCount: byProject.size },
            };
          }
        }

        case "add": {
          if (!params.prompt) {
            return {
              content: [
                {
                  type: "text",
                  text: "The 'prompt' field is required — what should pi do?",
                },
              ],
              details: {},
            };
          }

          if (!params.schedule) {
            return {
              content: [
                {
                  type: "text",
                  text: "The 'schedule' field is required — provide a 5-field cron expression. You MUST convert the user's natural language to cron yourself. Examples: daily 2am='0 2 * * *', every 15min='*/15 * * * *', weekdays 9am='0 9 * * 1-5', weekly monday='0 0 * * 1'.",
                },
              ],
              details: {},
            };
          }

          const validation = validateCron(params.schedule);
          if (!validation.valid) {
            return {
              content: [{ type: "text", text: `Invalid cron expression '${params.schedule}': ${validation.error}. Must be 5 fields: minute hour day-of-month month day-of-week. Examples: '0 2 * * *' (daily 2am), '*/15 * * * *' (every 15min), '0 9 * * 1-5' (weekdays 9am).` }],
              details: {},
            };
          }

          const schedule = params.schedule;
          const scheduleDesc = formatCronDescription(schedule);

          // ── Auto-derive name from prompt if not given ────────────
          const name = params.name || deriveNameFromPrompt(params.prompt);

          const job: CronJob = {
            id: generateId(),
            name,
            schedule,
            cwd: params.cwd || ctx.cwd,
            prompt: params.prompt,
            model: params.model || undefined,
            thinkingLevel: params.thinkingLevel || undefined,
            onComplete: {
              webhook: params.webhook || undefined,
              writeFile: params.writeFile || undefined,
            },
            enabled: true,
            lastRun: null,
            lastResult: null,
            lastStatus: null,
            createdAt: new Date().toISOString(),
          };

          addJob(job);
          return {
            content: [
              {
                type: "text",
                text: `✅ Created scheduled job "${job.name}" (ID: ${job.id})\n  Schedule: ${job.schedule} (${scheduleDesc})\n  CWD: ${job.cwd}\n  Model: ${job.model || "default"}\n  Webhook: ${job.onComplete?.webhook || "none"}\n  File: ${job.onComplete?.writeFile || "none"}\n\nTell the user to run /cron install to register with crontab, or /cron run ${job.id} to test.`,
              },
            ],
            details: { job },
          };
        }

        case "remove": {
          if (!params.jobId) {
            return {
              content: [{ type: "text", text: "Missing jobId for remove action." }],
              details: {},
            };
          }
          const found = removeJob(params.jobId);
          return {
            content: [
              {
                type: "text",
                text: found
                  ? `Removed job: ${params.jobId}`
                  : `Job not found: ${params.jobId}`,
              },
            ],
            details: {},
          };
        }

        case "enable":
        case "disable": {
          if (!params.jobId) {
            return {
              content: [{ type: "text", text: "Missing jobId." }],
              details: {},
            };
          }
          const ok = updateJob(params.jobId, {
            enabled: params.action === "enable",
          });
          return {
            content: [
              {
                type: "text",
                text: ok
                  ? `Job ${params.jobId} ${params.action === "enable" ? "enabled ✓" : "disabled ✗"}`
                  : `Job not found: ${params.jobId}`,
              },
            ],
            details: {},
          };
        }

        case "run": {
          if (!params.jobId) {
            return {
              content: [{ type: "text", text: "Missing jobId for run action." }],
              details: {},
            };
          }
          const job = findJob(params.jobId);
          if (!job) {
            return {
              content: [{ type: "text", text: `Job not found: ${params.jobId}` }],
              details: {},
            };
          }
          if (!existsSync(job.cwd)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Project directory does not exist: ${job.cwd}`,
                },
              ],
              details: {},
            };
          }

          runJobInBackground(job, ctx);
          return {
            content: [
              {
                type: "text",
                text: `Started job "${job.name}" (${job.id}) in background.\nCWD: ${job.cwd}\nModel: ${job.model || "default"}\n\nIt will notify when complete. Use /cron logs ${job.id} to check results.`,
              },
            ],
            details: {},
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${params.action}` }],
            details: {},
          };
      }
    },
  });

  // ── Startup notification ───────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    const config = loadConfig();
    if (config.jobs.length > 0) {
      ctx.ui.setStatus(
        "cron",
        `⏰ ${config.jobs.filter((j) => j.enabled).length}/${config.jobs.length} cron jobs`
      );
    }
  });
}
