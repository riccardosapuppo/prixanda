// The session's CSRF token, held in the page's memory only (never in storage):
// the gateway gives it with the session and wants it back in X-CSRF-Token on
// every mutation, which a page of another site could not read.
let token: string | null = null;

export function setCsrfToken(next: string | null): void {
  token = next;
}

export function csrfToken(): string | null {
  return token;
}
