// Shared by the fake LS child and the gate-2 pressure test. Kept in its own
// module so the test can import the expected answer without executing the
// child's server bootstrap.
export const FAKE_LS_TEXT = 'PRESSURE-ANSWER-OK';
