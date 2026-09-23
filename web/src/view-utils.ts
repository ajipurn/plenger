export type EngineState = {
  status: string;
  reason: string;
  version?: string;
  isolation?: string;
  age_days?: string;
};

export function snapshotWorkingTreeLabel(dirty: boolean | null | undefined): string {
  if (dirty === true) return 'berubah';
  if (dirty === false) return 'bersih';
  return 'tidak diketahui';
}

export function engineStateSummary(name: string, state: EngineState): string {
  const details: string[] = [];
  if (state.version) details.push(`versi ${state.version}`);
  if (state.isolation) details.push(`isolasi ${state.isolation}`);
  if (name === 'osv' && state.age_days !== undefined) {
    details.push(`umur database ${state.age_days} hari`);
  }
  return [state.status, state.reason, ...details].join(' · ');
}
