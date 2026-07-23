export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  "email address is taken": "This email is already registered. <a href='/login' class='font-semibold text-indigo-300 hover:text-indigo-200 underline'>Sign in here</a>.",
  "That email address is taken": "This email is already registered. <a href='/login' class='font-semibold text-indigo-300 hover:text-indigo-200 underline'>Sign in here</a>.",
  "invalid code": "The verification code is invalid. Please check and try again.",
  "expired code": "The verification code has expired. Request a new code.",
  "verification code expired": "The verification code has expired. Request a new code.",
  "expired": "The verification code has expired. Request a new code.",
  "network error": "A network error occurred. Please check your connection and try again.",
  "google authentication failed": "Google sign-in failed. Please try again or use email sign-up.",
  "form_identifier_exists": "This email is already registered. <a href='/login' class='font-semibold text-indigo-300 hover:text-indigo-200 underline'>Sign in here</a>.",
};

export function humanizeAuthError(raw: string): string {
  return AUTH_ERROR_MESSAGES[raw] ?? raw;
}