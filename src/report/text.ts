import type { Report } from "../model.js";

/**
 * Human-readable output.
 *
 * Not a stable contract: wording and layout may change in any release. Automation must
 * read the JSON output. The full reporter arrives in T5.1; this is the minimum that makes
 * the CLI usable without misrepresenting what has been implemented.
 */
export function renderText(report: Report): string {
  const { run } = report;
  const lines: string[] = [
    `omen  ${run.refs.base} -> ${run.refs.head}`,
    `compared ${short(run.refs.mergeBaseSha)}..${short(run.refs.headSha)} (merge base)`,
    `run: ${run.status}  config: ${run.analysisMode}  typescript: ${run.analysisTypeScriptVersion}`,
  ];

  for (const reason of run.reasons) {
    lines.push(`  reason: ${reason.kind}`);
  }
  for (const warning of run.warnings) {
    lines.push(`  warning: ${warning.kind} (${warning.packages.join(", ")})`);
  }

  lines.push("");
  // Never "no impact": finding nothing statically is not evidence of safety, and seed
  // mapping is not implemented yet, which the reader has no way to know otherwise.
  lines.push(
    "No static usages found. Seed mapping is not implemented yet (M2).",
  );
  lines.push(`Gaps: ${String(run.counts.gaps + run.counts.repoWideGaps)}`);
  lines.push("");
  lines.push("Not analyzed by design:");
  for (const item of report.coverage) {
    lines.push(`  - ${item}`);
  }

  return `${lines.join("\n")}\n`;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}
