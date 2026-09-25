// Same-origin API client; errors map stable server codes to Indonesian messages.

type ApiErrorEnvelope = {code?: unknown; request_id?: unknown};

export const API_ERROR_MESSAGES: Record<string, string> = {
  active_runner_unavailable:
    'Pengujian aktif tidak tersedia di host ini. Gunakan macOS atau Linux dengan dukungan Unix socket.',
  active_runner_failed: 'Pengujian aktif gagal dimulai. Periksa log server, lalu coba lagi.',
  assessment_unavailable: 'Riwayat assessment tidak tersedia karena data lokal perlu diperiksa.',
  assessment_consent_unavailable:
    'Consent hosted belum dapat dimuat. Periksa konfigurasi lokal, lalu coba lagi.',
  assessment_consent_not_found:
    'Consent hosted tidak ditemukan. Muat ulang status consent, lalu coba lagi.',
  approval_expired_or_used: 'Approval sudah kedaluwarsa atau pernah digunakan. Buat approval baru.',
  approval_not_found: 'Approval tidak ditemukan. Tinjau plan, lalu buat approval baru.',
  authorization_acknowledgment_required: 'Centang persetujuan scope sebelum menyetujui plan.',
  body_too_large: 'Data yang dikirim terlalu besar. Kurangi input, lalu coba lagi.',
  cancel_not_supported_for_static_run: 'Run scan statis tidak dapat dibatalkan dari dashboard.',
  config_changed: 'Konfigurasi workspace berubah. Muat ulang hasil analisis, lalu buat plan baru.',
  csrf_required: 'Sesi keamanan tidak cocok. Muat ulang halaman, lalu coba lagi.',
  finding_not_found: 'Temuan tidak ditemukan pada run ini. Muat ulang hasil analisis.',
  finding_revision_conflict_or_not_found:
    'Temuan berubah atau tidak ditemukan. Muat ulang hasil analisis, lalu coba lagi.',
  hosted_consent_required: 'Berikan consent hosted sebelum menjalankan assessment Jev.',
  hosted_consent_acknowledgment_required:
    'Consent hosted memerlukan persetujuan eksplisit melalui kontrol consent.',
  idempotency_key_required:
    'Permintaan belum memiliki kunci idempotensi. Muat ulang halaman, lalu coba lagi.',
  idempotency_conflict:
    'Permintaan dengan kunci yang sama memiliki input berbeda. Muat ulang halaman, lalu coba lagi.',
  internal_error: 'Server mengalami kesalahan. Periksa log server, lalu coba lagi.',
  invalid_approval: 'Data approval tidak valid. Periksa actor dan masa berlaku, lalu coba lagi.',
  invalid_event_cursor: 'Posisi riwayat run tidak valid. Muat ulang riwayat.',
  invalid_event_pagination: 'Halaman riwayat run tidak valid. Muat ulang riwayat.',
  invalid_finding_cursor: 'Penanda halaman temuan sudah tidak valid. Terapkan filter lagi.',
  invalid_finding_filter:
    'Filter temuan tidak dikenali. Periksa nilai yang dipilih, lalu coba lagi.',
  invalid_graph_filter:
    'Filter peta tidak valid. Periksa jenis atau path sumbernya, lalu coba lagi.',
  invalid_pagination: 'Halaman yang diminta tidak valid. Muat ulang data, lalu coba lagi.',
  invalid_plan: 'Scope plan tidak valid. Periksa target, path, case, dan budget.',
  invalid_request: 'Input belum sesuai format. Periksa nilai yang dimasukkan, lalu coba lagi.',
  invalid_host: 'Akses harus melalui alamat plenger yang tersedia di terminal.',
  invalid_origin: 'Asal halaman tidak diizinkan. Buka dashboard dari alamat plenger.',
  invalid_workspace_or_config:
    'Konfigurasi workspace tidak valid. Jalankan doctor, lalu coba lagi.',
  not_found: 'Data yang diminta tidak ditemukan. Muat ulang hasil analisis, lalu coba lagi.',
  origin_required: 'Permintaan ini harus berasal dari dashboard plenger.',
  pairing_invalid_or_expired:
    'Kode pairing salah, kedaluwarsa, atau sudah mencapai batas percobaan. Periksa terminal untuk kode baru.',
  plan_changed: 'Scope plan sudah berubah. Buat plan baru sebelum menyetujuinya.',
  plan_not_approved: 'Plan belum disetujui. Tinjau scope, lalu setujui plan sekali pakai.',
  plan_not_approvable: 'Plan ini tidak lagi dapat disetujui. Cabut plan, lalu buat plan baru.',
  plan_already_approved:
    'Plan ini masih memiliki approval aktif. Gunakan approval tersebut atau tunggu hingga kedaluwarsa.',
  plan_not_found: 'Plan tidak ditemukan. Muat ulang hasil analisis, lalu buat plan baru.',
  plan_not_found_or_closed:
    'Plan sudah ditutup atau tidak ditemukan. Muat ulang hasil analisis, lalu buat plan baru.',
  plan_prerequisite_failed:
    'Prasyarat plan belum terpenuhi. Periksa snapshot dan scope, lalu buat plan baru.',
  project_worker_busy:
    'Worker proyek sedang menjalankan pemeriksaan lain. Tunggu sampai selesai, lalu coba lagi.',
  queue_capacity: 'Antrean pengujian penuh. Tunggu sebentar, lalu coba lagi.',
  run_not_found: 'Run tidak ditemukan. Muat ulang riwayat pemeriksaan.',
  run_not_queued: 'Run sudah tidak berada di antrean. Muat ulang status run.',
  session_required:
    'Sesi berakhir atau kode tidak valid. Periksa terminal untuk kode pairing baru.',
  staging_base_url_required: 'Target staging memerlukan base URL HTTPS publik.',
  target_address_not_loopback: 'Target lokal harus ter-resolve ke alamat loopback.',
  target_address_not_public: 'Target staging harus ter-resolve hanya ke alamat publik.',
  target_dns_failed: 'Nama host target tidak dapat di-resolve. Periksa base URL, lalu coba lagi.',
  strict_cost_guard_requires_target_control:
    'Target belum menyediakan kontrol biaya yang diperlukan untuk guard ketat.',
  ui_assets_not_built: 'Aset dashboard belum tersedia. Jalankan build UI, lalu muat ulang serve.',
};

export class ApiError extends Error {
  readonly code: string | null;
  readonly status: number;
  readonly requestId: string | null;

  constructor(status: number, code: string | null, requestId: string | null) {
    const message =
      code && API_ERROR_MESSAGES[code]
        ? API_ERROR_MESSAGES[code]
        : status === 401
          ? API_ERROR_MESSAGES.session_required
          : 'Data belum dapat dimuat. Periksa log server, lalu coba lagi.';
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export async function request<T = any>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch('/api/v1/' + path, options);
  if (!response.ok) {
    let payload: ApiErrorEnvelope = {};
    try {
      payload = (await response.json()) as ApiErrorEnvelope;
    } catch {
      // Keep the safe status-based fallback when the response is not JSON.
    }
    const code = typeof payload.code === 'string' ? payload.code : null;
    const requestId = typeof payload.request_id === 'string' ? payload.request_id : null;
    throw new ApiError(response.status, code, requestId);
  }
  return (await response.json()) as T;
}
