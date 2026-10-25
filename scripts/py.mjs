// Runs a Python script with the backend venv's interpreter if it exists (laptop-only tools), else system python.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const venv = [join(root, "backend/.venv/Scripts/python.exe"), join(root, "backend/.venv/bin/python")].find(existsSync);
const r = spawnSync(venv ?? "python", process.argv.slice(2), { stdio: "inherit" });
process.exit(r.status ?? 1);
