import { exec } from 'child_process';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { logger } from '../logger.js';

export interface ValidationResult {
  label: string;
  command: string;
  passed: boolean;
  output: string;
}

export interface ValidationReport {
  passed: boolean;
  results: ValidationResult[];
}

async function detectPackageManager(repoPath: string): Promise<string> {
  for (const [file, pm] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
  ] as const) {
    try {
      await readFile(join(repoPath, file));
      return pm;
    } catch {}
  }
  return 'npm';
}

async function detectScripts(repoPath: string): Promise<Record<string, string>> {
  try {
    const pkg = JSON.parse(await readFile(join(repoPath, 'package.json'), 'utf8'));
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

function runCommand(command: string, cwd: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n');
        resolve({ passed: !error, output });
      },
    );
  });
}

/** Run lint, typecheck, build, and test in parallel. Returns a report. */
export async function runValidation(repoPath: string): Promise<ValidationReport> {
  const pm = await detectPackageManager(repoPath);
  const scripts = await detectScripts(repoPath);

  const checks: Array<{ label: string; scriptNames: string[] }> = [
    { label: 'lint', scriptNames: ['lint', 'eslint'] },
    { label: 'typecheck', scriptNames: ['typecheck', 'type-check', 'tsc'] },
    { label: 'build', scriptNames: ['build'] },
    { label: 'test', scriptNames: ['test', 'test:unit'] },
  ];

  const commands: Array<{ label: string; command: string }> = [];
  for (const check of checks) {
    const found = check.scriptNames.find((name) => scripts[name]);
    if (found) {
      commands.push({ label: check.label, command: `${pm} run ${found}` });
    }
  }

  if (commands.length === 0) {
    logger.info('No validation scripts found in package.json — skipping');
    return { passed: true, results: [] };
  }

  logger.info(`Running validation: ${commands.map((c) => c.label).join(', ')}`);

  const results = await Promise.all(
    commands.map(async ({ label, command }): Promise<ValidationResult> => {
      const { passed, output } = await runCommand(command, repoPath);
      logger.info(`[validate] ${label}: ${passed ? 'PASS' : 'FAIL'}`);
      return { label, command, passed, output };
    }),
  );

  return {
    passed: results.every((r) => r.passed),
    results,
  };
}

/** Format failed results into an error summary for Claude */
export function formatValidationErrors(report: ValidationReport): string {
  const failed = report.results.filter((r) => !r.passed);
  return failed
    .map((r) => {
      const trimmed = r.output.slice(-3000);
      return `### ${r.label} (${r.command})\n\`\`\`\n${trimmed}\n\`\`\``;
    })
    .join('\n\n');
}
