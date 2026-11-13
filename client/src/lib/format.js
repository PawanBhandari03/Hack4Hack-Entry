/** Formatting helpers shared by pages (kept out of component files for React fast refresh). */

export const tzLabel = (tz) => {
  try {
    const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return `${tz.split('/').pop().replace(/_/g, ' ')} (${off})`;
  } catch {
    return tz;
  }
};

/** All IANA timezones the browser knows, always including UTC (some browsers omit it). */
export const TIMEZONES = (() => {
  let list = [];
  try {
    list = Intl.supportedValuesOf('timeZone');
  } catch {
    list = ['Asia/Kolkata', 'Europe/London', 'America/New_York'];
  }
  return list.includes('UTC') ? list : ['UTC', ...list];
})();
