#!/usr/bin/env node
/**
 * Regenerate sim/assets.json: every upstream file the sim sidecar reads, at a
 * pinned commit, with its sha256. `microduck-mcp setup-sim` downloads exactly
 * this list from raw.githubusercontent.com and refuses anything that does not
 * hash to what is recorded here. Dev-only; needs git. Run after changing a pin:
 *
 *   node scripts/gen-sim-assets.mjs
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// What the sidecar needs, and the commits the port was verified against
// (CLAUDE.md "Sim transport"). `entry` is the file the sidecar is pointed at.
const SOURCES = [
  {
    role: "scene",
    repo: "pollen-robotics/microduck_rl",
    rev: "d424a0c899f6b33cbd3daeb279913134349c0b63",
    dir: "src/mjlab_microduck/robot/microduck",
    entry: "scene.xml",
  },
  {
    role: "policies",
    repo: "pollen-robotics/microduck",
    rev: "590b986bd8c0d50ae02cb3ea2f59c463b6828168",
    dir: "policies",
  },
];

// The versions the sim's fidelity numbers were measured with. Exact pins:
// a different MuJoCo is a different physics.
const PYTHON = "3.10";
const PACKAGES = ["mujoco==3.12.0", "onnxruntime==1.23.2", "numpy==2.2.6", "pillow==12.3.0"];

const git = (cwd, ...args) => execFileSync("git", args, { cwd, maxBuffer: 1 << 28 });

const work = mkdtempSync(join(tmpdir(), "sim-assets-"));
try {
  const sources = SOURCES.map((s) => {
    const dir = join(work, s.repo.split("/")[1]);
    git(work, "clone", "-q", "--filter=blob:none", "--no-checkout", `https://github.com/${s.repo}.git`, dir);
    git(dir, "fetch", "-q", "--depth", "1", "origin", s.rev);
    const files = git(dir, "ls-tree", "-r", "--name-only", s.rev, "--", s.dir)
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((path) => {
        const blob = git(dir, "show", `${s.rev}:${path}`);
        return {
          path: path.slice(s.dir.length + 1),
          size: blob.length,
          sha256: createHash("sha256").update(blob).digest("hex"),
        };
      });
    const total = files.reduce((n, f) => n + f.size, 0);
    console.error(`${s.repo}@${s.rev.slice(0, 7)} ${s.dir}: ${files.length} files, ${(total / 1e6).toFixed(1)} MB`);
    return { ...s, files };
  });
  const out = join(root, "sim", "assets.json");
  writeFileSync(out, JSON.stringify({ python: PYTHON, packages: PACKAGES, sources }, null, 1) + "\n");
  console.error(`wrote ${out}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
