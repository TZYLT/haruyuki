/**
 * The structured subcommand vocabulary that completion and dispatch share
 * (T-02, 47-2 §2.3).
 *
 * W-01 freezes the shape only: the data table (dream / schedule / topic and the
 * enumerable options the registry already prints) is **W-03's** to fill in. One
 * table, consumed by both the completion resolver and the command dispatch, is
 * what stops the two from drifting the way the hand-written switch copies did.
 *
 * A spec describes one word the user can type after its parent. `children` is
 * the next level; a leaf either ends the line or takes a free-text argument
 * (`textArg`) — never both, because a word cannot be both a fixed subcommand and
 * arbitrary text.
 */

export interface SubcommandSpec {
  /** The literal word the user types (`list`, `remove`, …). */
  name: string;
  /** One-line description, shown beside the completion candidate. */
  desc: string;
  /**
   * Syntax hint for the argument that follows this word, without the leading
   * subcommand (`[name]`, `<provider>`). Purely display: the resolver does not
   * parse it.
   */
  args?: string;
  /** Enumerable values accepted at this position (rendered as dim candidates). */
  options?: readonly string[];
  /**
   * This subcommand takes free text as its last argument. Text is not completed;
   * the popup closes once the subcommand word is settled.
   */
  textArg?: boolean;
  /** Next level of fixed subcommands (three-level commands such as `note remove`). */
  children?: readonly SubcommandSpec[];
}
