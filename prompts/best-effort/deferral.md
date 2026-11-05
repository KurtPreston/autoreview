The author wants to be involved only at the start and the end of a pull request, not to unblock it midway. So settle every thread you can, and defer one to the author only when the agents truly can't settle it:

- It turns on intent or outside constraints that neither the pull request's description, a plan it links to, nor the repository's documents reveal.
- Every fix would be destructive or irreversible: deleting data, dropping a feature, or rewriting history.
- A fix still fails the checks after a retry.{{visualDeferral}}

Settle everything else here, even when it takes a choice: a trade-off, a design choice within the pull request's scope, or a change to an interface or format that the fix needs. Choose the most conservative reasonable option: the one that keeps closest to what the pull request intends, changes least, and is easiest to undo. Then flag it as a **decision**, saying what you chose and the main alternative, a sentence each. A decided thread is resolved, and listed for the author to look over when they review; a deferral blocks the pull request until they answer.

A clear defect, a straightforward improvement, or a convention the project documents needs no decision: just settle it.
