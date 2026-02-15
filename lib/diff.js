// ABOUTME: Minimal unified diff generator — no dependencies
// ABOUTME: Implements Myers diff algorithm for line-level comparison

/**
 * Create a unified diff patch between two strings.
 * Returns empty string if inputs are identical.
 */
export function createTwoFilesPatch(oldName, newName, oldStr, newStr, context = 3) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");

  const hunks = diffLines(oldLines, newLines, context);

  if (hunks.length === 0) return "";

  let result = `--- a/${oldName}\n+++ b/${newName}\n`;
  for (const hunk of hunks) {
    result += hunk;
  }
  return result;
}

function diffLines(oldLines, newLines, context) {
  // Compute edit script using simple LCS-based approach
  const edits = computeEdits(oldLines, newLines);

  // Group edits into hunks with context
  return buildHunks(oldLines, newLines, edits, context);
}

function computeEdits(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, fall back to a simpler approach
  if (m * n > 10_000_000) {
    return simpleDiff(oldLines, newLines);
  }

  // Standard LCS DP
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to get edit operations
  // ' ' = keep, '-' = delete from old, '+' = add from new
  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ op: " ", line: oldLines[i - 1], oldIdx: i - 1, newIdx: j - 1 });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ op: "+", line: newLines[j - 1], newIdx: j - 1 });
      j--;
    } else {
      ops.push({ op: "-", line: oldLines[i - 1], oldIdx: i - 1 });
      i--;
    }
  }

  ops.reverse();
  return ops;
}

function simpleDiff(oldLines, newLines) {
  // Fallback for huge files: treat as full replacement
  const ops = [];
  for (const line of oldLines) {
    ops.push({ op: "-", line });
  }
  for (const line of newLines) {
    ops.push({ op: "+", line });
  }
  return ops;
}

function buildHunks(oldLines, newLines, edits, context) {
  const hunks = [];

  // Find ranges of changes, expanded by context
  let i = 0;
  while (i < edits.length) {
    // Skip unchanged lines
    if (edits[i].op === " ") { i++; continue; }

    // Found a change — find the extent
    let start = i;
    let end = i;

    while (end < edits.length) {
      if (edits[end].op !== " ") {
        end++;
        continue;
      }
      // Check if next change is within context range (merge hunks)
      let nextChange = end;
      while (nextChange < edits.length && edits[nextChange].op === " ") nextChange++;
      if (nextChange < edits.length && nextChange - end <= context * 2) {
        end = nextChange + 1;
      } else {
        break;
      }
    }

    // Expand start/end by context
    const ctxStart = Math.max(0, start - context);
    const ctxEnd = Math.min(edits.length, end + context);

    // Calculate line numbers
    let oldStart = 1, newStart = 1;
    for (let k = 0; k < ctxStart; k++) {
      if (edits[k].op !== "+") oldStart++;
      if (edits[k].op !== "-") newStart++;
    }

    let oldCount = 0, newCount = 0;
    let body = "";
    for (let k = ctxStart; k < ctxEnd; k++) {
      const e = edits[k];
      body += `${e.op}${e.line}\n`;
      if (e.op !== "+") oldCount++;
      if (e.op !== "-") newCount++;
    }

    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`);
    i = ctxEnd;
  }

  return hunks;
}
