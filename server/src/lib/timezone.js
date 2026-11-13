/** True if `tz` is a valid IANA timezone name, e.g. "Asia/Kolkata". */
export function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Current UTC offset of an IANA timezone in minutes (Asia/Kolkata -> 330). */
export function utcOffsetMinutes(tz, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

/** Hours between two offsets on a 24h circle (UTC+12 and UTC-11 are 1h apart, not 23h). */
export function hoursApart(offsetA, offsetB) {
  const diff = Math.abs(offsetA - offsetB) / 60;
  return Math.min(diff, 24 - diff);
}
