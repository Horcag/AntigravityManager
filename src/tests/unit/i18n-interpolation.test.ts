import { describe, expect, it } from 'vitest';

import i18n from '@/localization/i18n';

/**
 * React escapes everything it renders. When i18next escapes as well, an
 * interpolated value carrying an HTML-special character reaches the user as
 * entities: the proxy tab showed `Last seen 8&#x2F;9&#x2F;2026` for a plain
 * `toLocaleString()` date, and an imported file name containing `&` would fare
 * the same way.
 */
describe('i18n interpolation', () => {
  it('passes interpolated values through without HTML escaping', () => {
    const rendered = i18n.t('proxy.mapping.recent_misses_last_seen', {
      time: '8/9/2026, 9:00:14 AM',
      lng: 'en',
    });

    expect(rendered).toBe('Last seen 8/9/2026, 9:00:14 AM');
  });

  it('leaves ampersands and quotes in a file name alone', () => {
    const rendered = i18n.t('proxy.mapping.transfer_preview_title', {
      file: `aliases & "backup".json`,
      lng: 'en',
    });

    expect(rendered).toContain(`aliases & "backup".json`);
  });
});
