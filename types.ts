export interface CronJob {
  id: string;
  name: string;
  schedule: string; // cron expression: min hour day month dow
  cwd: string; // project directory
  prompt: string; // pi prompt to execute
  model?: string; // e.g. "anthropic/claude-sonnet-4-20250514"
  thinkingLevel?: string; // off|minimal|low|medium|high|xhigh
  onComplete?: {
    webhook?: string; // Slack-compatible webhook URL
    writeFile?: string; // file path, supports {date} and {timestamp} placeholders
  };
  enabled: boolean;
  lastRun?: string | null;
  lastResult?: string | null;
  lastStatus?: "success" | "error" | null;
  createdAt: string;
}

export interface CronConfig {
  version: number;
  piPath?: string; // resolved at install time
  nodePath?: string;
  jobs: CronJob[];
}
