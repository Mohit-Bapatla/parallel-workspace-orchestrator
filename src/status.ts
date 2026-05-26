import type { RunState } from "./types.js";

export function renderStatus(state: RunState | null): string {
  if (state === null) {
    return "No AWO state found.";
  }

  const currentBatch = state.batches[state.currentBatchIndex];
  const currentBatchLabel = currentBatch === undefined
    ? `${state.currentBatchIndex}/-`
    : `${state.currentBatchIndex}/${currentBatch.id}`;
  const rows = state.batches.flatMap((batch) =>
    batch.parts.map((part) => ({
      batch: batch.id,
      part: part.id,
      status: part.status,
      branch: part.branch ?? "-",
      log: part.logPath ?? "-",
    })),
  );

  return [
    `Run ID: ${state.runId}`,
    `Run status: ${state.status}`,
    `Base branch: ${state.baseBranch}`,
    `Current batch: ${currentBatchLabel}`,
    `Started at: ${state.startedAt}`,
    `Updated at: ${state.updatedAt}`,
    "",
    renderTable(rows),
  ].join("\n");
}

function renderTable(rows: Array<Record<"batch" | "part" | "status" | "branch" | "log", string>>): string {
  const headers = {
    batch: "Batch",
    part: "Part",
    status: "Status",
    branch: "Branch",
    log: "Log",
  };
  const widths = {
    batch: columnWidth(headers.batch, rows.map((row) => row.batch)),
    part: columnWidth(headers.part, rows.map((row) => row.part)),
    status: columnWidth(headers.status, rows.map((row) => row.status)),
    branch: columnWidth(headers.branch, rows.map((row) => row.branch)),
    log: columnWidth(headers.log, rows.map((row) => row.log)),
  };

  const headerLine = [
    headers.batch.padEnd(widths.batch),
    headers.part.padEnd(widths.part),
    headers.status.padEnd(widths.status),
    headers.branch.padEnd(widths.branch),
    headers.log.padEnd(widths.log),
  ].join("  ");
  const divider = [
    "-".repeat(widths.batch),
    "-".repeat(widths.part),
    "-".repeat(widths.status),
    "-".repeat(widths.branch),
    "-".repeat(widths.log),
  ].join("  ");
  const body = rows.map((row) =>
    [
      row.batch.padEnd(widths.batch),
      row.part.padEnd(widths.part),
      row.status.padEnd(widths.status),
      row.branch.padEnd(widths.branch),
      row.log.padEnd(widths.log),
    ].join("  "),
  );

  return [headerLine, divider, ...body].join("\n");
}

function columnWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((value) => value.length));
}
