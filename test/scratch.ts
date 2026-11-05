// Point temporary files at one directory per test file, removed when the file's tests end.
// Imported for its effect by tests that create temporary repositories or run agents.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const root = mkdtempSync(join(tmpdir(), "autoreview-test-"));
process.env.TMPDIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
