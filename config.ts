import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CronConfig, CronJob } from "./types";

const CONFIG_DIR = join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "pi-cron.json");
const LOGS_DIR = join(homedir(), ".pi", "agent", "pi-cron-logs");

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getLogsDir(): string {
  return LOGS_DIR;
}

export function getExtensionDir(): string {
  return join(homedir(), ".pi", "agent", "extensions", "pi-cron");
}

export function getRunnerPath(): string {
  return join(getExtensionDir(), "runner.mjs");
}

export function loadConfig(): CronConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { version: 1, jobs: [] };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function saveConfig(config: CronConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function addJob(job: CronJob): void {
  const config = loadConfig();
  config.jobs.push(job);
  saveConfig(config);
}

export function removeJob(id: string): boolean {
  const config = loadConfig();
  const index = config.jobs.findIndex((j) => j.id === id);
  if (index === -1) return false;
  config.jobs.splice(index, 1);
  saveConfig(config);
  return true;
}

export function findJob(id: string): CronJob | undefined {
  return loadConfig().jobs.find((j) => j.id === id);
}

export function updateJob(id: string, updates: Partial<CronJob>): boolean {
  const config = loadConfig();
  const job = config.jobs.find((j) => j.id === id);
  if (!job) return false;
  Object.assign(job, updates);
  saveConfig(config);
  return true;
}

export function generateId(): string {
  return `job-${Math.random().toString(36).substring(2, 10)}`;
}

export function validateCron(expr: string): { valid: boolean; error?: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, error: "Cron expression must have exactly 5 fields: min hour day-of-month month day-of-week" };
  }
  // Basic field validation
  const [min, hour, dom, mon, dow] = parts;
  const isFieldValid = (field: string, min: number, max: number): boolean => {
    if (field === "*") return true;
    // Handle ranges (1-5), steps (*/2, 1-5/2), and lists (1,3,5)
    const segments = field.split(",");
    return segments.every((seg) => {
      const [range, step] = seg.split("/");
      if (range === "*") return !step || /^\d+$/.test(step);
      const [start, end] = range.split("-").map(Number);
      if (isNaN(start)) return false;
      if (end !== undefined && isNaN(end)) return false;
      const s = start;
      const e = end ?? start;
      return s >= min && e <= max && s <= e;
    });
  };

  if (!isFieldValid(min, 0, 59)) return { valid: false, error: `Invalid minute field: "${min}"` };
  if (!isFieldValid(hour, 0, 23)) return { valid: false, error: `Invalid hour field: "${hour}"` };
  if (!isFieldValid(dom, 1, 31)) return { valid: false, error: `Invalid day-of-month field: "${dom}"` };
  if (!isFieldValid(mon, 1, 12)) return { valid: false, error: `Invalid month field: "${mon}"` };
  if (!isFieldValid(dow, 0, 6)) return { valid: false, error: `Invalid day-of-week field: "${dow}"` };

  return { valid: true };
}

export function formatCronDescription(expr: string): string {
  const descriptions: Record<string, string> = {
    "* * * * *": "every minute",
    "0 * * * *": "every hour",
    "0 0 * * *": "daily at midnight",
  };
  if (descriptions[expr]) return descriptions[expr];

  const [min, hour, dom, mon, dow] = expr.split(/\s+/);
  const parts: string[] = [];
  if (hour !== "*" && min !== "*") parts.push(`at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`);
  if (dow !== "*") parts.push(`on day ${dow} of the week`);
  if (dom !== "*") parts.push(`on day ${dom} of the month`);
  if (mon !== "*") parts.push(`in month ${mon}`);
  if (hour === "*" && min === "*") parts.push("every minute");
  else if (hour === "*") parts.push("every hour");

  return parts.join(", ") || expr;
}
