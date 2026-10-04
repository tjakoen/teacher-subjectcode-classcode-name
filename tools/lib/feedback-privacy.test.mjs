import test from "node:test";
import assert from "node:assert/strict";
import { splitReviewedFeedback, validateStudentFeedback, reviewedRubricBreakdown } from "./gradebook.mjs";

test("empty notes stay empty and valid drafts keep the private section separate", () => {
  assert.deepEqual(splitReviewedFeedback(""), { student: "", instructor: "" });
  assert.deepEqual(splitReviewedFeedback("Useful feedback.\n---\n# Instructor\nProposed total: 9/10"), {
    student: "Useful feedback.\n", instructor: "# Instructor\nProposed total: 9/10",
  });
  assert.equal(splitReviewedFeedback("Useful feedback.\r\n---\r\n# Instructor").student, "Useful feedback.\n");
});
test("missing or malformed privacy boundaries stop delivery", () => {
  for (const note of ["Useful feedback.\n# Instructor\nProposed total: 9/10", "Useful feedback.\n--- accidental continuation\n# Instructor"]) {
    assert.throws(() => splitReviewedFeedback(note), /separator/);
  }
  assert.throws(() => splitReviewedFeedback("Useful feedback.\nProposed total: 9/10\n---\nPrivate review"), /Private feedback/);
});
test("private labels stay private with emphasis and list prefixes", () => {
  for (const prose of ["AI-authored likelihood: high", "**Proposed total:** 9/10", "_AI-authored likelihood_: high", "- AI-authored likelihood: high", "1. **Proposed total:** 9/10"]) {
    assert.throws(() => validateStudentFeedback(prose), /Private feedback/);
  }
  assert.equal(validateStudentFeedback("Your AI project has a clear interface."), "Your AI project has a clear interface.");
});
test("breakdowns keep explicit rubric allocations and exclude private commentary", () => {
  assert.equal(reviewedRubricBreakdown("- Code organization: 2/3. Clear functions.\n- AI-authored likelihood: high\n- prior override: 64/100\n- The sourceless draft needs review."), "- Code organization: 2/3. Clear functions.");
  assert.equal(reviewedRubricBreakdown("- Transition on :hover is smooth: 2/2"), "- Transition on :hover is smooth: 2/2");
  assert.equal(reviewedRubricBreakdown("- **Code organization:** 2/3"), "- **Code organization:** 2/3");
});
