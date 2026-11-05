import type { Forge } from "./forge.ts";
import type { Checkout } from "./git.ts";

/**
 * Whether a push of autoreview's own commit started this run. Only pushes count: a label
 * or ready-for-review event on the same head still deliberates.
 */
export async function ownPush(
  checkout: Checkout,
  head: string,
  event = process.env.AUTOREVIEW_EVENT,
): Promise<boolean> {
  return event === "synchronize" && (await checkout.isOwn(head));
}

/**
 * Start the configured workflows on the head branch after a run pushed fixes. Pushes made
 * with a workflow's own token start no workflows, so checks would otherwise never see the
 * fixes. A failure is logged, not thrown: the fixes are already pushed.
 */
export async function dispatchAfterPush(options: {
  forge: Forge;
  workflows: string[];
  branch: string | undefined;
  log: (message: string) => void;
}): Promise<void> {
  const { forge, workflows, branch, log } = options;
  if (workflows.length === 0 || !branch) {
    return;
  }
  if (!forge.dispatch) {
    log("this forge can't start workflows, so dispatch is skipped");
    return;
  }

  // Start each workflow in turn, carrying on past failures
  for (const workflow of workflows) {
    try {
      await forge.dispatch(workflow, branch);
      log(`started ${workflow} on ${branch}`);
    } catch (error) {
      log(`couldn't start ${workflow}: ${(error as Error).message}`);
    }
  }
}
