// The identifiers the console makes. The gateway accepts 8 to 100 letters,
// digits, dots, dashes, colons or underscores, starting with a letter or a
// digit (^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$).
//
// A request id is born here for every request, so the audit log can tell a
// decision taken in the console from one taken on the site (§11.1). An
// idempotency key is born once per action (an approval, a submission) and
// sent again, unchanged, when that action is retried: the engine then
// answers with the outcome it saved instead of acting twice.

export const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,99}$/;

const random = (): string => globalThis.crypto.randomUUID();

export const newRequestId = (): string => `console:${random()}`;

export const newIdempotencyKey = (action: string): string => {
  const name = action.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 40) || "action";
  return `${name}:${random()}`;
};
