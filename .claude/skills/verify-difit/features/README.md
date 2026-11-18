# Feature map

Each file says what the feature is, how a user reaches it, how to drive it with `harness.sh`, and what proves it works.

| Feature                                 | Covers                                                             |
| --------------------------------------- | ------------------------------------------------------------------ |
| [review-server](review-server.md)       | Starting a review on a commit, a range, the working tree or stdin  |
| [comments](comments.md)                 | `difit comment add`, `get`, `wait` and `resolve`                   |
| [fixup-review](fixup-review.md)         | Answering a thread with a fixup commit, approving or rejecting it, and folding |
| [reword](reword.md)                     | Changing a commit's message, which rewrites the history at once    |
| [reorder](reorder.md)                   | Dragging a commit to a new place, which rewrites the history at once |
| [release-package](release-package.md)   | Installing the packed tarball and running it                       |
| [symbol-index](symbol-index.md)         | Building a SCIP index and answering a lookup from it               |

When a feature's behavior changes, update its file in the same change.
