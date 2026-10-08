#!/usr/bin/env node
/**
 * check-repo.mjs — repo hygiene gate: the executable slice of repo-health's
 * Layer A baseline + Layer B conventions.
 *
 * Composes:
 *   1. conventions.json rules (delegates to check-conventions.mjs)
 *   2. docs-in-pairs — AGENTS.md must have a README.md sibling (root and at
 *      every nested depth where an AGENTS.md exists)
 *   3. commands-resolve — every command cited in AGENTS.md must resolve:
 *      package.json scripts (npm/pnpm/bun/yarn run), file paths (node, tsx,
 *      bash, …), Makefile targets. AGENTS.md instructions that cite
 *      non-existent commands are worse than none — the agent tries them and
 *      burns turns.
 *   4. baseline — LICENSE, a CI workflow, a lockfile next to package.json
 *
 * Everything above is a warning except conventions you promoted to
 * severity "error". Deterministic feedback for agents and CI; the human-led
 * audit (repo-health skill) stays the place for judgment calls.
 *
 * Usage mirrors check-conventions.mjs:
 *   node scripts/check-repo.mjs [root] [--conventions <file>] [--files a,b] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck as runConventions, walk } from "./check-conventions.mjs";

const PM_BUILTINS = new Set([
  "install", "ci", "test", "start", "stop", "restart", "publish", "update",
  "run", "init", "link", "unlink", "add", "remove", "exec", "cache", "config",
  "dlx", "why", "outdated", "audit", "login", "logout", "pack", "version",
  "info", "search", "fund", "org", "help", "run-script",
]);
const SCRIPT_PMS = /^(npm|pnpm|bun|yarn)$/;

/** Every AGENTS.md in the repo (walk already skips .git and node_modules). */
export function findAgentsFiles(allPaths) {
  return allPaths.filter((p) => p === "AGENTS.md" || p.endsWith("/AGENTS.md"));
}

/**
 * Commands worth validating, from inline code spans plus runnable lines in
 * fenced blocks. Spans keep only a plausible command shape (first token is
 * a package manager, runner, or make).
 */
export function extractCommands(md) {
  const cmds = new Set();
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const c = m[1].trim();
    if (/^(npm|pnpm|bun|yarn|node|tsx|make)\b/.test(c)) cmds.add(c.split(/\s+#\s/)[0]);
  }
  let inFence = false;
  for (const raw of md.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const c = raw.trim().replace(/^\$\s+/, "");
    if (c && !c.startsWith("#") && /^(npm|pnpm|bun|yarn|node|tsx|make)\b/.test(c)) {
      cmds.add(c.split(/\s+#\s/)[0]);
    }
  }
  return [...cmds];
}

function nearestPackage(dir, root) {
  let cur = dir;
  for (;;) {
    const p = path.join(cur, "package.json");
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, "utf8")).scripts ?? {};
      } catch {
        return {};
      }
    }
    if (cur === root) return null;
    cur = path.dirname(cur);
  }
}

/** Validate a cited command against the repo. Returns a problem string or null. */
export function checkCommand(cmd, dir, root) {
  const tokens = cmd.split(/\s+/);
  const [bin, first] = tokens;

  // package-manager script invocations, incl. `--prefix`-scoped ones
  if (SCRIPT_PMS.test(bin)) {
    const prefixIdx = tokens.findIndex((t) => t === "--prefix" || t === "-C");
    const scopeDir =
      prefixIdx !== -1 && tokens[prefixIdx + 1]
        ? path.resolve(dir, tokens[prefixIdx + 1])
        : dir;
    const scriptName = first === "run" ? tokens[2] : first;
    if (
      scriptName &&
      !scriptName.startsWith("-") &&
      !PM_BUILTINS.has(scriptName) &&
      !scriptName.includes(":\\") // not a path-ish token
    ) {
      const scripts = nearestPackage(scopeDir, root);
      if (scripts && !(scriptName in scripts)) {
        return `no script "${scriptName}" in ${path.relative(root, nearestPackagePath(scopeDir, root))}`;
      }
    }
    return null;
  }

  // runners with a path operand: node FILE, tsx FILE, bash FILE, node --test DIR
  if (/^(node|tsx|bun|bunx|npx|bash|sh|zsh|python3?|uv)$/.test(bin)) {
    const operand = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (
      operand &&
      !operand.includes("*") && // shell glob — expanded at run time, not verifiable here
      operand.includes("/") &&
      !/^https?:/.test(operand)
    ) {
      const resolved = operand.startsWith("/")
        ? path.join(root, operand)
        : path.resolve(dir, operand);
      if (!fs.existsSync(resolved)) return `path "${operand}" does not exist`;
    }
    return null;
  }

  if (bin === "make") {
    const target = first?.split("=")[0];
    if (!target) return null;
    let cur = dir;
    for (;;) {
      const mk = path.join(cur, "Makefile");
      if (fs.existsSync(mk)) {
        const body = fs.readFileSync(mk, "utf8");
        return new RegExp(`^${target}\\s*:[^=]`, "m").test(body) || target === ".PHONY"
          ? null
          : `no "${target}" target in ${path.relative(root, mk)}`;
      }
      if (cur === root) return `no Makefile found`;
      cur = path.dirname(cur);
    }
  }

  if (tokens[0]?.startsWith("./")) {
    const resolved = path.resolve(dir, tokens[0]);
    if (!fs.existsSync(resolved)) return `path "${tokens[0]}" does not exist`;
  }
  return null;
}

function nearestPackagePath(dir, root) {
  let cur = dir;
  for (;;) {
    const p = path.join(cur, "package.json");
    if (fs.existsSync(p)) return p;
    if (cur === root) return p;
    cur = path.dirname(cur);
  }
}

/** docs-in-pairs + baseline checks. Returns rows: {check, rel, severity, detail}. */
export function checkRepoBasics(root, allPaths) {
  const has = (p) => allPaths.includes(p);
  const filesSet = new Set(allPaths.filter((p) => !p.endsWith(path.sep) && !isDir(root, p)));
  const rows = [];
  const warn = (check, rel, detail) => rows.push({ check, rel, severity: "warning", detail });

  // docs-in-pairs: README.md (humans) + AGENTS.md (agents), everywhere AGENTS.md lives
  for (const agents of allPaths
    .filter((p) => p === "AGENTS.md" || p.endsWith("/AGENTS.md"))) {
    const readme = path.join(path.dirname(agents), "README.md");
    if (!filesSet.has(readme)) warn("docs-in-pairs", agents, `no README.md sibling — docs come in pairs`);
  }

  // baseline
  if (!allPaths.some((p) => /^LICENSE/i.test(p))) warn("baseline", ".", "no LICENSE file");
  const hasCI = allPaths.some((p) => p.startsWith(".github/workflows/") && /\.(yml|yaml)$/.test(p));
  if (!hasCI) warn("baseline", ".", "no CI workflow under .github/workflows/");
  if (filesSet.has("package.json")) {
    const locked = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"].some(has);
    if (!locked) warn("baseline", "package.json", "no committed lockfile next to package.json");
  }
  return rows;
}

function isDir(root, rel) {
  try {
    return fs.statSync(path.join(root, rel)).isDirectory();
  } catch {
    return false;
  }
}

/** commands-resolve across all AGENTS.md files. */
export function checkAgentsCommands(root, allPaths) {
  const rows = [];
  for (const agents of findAgentsFiles(allPaths)) {
    const abs = path.join(root, agents);
    const dir = path.dirname(abs);
    for (const cmd of extractCommands(fs.readFileSync(abs, "utf8"))) {
      const problem = checkCommand(cmd, dir, root);
      if (problem) rows.push({ check: "commands-resolve", rel: agents, severity: "warning", detail: `command "${cmd}" — ${problem}` });
    }
  }
  return rows;
}

export function runRepoCheck(root, { conventionsFile, files } = {}) {
  const allPaths = walk(root);
  const conventions = runConventions(root, { conventionsFile, files });
  const conventionRows = conventions.rows.map((r) => ({
    check: `convention:${r.conv.name}`,
    rel: r.rel,
    severity: r.severity,
    detail: r.detail,
  }));
  const rows = [
    ...conventionRows,
    ...checkRepoBasics(root, allPaths),
    ...checkAgentsCommands(root, allPaths),
  ].sort((a, b) => a.rel.localeCompare(b.rel) || a.check.localeCompare(b.check));
  const errors = rows.filter((r) => r.severity === "error").length;
  const warnings = rows.length - errors;
  return {
    rows,
    configWarnings: conventions.configWarnings,
    summary: { ...conventions.summary, errors, warnings },
  };
}

export function main(argv = process.argv.slice(2)) {
  const opts = { files: null, conventionsFile: null, json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--files") opts.files = argv[++i]?.split(/[\n,]/).filter(Boolean) ?? null;
    else if (a === "--conventions") opts.conventionsFile = argv[++i];
    else if (a === "--json") opts.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write("Usage: check-repo.mjs [root] [--conventions <file>] [--files a,b] [--json]\n");
      return 0;
    } else positional.push(a);
  }
  try {
    const root = path.resolve(positional[0] ?? ".");
    const result = runRepoCheck(root, opts);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ root, ...result }, null, 2)}\n`);
    } else {
      for (const w of result.configWarnings) process.stdout.write(`config  WARNING ${w}\n`);
      for (const r of result.rows) {
        process.stdout.write(`${r.severity.toUpperCase().padEnd(7)} ${r.check.padEnd(24).slice(0, 24)} ${r.rel} — ${r.detail}\n`);
      }
      const s = result.summary;
      process.stdout.write(
        `Repo check — conventions on ${s.checkedPaths} paths. Found ${s.errors} errors, ${s.warnings} warnings.\n`,
      );
    }
    if (result.summary.errors > 0) {
      process.stdout.write("Not clean — fix the errors above, or lower their severity in conventions.json.\n");
      return 1;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof ReferenceError || err instanceof SyntaxError ? "internal" : "config"}  ${err.message}\n`);
    return 2;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main());
