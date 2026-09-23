import {describe, expect, it} from 'vitest';
import {engineStateSummary, snapshotWorkingTreeLabel} from './view-utils';

describe('dashboard view helpers', () => {
  it('makes unknown Git state explicit', () => {
    expect(snapshotWorkingTreeLabel(true)).toBe('berubah');
    expect(snapshotWorkingTreeLabel(false)).toBe('bersih');
    expect(snapshotWorkingTreeLabel(null)).toBe('tidak diketahui');
    expect(snapshotWorkingTreeLabel(undefined)).toBe('tidak diketahui');
  });

  it('shows only relevant engine capability details', () => {
    expect(
      engineStateSummary('osv', {
        status: 'ready',
        reason: 'engine_completed',
        version: '2.6.0',
        isolation: 'docker_pinned',
        age_days: '2.5',
      }),
    ).toBe('ready · engine_completed · versi 2.6.0 · isolasi docker_pinned · umur database 2.5 hari');
    expect(
      engineStateSummary('semgrep', {status: 'unavailable', reason: 'missing_binary', age_days: '9'}),
    ).toBe('unavailable · missing_binary');
  });
});
