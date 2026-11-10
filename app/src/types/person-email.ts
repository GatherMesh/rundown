// Match the email address syntax accepted by the People API.
export function validPersonEmail(value: string) {
  return /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/.test(
    value.trim(),
  );
}
