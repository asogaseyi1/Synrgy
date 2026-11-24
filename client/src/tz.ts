/**
 * Convert between UTC instants and `<input type="datetime-local">` values
 * expressed in the organization's time zone (not the browser's).
 */

function wallClockParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), mo: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Milliseconds the zone is ahead of UTC at this instant. */
function offsetMs(date: Date, timeZone: string) {
  const p = wallClockParts(date, timeZone);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** ISO instant → "YYYY-MM-DDTHH:mm" in `timeZone`. */
export function toZonedInput(iso: string | Date | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const p = wallClockParts(new Date(iso), timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

/** "YYYY-MM-DDTHH:mm" in `timeZone` → ISO instant. Handles DST shifts. */
export function fromZonedInput(value: string, timeZone: string): string {
  const [date, time] = value.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let result = guess - offsetMs(new Date(guess), timeZone);
  const corrected = guess - offsetMs(new Date(result), timeZone);
  if (corrected !== result) result = corrected;
  return new Date(result).toISOString();
}
