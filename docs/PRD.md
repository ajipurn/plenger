# plenger - Product Requirements Document

**Versi:** 0.1 | **Tanggal:** 19 September 2026 | **Target:** MVP lokal, single-user

plenger adalah nama produk. Dokumen ini menetapkan kebutuhan produk; SPEC.md menetapkan kontrak implementasi. Semua angka kualitas dan kinerja di bawah merupakan target penerimaan, bukan hasil benchmark yang sudah tercapai.

## 1. Ringkasan produk

plenger adalah tool keamanan yang dipasang sebagai developer tool untuk sebuah project. Tool membaca repository, memetakan komponen dan hubungan yang didukung, menggabungkan hasil scanner, lalu menjalankan pengujian aplikasi LLM pada target yang disetujui. Dashboard lokal menghubungkan temuan dengan lokasi kode, skenario risiko, bukti, dan hasil pengujian ulang.

**Janji utama:** developer dapat menelusuri satu masalah dari kode, ke skenario pengujian, ke bukti, lalu ke verifikasi perbaikan. Produk tidak menjanjikan menemukan semua kerentanan, membuktikan keamanan menyeluruh, atau memberikan sertifikasi OWASP.

**Peran Jev:** modul keputusan opsional untuk triase dan penilaian semantik yang sempit. Jev tidak menjadi parser repository, pembuat izin eksekusi, atau penentu tunggal kerentanan. API TypeSafe menerima state dan pertanyaan terstruktur; Choice, Score, dan Noul mempunyai bentuk keluaran berbeda. [R02, R03]

## 2. Masalah dan pengguna

Pengguna awal adalah developer atau engineer keamanan yang mengelola aplikasi Python/FastAPI dengan endpoint LLM, retrieval dokumen, atau tool agent. Satu pengguna lokal dapat membuka beberapa project, tetapi data dan persetujuan setiap project harus terpisah.

Masalah yang ingin diselesaikan adalah hasil scanner yang terpisah, kurangnya konteks aliran data, sulitnya membedakan dugaan dari bukti, dan pengujian LLM yang tidak mengikuti izin serta fungsi aplikasi. Pengguna juga perlu mengetahui bagian yang belum dianalisis agar dashboard tidak memberikan rasa aman palsu.

| Persona | Pekerjaan utama | Hasil yang dibutuhkan |
| --- | --- | --- |
| Developer aplikasi AI | Menilai perubahan sebelum merge atau rilis | Temuan dengan lokasi, dampak, dan cara menguji perbaikan |
| Engineer keamanan | Menjalankan pengujian berizin | Scope, bukti, cakupan, dan audit aktivitas |
| Tech lead | Memprioritaskan perbaikan | Severity dan kekuatan bukti yang terpisah, tanpa skor semu |

## 3. Keputusan produk

| Area | Keputusan MVP |
| --- | --- |
| Distribusi | CLI dengan aset dashboard yang sudah dibangun; tidak perlu server Node.js untuk memakai UI |
| Pengoperasian | Local-first; analisis statis berjalan tanpa API key dan tanpa egress jaringan |
| Stack project | Python/FastAPI; pola eksplisit OpenAI Agents untuk inventaris, bukan jaminan memahami semua agent |
| Pengujian runtime | HTTP JSON melalui kontrak target terkonfigurasi; tracing dan fixture tambahan untuk klaim yang membutuhkannya |
| Jev | Adapter nyata melalui API, nonaktif secara default; mode offline menggunakan evaluator deterministik dan peninjauan manual |
| Baseline risiko | OWASP LLM Top 10 edisi 2025, dengan taxonomy dan paket tes yang berversi |
| Penyimpanan | Database lokal dan artefak yang sudah disamarkan; tidak ada sinkronisasi cloud otomatis |
| Pengujian aktif | Terpisah dari scan; hanya setelah scope dan rencana disetujui |
| Integrasi | Semgrep CE, OSV-Scanner, Trivy secret scanning, serta adapter Promptfoo yang dibatasi |
| Pengembangan lanjut | Agentic Radar sebagai pengayaan opsional; Strix dan pentest web umum bukan jalur kritis MVP |

Semgrep membedakan lisensi engine dan rules; pemilihan rules harus dicatat secara terpisah. OSV mendukung pemeriksaan terhadap database lokal, sedangkan Trivy menyediakan pemindaian secret. [R09, R10, R11] Promptfoo mendokumentasikan pemetaan OWASP LLM, tetapi jalur generasi, grading, telemetry, dan layanan hosted memerlukan kontrol terpisah. [R06, R07]

## 4. Sasaran dan bukan sasaran

### 4.1 Sasaran

Produk harus mempercepat investigasi tanpa mengorbankan keterlacakan. Pengguna harus dapat menjalankan analisis read-only, melihat keterbatasan pemetaan, menguji kebijakan aplikasi LLM dengan data sintetis, dan mengekspor hasil yang dapat ditinjau ulang.

Temuan harus tetap dapat diperiksa ketika Jev tidak tersedia. Engine pihak ketiga yang tidak terpasang, gagal, atau terhalang jaringan harus terlihat sebagai kemampuan yang tidak tersedia; kondisi tersebut tidak boleh diterjemahkan sebagai tidak adanya kerentanan.

### 4.2 Bukan sasaran MVP

MVP tidak menyediakan pentest otonom ke internet, eksploitasi produksi, pemindaian jaringan luas, load test yang merusak, perbaikan kode otomatis, eksekusi script repository, pelatihan model, pemindaian bobot model, SSO, RBAC multi-user, atau layanan SaaS multi-tenant. Pemeriksaan IaC/container umum, Git history secrets, pemetaan lintas bahasa, serta integrasi issue tracker menjadi pengembangan berikutnya.

Multi-tenant pada pengujian berarti memeriksa isolasi tenant aplikasi target; itu tidak berarti plenger sendiri sudah menjadi platform multi-tenant.

## 5. Alur penggunaan utama

### 5.1 Onboarding dan scan lokal

Pengguna menjalankan `plenger init .`, meninjau file yang dikecualikan, lalu menjalankan `plenger doctor` dan `plenger scan --project . --profile baseline`. Init membuat konfigurasi tanpa menjalankan aplikasi, memasang dependency, mengunduh image, atau menghubungi penyedia model.

Dashboard dibuka dengan `plenger serve --project .`. Pengguna memasangkan sesi browser melalui kode sekali pakai yang ditampilkan di terminal. Overview memperlihatkan engine yang tersedia, snapshot repository, temuan, dan bagian yang belum diperiksa.

### 5.2 Pengujian aplikasi LLM

Pengguna mendaftarkan endpoint staging/local, akun uji, kebijakan yang diharapkan, dan data sintetis. `plenger plan` membuat daftar kasus, scope jaringan, estimasi permintaan, dan kebutuhan observabilitas. Pengguna menyetujui hash rencana dan batas anggaran; hanya rencana yang sama boleh dieksekusi.

Untuk pengujian lintas tenant, pengguna menyediakan dua identitas uji dan fixture dokumen yang terisolasi. Tanpa fixture atau bukti runtime yang diperlukan, hasil menjadi blocked atau inconclusive, bukan pass.

### 5.3 Triase dengan Jev

Pengguna mengaktifkan Jev dan menyetujui pengiriman jenis bukti tertentu. Sistem menyamarkan data, mengirim state minimum, menyimpan versi model serta rubric, dan menampilkan rekomendasi. Timeout atau jawaban tidak valid menghasilkan abstain/needs_review. Jev tidak otomatis menutup, menurunkan severity, atau mengonfirmasi temuan.

### 5.4 Perbaikan dan regresi

Developer memperbaiki aplikasi di luar plenger, membuat snapshot baru, kemudian menjalankan ulang tes yang relevan. Hasil lama tidak ditimpa. Dashboard membedakan new, recurring, not_observed, resolved, dan reopened; resolved memerlukan bukti pengujian ulang yang sebanding atau verifikasi manual beralasan.

## 6. Kebutuhan fungsional

Semua kebutuhan FR berikut adalah P0 untuk rilis MVP lengkap. Tahap awal boleh mengirim bagian yang lebih kecil dengan label fitur yang jujur. Detail pengujian AC tercantum dalam TRACEABILITY.md.

| ID | Kebutuhan | Kriteria penerimaan ringkas |
| --- | --- | --- |
| FR01 | Init, konfigurasi, dan diagnosis | Tidak mengeksekusi repository; konfigurasi invalid ditolak; AC01 |
| FR02 | Peta komponen dan relasi | Lokasi kode dan provenance setiap node/edge; unsupported terlihat; AC02 |
| FR03 | Pemeriksaan SAST | Adapter Semgrep dan rules terkurasi; kegagalan tidak menjadi scan bersih; AC03 |
| FR04 | Dependency vulnerability scan | OSV offline dan umur database terlihat; dependency tidak ter-resolve dilaporkan; AC04 |
| FR05 | Secret scanning | Secret disamarkan sebelum persistensi; tidak diuji validitasnya ke layanan asli; AC05 |
| FR06 | Normalisasi dan korelasi | Satu temuan bisa memiliki banyak bukti; deduplikasi konservatif; AC06 |
| FR07 | Rencana dan persetujuan aktif | Scope/hash/anggaran/masa berlaku terikat; perubahan membatalkan izin; AC07 |
| FR08 | Runner pengujian terbatas | Allowlist, budget, timeout, isolasi, dan pembatalan; AC08-AC09 |
| FR09 | Cakupan OWASP 2025 | Seluruh 10 kategori terlihat, termasuk yang belum diuji; AC10 |
| FR10 | Adapter Jev dan evaluator | Parsing typed, sanitasi, abstain, dan jejak keputusan; AC11-AC12 |
| FR11 | Dashboard lokal | Sesi aman, graph, temuan, coverage, dan detail run; AC13 |
| FR12 | Riwayat dan lifecycle | Snapshot, pembandingan, suppressions beralasan dan kedaluwarsa; AC14 |
| FR13 | Ekspor dan CI | JSON/HTML tersamarkan, exit code membedakan pelanggaran dan error; AC15 |
| FR14 | Kebijakan data dan koneksi | Offline core teruji; hosted use opt-in; AC16 |
| FR15 | Bukti yang dapat ditelusuri | Hash, lokasi, asal, versi, dan prasyarat klaim tersimpan; AC17 |
| FR16 | Pemulihan dan akuntansi run | Crash menjadi interrupted; tidak replay otomatis request aktif; AC18 |
| FR17 | Kontrak integrasi | Versi engine, lisensi, format hasil, dan compatibility test; AC19 |
| FR18 | Demo dan validasi | Fixture vulnerable/fixed dan mock target berlabel eksplisit; AC20-AC24 |

## 7. Cakupan OWASP LLM 2025

Nama kategori mengikuti OWASP LLM Top 10 2025. Kolom cakupan adalah keputusan produk, bukan klaim bahwa satu tes mewakili seluruh kategori. [R01]

| Kategori | Cakupan MVP | Bukti/prasyarat |
| --- | --- | --- |
| LLM01 Prompt Injection | Tes direct/indirect yang disetujui | Kebijakan aplikasi; fixture retrieval untuk jalur indirect |
| LLM02 Sensitive Information Disclosure | Penanda rahasia dan data pribadi sintetis | Inventaris marker dan pemeriksaan respons/log yang relevan |
| LLM03 Supply Chain | Dependency scan dan inventaris artefak AI | Lockfile, sumber model/dataset; integritas model tetap manual |
| LLM04 Data and Model Poisoning | Checklist dan pencatatan bukti pipeline | Tidak melakukan poisoning training atau mengklaim deteksi otomatis |
| LLM05 Improper Output Handling | Kandidat statis pada sink yang didukung | Konteks sanitasi; konfirmasi runtime bukan cakupan default |
| LLM06 Excessive Agency | Tes izin tool pada mock/staging | Kebijakan izin, log tool, dan ledger efek samping |
| LLM07 System Prompt Leakage | Pemeriksaan marker sensitif pada prompt uji | Penyalinan instruksi umum saja bukan bukti dampak kritis |
| LLM08 Vector and Embedding Weaknesses | Tes retrieval lintas tenant | Dua identitas, dokumen sintetis, trace retrieval bila diperlukan |
| LLM09 Misinformation | Evaluasi dataset acuan kecil | Ground truth dan referensi disediakan pemilik aplikasi |
| LLM10 Unbounded Consumption | Tinjauan limit dan tes batas berbiaya terbatas | Anggaran runner; bukan stress test atau sertifikasi bebas DoS |

Prioritas suite aktif pertama adalah LLM01, LLM02, LLM06, dan LLM08 karena
keempatnya memiliki fixture observer-backed. LLM03, LLM04, LLM05, LLM07, LLM09,
dan LLM10 juga memiliki fixed response-marker contracts untuk coverage bounded;
itu bukan pengganti ground truth atau verifikasi produksi. OWASP menegaskan
system prompt bukan tempat menyimpan rahasia atau pengganti kontrol keamanan. [R12]

Coverage dihitung per assertion yang berlaku pada profile berversi. Dashboard menampilkan jumlah planned, blocked, executed, inconclusive, error, dan belum diuji. Tidak ada persentase tunggal yang diberi label keamanan atau kepatuhan.

## 8. Dashboard dan pengalaman interaksi

### 8.1 Overview

Tampilkan snapshot, waktu pemeriksaan, risiko prioritas, keterbatasan, kondisi adapter, umur database vulnerability, dan indikator hosted calls. Jangan menampilkan data demo sebagai hasil pengguna atau memakai angka statis untuk temuan, token, atau biaya.

### 8.2 Code & AI Map

Pengguna dapat menyaring endpoint, fungsi, pemanggilan model, retrieval, tool, dan store. Edge berlabel observed_static, inferred, atau observed_runtime. Memilih edge membuka bukti; pola dynamic yang tidak terpecahkan menjadi unknown, bukan hubungan yang dikarang.

### 8.3 Findings

Halaman detail memisahkan severity, validation_state, status penanganan, dan rekomendasi evaluator. Tampilkan file/baris, bukti tersamarkan, kondisi eksploitasi, kategori, serta langkah pengujian ulang. Korelasi beberapa scanner tidak otomatis berarti bukti runtime.

### 8.4 LLM Tests & Runs

Tampilkan rencana sebelum eksekusi, izin yang aktif, konsumsi request, status tiap assertion, dan tombol cancel. Istilah fail berarti pelanggaran teramati; error/inconclusive tidak boleh ditampilkan sebagai fail keamanan maupun pass.

### 8.5 Evidence & Settings

Pengguna dapat melihat sumber artefak, retention, koneksi yang diizinkan, serta data minimum yang akan dikirim ke evaluator. Repository, output scanner, dan respons target harus ditampilkan sebagai data, bukan HTML atau instruksi yang boleh dieksekusi.

## 9. Target kualitas dan kinerja

Target ini berlaku pada fixture dan lingkungan benchmark yang tercatat, tidak diekstrapolasi menjadi probabilitas keamanan project nyata.

| Metrik | Target rilis MVP |
| --- | --- |
| Kelengkapan jejak bukti | 100% temuan punya source, snapshot, dan reference bukti yang valid |
| Isolasi jaringan | 0 koneksi keluar yang berhasil di luar policy dalam test suite jaringan |
| Kebocoran secret fixture | 0 raw secret fixture pada DB, log, UI, ekspor, dan request evaluator |
| Pemetaan pada grammar yang didukung | Precision >=95% dan recall >=90% pada minimal 50 fixture berlabel |
| Recall scanner pada fixture | Semua seeded positive yang tercakup rule terdeteksi; negative controls ikut dilaporkan |
| Ketepatan status tes | 100% kasus error/timeout/trace hilang tidak menjadi pass atau confirmed |
| Jev | Confusion matrix, abstention, latency, dan biaya dilaporkan pada >=120 kasus berlabel; belum ada auto-dismiss |
| Startup UI | p95 <=5 detik setelah instalasi, di laptop referensi 4 core/16 GB/SSD |
| Scan statis hangat | p95 <=120 detik untuk 10.000 LOC yang didukung; tanpa download/model calls |
| Respons daftar temuan | p95 <=500 ms untuk 5.000 temuan, page size <=100 |
| Cancel | Tidak ada dispatch baru setelah cancel diakui; worker dihentikan <=5 detik pada fixture |

Pengukuran kinerja memakai minimal 20 pengulangan, mencatat cold/warm state, OS, CPU, RAM, versi engine, dan ukuran input. Gagal memenuhi target kinerja dilaporkan sebagai hasil, bukan disembunyikan dengan mengurangi cakupan.

## 10. Privasi dan batas operasional

Repo tidak boleh otomatis dijalankan, di-build, atau diinstal dependency-nya. Pembacaan dilakukan terhadap snapshot tervalidasi. File terlalu besar, symlink keluar root, binary, serta format tidak didukung dilaporkan sebagai skipped.

Semua pengujian aktif harus mempunyai pemilik target, lingkungan yang dinyatakan local/staging, scope endpoint, masa izin, dan batas penggunaan. Pernyataan pengguna adalah catatan otorisasi, bukan pembuktian kepemilikan target. plenger tidak memiliki mode aktif produksi pada MVP.

Anggaran request yang keluar melalui gateway dapat ditegakkan; biaya internal target hanya dapat dibatasi jika target mendukung limit dan telemetry yang terpercaya. UI harus membedakan estimasi biaya, konsumsi yang dilaporkan, dan biaya yang belum diketahui.

Raw artifacts tidak dipersistenkan pada MVP. Artefak tersamarkan tetap dapat mengandung informasi bisnis sensitif; penyimpanan lokal dan ekspor tidak boleh diperlakukan sebagai data publik.

## 11. Tahap implementasi dan exit gate

| Tahap | Hasil yang harus tersedia | Gate sebelum lanjut |
| --- | --- | --- |
| M0 Fondasi | ADR, schema, policy, fixture, sesi lokal, kerangka CLI/API/UI | Kontrak dan threat model diuji; build dasar berjalan |
| M1 Vertical slice | Init -> snapshot -> graph -> temuan deterministik -> UI -> ekspor | Demo nyata tanpa API key; tidak ada UI hasil palsu |
| M2 Scanner | Semgrep, OSV offline, Trivy; deduplikasi dan source attribution | Contract tests serta minimal satu integration test tiap engine |
| M3 Pengujian LLM | Plan/approve/run; fixed suite; gateway, budget, traces; adapter Promptfoo | Tes safety dan vulnerable/fixed target lulus |
| M4 Jev | Adapter API, rubric, evaluasi offline/mock, consent dan abstain | Tidak mengubah otorisasi; live smoke test terpisah bila key tersedia |
| M5 Workflow | Riwayat, pembandingan, suppressions, ekspor dan CI | Regression suite dan exit code terverifikasi |
| M6 Hardening | Packaging, instalasi bersih, benchmark, review keamanan | AC01-AC24 lulus; status live integration dinyatakan jujur |

MVP lengkap berarti M0-M6 selesai. Agentic Radar, Strix, generasi adaptif, SSO, SARIF, dan dukungan bahasa tambahan tidak boleh diam-diam menjadi syarat M1.

## 12. Risiko produk dan mitigasi

| Risiko | Mitigasi dan indikator |
| --- | --- |
| Terlalu banyak integrasi sejak awal | Vertical slice lebih dulu; setiap adapter mempunyai capability manifest |
| False confidence dari AI | Evidence-first, abstain, review manual; confidence tidak ditafsirkan sebagai validitas temuan |
| Drift format atau lisensi engine | Pin versi/hash, kontrak fixture, dependency/license ledger |
| Biaya pengujian tidak terkendali | Gateway, reservasi request, limit target, dan penghentian eksplisit |
| Data repository keluar tanpa disadari | Offline default, consent granular, sanitasi, dan test egress |
| Tidak semua relasi dapat dipetakan | Supported-pattern matrix, unknown edges, tidak ada klaim whole-program analysis |
| Demo disalahartikan sebagai perlindungan nyata | Banner fixture; hasil nyata terpisah; benchmark bukan jaminan produksi |

## 13. Keputusan terbuka yang tidak menghambat fondasi

Nama final, lisensi kode plenger, strategi monetisasi, dan sistem issue tracking ditentukan sebelum publikasi. Default engineering adalah backend Python, UI React/TypeScript, single-user lokal, serta bahasa UI Indonesia dengan string siap dilokalisasi. Platform prioritas adalah Linux dan macOS; Windows native belum menjadi gate MVP.

TypeSafe melalui API adalah integrasi hosted yang opsional; tidak ada asumsi bobot Jev tersedia untuk distribusi lokal. Referensi model harus dipin dan perubahan dievaluasi kembali. [R04]

## 14. Definition of Done

Rilis memenuhi FR01-FR18 dan AC01-AC24, mempunyai test evidence, dependency lock, migration test, dokumentasi instalasi, threat model, dan daftar keterbatasan. Semua tombol P0 mengakses backend nyata. Fitur belum tersedia dinonaktifkan dengan alasan. Tidak ada data contoh yang menyamar sebagai scan pengguna, live test fiktif, klaim 100% coverage, atau perbaikan otomatis tanpa persetujuan.

Referensi eksternal terpusat di SOURCES.md; persyaratan produk dan angka target adalah keputusan desain plenger.
