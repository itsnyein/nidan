import { loadavg } from "node:os";

import { afterEach, beforeEach } from "vitest";

/**
 * Annotates every test failure with what the machine was doing.
 *
 * This suite builds a real Git repository and two type-checked programs per case, so a
 * contended machine produces failures that look exactly like defects: a timeout, or a
 * worker that simply disappears. Three such false reds happened in one day, each read as
 * a possible regression until it was re-run.
 *
 * The decisive number is **CPU against wall time**. A test that burned 2 s of CPU across
 * 30 s of wall clock was starved; one that burned 29 s was working. Printing both at the
 * moment of failure means a reader, a handoff, or a reviewer can classify it without
 * re-running — which is the thing that was missing, not the policy.
 *
 * Deliberately only annotates. It never retries and never relaxes a threshold: the
 * timeout is the detector, and a detector that gives way under load detects nothing.
 */

let startCpu: NodeJS.CpuUsage | undefined;
let startWall: bigint | undefined;

beforeEach(() => {
  startCpu = process.cpuUsage();
  startWall = process.hrtime.bigint();
});

afterEach((context) => {
  const result = context.task.result;
  if (result?.state !== "fail" || startCpu === undefined) return;
  if (startWall === undefined) return;

  const cpu = process.cpuUsage(startCpu);
  const wallMs = Number(process.hrtime.bigint() - startWall) / 1e6;
  const cpuMs = (cpu.user + cpu.system) / 1000;
  // Guard the division rather than the formatting: a sub-millisecond failure is real
  // (a synchronous assertion), and reporting Infinity% for it would be noise.
  const share = wallMs > 0 ? Math.round((cpuMs / wallMs) * 100) : 0;
  const load = loadavg()
    .map((average) => average.toFixed(1))
    .join(" / ");

  const verdict =
    share < 25
      ? "mostly waiting — suspect contention, re-run this file alone before believing it"
      : "mostly running — the failure is about the code";
  const note = `[contention] wall ${String(Math.round(wallMs))} ms, cpu ${String(Math.round(cpuMs))} ms (${String(share)}% of wall), loadavg ${load} — ${verdict}`;

  for (const error of result.errors ?? []) {
    error.message = `${error.message}\n${note}`;
  }
});
