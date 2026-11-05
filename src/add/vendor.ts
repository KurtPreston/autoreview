// Copy the action into a repository, for organizations that only allow their own actions.
import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

/** The action's own files, relative to this tool's root. */
const PARTS = ["action.yml", "setup-git.sh", "package.json", "src", "prompts"];
const ROOT = new URL("../../", import.meta.url);

/**
 * Copy the action to `dir` in the repository, replacing an earlier copy, and return the
 * workflow's `uses:` for it. Rerun to update the copy.
 */
export async function vendor(repo: string, dir: string): Promise<string> {
  const target = join(repo, dir);
  await rm(target, { recursive: true, force: true });
  for (const part of PARTS) {
    await cp(new URL(part, ROOT), join(target, part), { recursive: true });
  }
  return `./${dir}`;
}
