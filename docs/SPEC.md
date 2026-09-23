# plenger - Spesifikasi Teknis

**Versi:** 0.1 | **Tanggal:** 19 September 2026 | **Baseline:** PRD v0.1

Kata MUST berarti wajib untuk acceptance gate; SHOULD berarti pilihan default yang penyimpangannya memerlukan ADR. Ini adalah kontrak implementasi yang direncanakan, bukan dokumentasi aplikasi yang sudah tersedia. Penamaan API, perintah, dan schema di sini adalah milik plenger.

## 1. Arsitektur dan batas sistem

plenger menggunakan modular monolith: CLI, API lokal, scheduler, penyimpanan, policy engine, adapter, dan evaluator dipisahkan melalui interface di dalam satu codebase. UI adalah aplikasi web statis. Worker scanner dan runner pihak ketiga berada di sandbox terpisah; tidak ada microservices publik, Redis, atau graph database pada MVP.

```text
CLI / browser lokal
        |
        v
API + session + policy + scheduler
        |                    |
        v                    v
SQLite + redacted store    worker sandbox
        ^                    |
        |                    v
normalizer <--- evidence --- scanner / test runner
        ^
        |
trusted request broker ---> target / Jev (hanya dengan izin)
```

Broker adalah satu-satunya jalur permintaan aktif. Browser tidak memanggil Jev atau target langsung. Worker tidak mendapat API key penyedia, kredensial target asli, akses Docker socket, atau URL yang bisa ditentukan bebas oleh hasil model.

### 1.1 Stack yang dipilih

Backend memakai Python 3.12, FastAPI, Pydantic, SQLAlchemy, Alembic, Typer, dan httpx. UI memakai React, TypeScript, Vite, dan komponen graph; framework visual tidak boleh mengubah kontrak data. Database adalah SQLite dengan foreign keys aktif, WAL, busy timeout, dan transaksi singkat. Tooling kualitas: pytest, Ruff, mypy, Vitest, dan Playwright.

Versi dependency selain baseline Python ditetapkan melalui pemeriksaan kompatibilitas saat M0, lalu dikunci dalam lockfile. Jangan memilih tag latest untuk image/rules yang dipakai rilis. Linux adalah reference runtime untuk sandbox; macOS harus lulus capability tests sebelum mengaktifkan mode aktif. Init dan dashboard tetap tersedia ketika sandbox belum ada; scan yang membutuhkan isolasi menjadi unavailable, bukan turun diam-diam ke eksekusi tanpa isolasi.

### 1.2 Modul

| Modul | Tanggung jawab |
| --- | --- |
| workspace | Konfigurasi, project ID, inventaris file, snapshot metadata |
| graph | Parser Python, entity resolution terbatas, provenance relasi |
| adapters | Kontrak scanner, runner, capability dan version check |
| policy | Scope, consent, approval, budget, dan keputusan allow/deny deterministik |
| broker | Dispatch target/provider yang sudah diregistrasi, redaction dan accounting |
| runs | State machine, job lease, cancel, event dan recovery |
| findings | Normalisasi, korelasi, lifecycle dan evidence linkage |
| evaluators | Deterministic, manual dan Jev; tidak mempunyai execution authority |
| storage | SQLite, migration, retention dan redacted artifacts |
| api/ui/cli | Antarmuka yang memakai service layer yang sama |

## 2. Layout repository dan workspace

```text
plenger/
  pyproject.toml
  uv.lock
  src/plenger/
    api/ cli/ domain/ services/ storage/
    policy/ broker/ graph/ adapters/ evaluators/
  web/
  rules/owned/
  profiles/owasp-llm-2025/
  tests/unit/ tests/integration/ tests/security/ tests/e2e/
  fixtures/python/ fixtures/llm_targets/
  docs/adr/
```

Pada project yang dipindai, `plenger.yaml` adalah konfigurasi deklaratif yang boleh masuk Git setelah ditinjau. `.plenger/` memuat database, artefak tersamarkan, cache metadata, dan lock runtime; direktori ini MUST diabaikan Git. Init meminta izin sebelum mengubah `.gitignore` dan tidak menimpa file konfigurasi yang sudah ada. Secret berasal dari environment atau keychain; bukan dari YAML.

Temp staging memuat salinan file terpilih yang diperlukan scanner, dengan akses owner-only dan batas ukuran. Ini adalah material kerja sementara, bukan evidence store. Hapus saat job selesai atau saat startup recovery; jangan menjanjikan secure erase pada SSD. Raw laporan scanner diproses melalui pipe/memory atau tmpfs, disamarkan sebelum masuk penyimpanan permanen, dan tidak dimasukkan ke exception log.

File/direktori private menggunakan permission 0600/0700 pada platform yang mendukung. Database SQLite tidak dianggap terenkripsi; full-disk encryption menjadi rekomendasi deployment, bukan kemampuan yang diklaim produk. Raw evidence retention dan cloud sync tidak didukung pada MVP.

## 3. Konfigurasi dan manifest yang dapat dipercaya

`examples/plenger.example.yaml` adalah kontrak konfigurasi plenger, bukan konfigurasi asli Promptfoo. Pydantic model menggunakan extra=forbid, enum ketat, path terkanonisasi, dan batas panjang. Tolak YAML tags, object construction, duplicate keys, nesting/alias berlebihan, serta field yang mencoba menyediakan command atau kode executable.

Konfigurasi project adalah input tidak dipercaya. Izin hosted, approval, serta secret tidak boleh aktif hanya karena file repository menyatakannya. Consent efektif disimpan dalam database milik pengguna dan terikat dengan hash konfigurasi, project, provider, dan kelas data yang disetujui.

Konfigurasi efektif berasal dari defaults aman + konfigurasi project tervalidasi + consent lokal + manifest adapter yang dipin. Merge tidak boleh memperluas izin tanpa persetujuan baru. Environment tidak boleh mengubah target/scope secara tersembunyi; hanya secret reference yang diselesaikan saat dispatch.

Capability manifest adapter memuat name, adapter_version, engine_version, image_digest/binary_hash, license_ref, output_schema, supported_modes, supported_patterns, required_network, max_output_bytes, serta status verification. `unavailable`, `unsupported_version`, `blocked_by_policy`, dan `ready` adalah status berbeda.

## 4. Snapshot dan pemetaan codebase

### 4.1 Pengambilan input

Canonicalize root; jangan mengikuti symlink, membuka device/FIFO/socket, membaca path di luar root, atau mengekstrak archive. Default batas: 50.000 file, 2 MiB per file teks, dan 500 MiB total staging. Batas boleh dinaikkan pengguna secara eksplisit. Daftar skipped menyertakan alasan.

Default exclusions mencakup `.git`, `.plenger`, virtualenv, node_modules, build, vendor, binary, dan file kredensial. `.env*`/private key tidak masuk pemetaan atau snippet evaluator; pemindaian lokal secret pada file sensitif tersebut memerlukan include yang dipilih pengguna. Git history bukan cakupan MVP.

Snapshot memuat project_id, relative path, byte hash, ukuran, encoding, commit bila tersedia, dirty flag, timestamp UTC, dan digest manifest. Salinan staging harus diverifikasi setelah copy; perubahan file saat capture membatalkan file tersebut atau keseluruhan run sesuai policy. Scanner hanya membaca staging readonly, bukan live repository yang berubah.

### 4.2 Parser dan graph

Gunakan AST Python tanpa import modul project. P0 mengenali definisi fungsi/class, import, pemanggilan dengan nama yang ter-resolve secara terbatas, decorator route FastAPI, pola pemanggilan LLM yang terdaftar, tool registration eksplisit, dan wrapper retrieval/store yang ada pada fixture. Authorization calls yang tidak dipahami ditandai unknown, bukan dianggap tidak ada.

Node types: file, symbol, endpoint, llm_call, prompt_template, retriever, tool, data_store, dependency. Edge types: defines, imports, calls, retrieves_from, invokes_tool, reads_from, writes_to, guarded_by. Edge harus mempunyai source_ref dan provenance: observed_static, inferred, atau observed_runtime. inferred tidak menyatakan runtime reachability.

ID node adalah hash project_id + normalized relative path + qualified symbol + kind; source line tidak menjadi satu-satunya identitas. Edge dibatasi pada relasi dengan evidence. Dynamic dispatch, reflection, dependency injection yang tidak terpecahkan, dan konfigurasi runtime eksternal dicatat dalam limitations.

Mengetahui nama tool tidak membuktikan izin atau efek sampingnya. Korelasi kode dan runtime memerlukan symbol mapping atau trace span yang dapat ditautkan; hubungan berdasarkan kemiripan nama saja tetap inferred.

## 5. Integrasi engine

### 5.1 Kontrak umum

ScannerAdapter menyediakan `probe()`, `plan(snapshot, config)`, `execute(job, sandbox)`, dan `normalize(result)`. Kontrak ini internal plenger, bukan API upstream. Plan mengembalikan argv/manifest terstruktur; eksekusi menggunakan argv tanpa shell dan tanpa interpolasi hasil model.

Jalankan binary/image yang dipin dari working directory terkelola. Jangan memuat konfigurasi scanner, plugin, provider script, environment, atau rules executable dari repository secara implisit. Cegah automatic update, telemetry, auto-install, shell init, dan credential inheritance. Parser hasil memvalidasi schema, path, ukuran, enum, dan jumlah record. Maximum raw result 64 MiB per engine; overflow adalah error terjelaskan.

Jika format hasil berubah atau binary hilang, jangan mengembalikan daftar temuan kosong dengan status sukses. Simpan status engine dan coverage gap; full baseline dianggap incomplete jika engine P0 gagal.

### 5.2 Pemilihan dan cakupan

| Adapter | Cakupan P0 | Batas |
| --- | --- | --- |
| Semgrep CE | Rules lokal terkurasi untuk pola Python dan sink output yang didukung | Tidak mengklaim whole-program analysis; licenses rule dicatat terpisah [R09] |
| OSV-Scanner | Dependency lockfile yang didukung versi terpilih; local advisory DB | DB tidak ada -> unavailable; age >7 hari -> stale warning; dependency unresolved tetap terlihat [R10] |
| Trivy secrets | Filesystem secret scanning dengan managed configuration | Tidak memeriksa apakah credential benar-benar aktif; isi secret tidak masuk report [R11] |
| Promptfoo | Import JSON tervalidasi dan replay fixed cases melalui provider/broker plenger | Tidak menerima config/script bebas; remote-only feature tidak dibuka otomatis [R06, R07] |
| Agentic Radar | P1: pengayaan graph melalui format terverifikasi | Bukan pengganti parser P0; command runtime project tidak diaktifkan [R08] |
| Strix | P2: adapter pengujian aplikasi umum | Tidak termasuk MVP dan tidak dipanggil oleh Jev [R13] |

M2 MUST menguji satu eksekusi asli setiap engine statis pada fixture lokal; mocks tidak cukup. Update database OSV adalah tindakan terpisah dengan consent network, checksum, timestamp, dan ukuran; scan offline tidak mengunduh data otomatis. TTL 7 hari adalah kebijakan plenger, bukan jaminan freshness dari OSV.

### 5.3 Integrasi Promptfoo yang dibatasi

plenger menghasilkan konfigurasi dari schema internal. Fixed test cases yang telah ditinjau menjadi default P0; generator adaptif dan plugin hosted adalah P1. Target provider buatan plenger mengirim permintaan ke broker memakai target_ref, bukan URL bebas. Grading utama dilakukan oleh evaluator plenger; hasil grader pihak ketiga disimpan sebagai assessment tambahan, tidak langsung menjadi validation_state.

Tetapkan `PROMPTFOO_DISABLE_REMOTE_GENERATION=1` dan `PROMPTFOO_DISABLE_TELEMETRY=1` bila didukung versi terpilih; tetap enforce isolasi jaringan. Flag tersebut bukan jaminan tidak ada koneksi lain. [R07] Fitur upstream yang butuh account check atau service di luar policy menjadi blocked dan ditampilkan sebagai keterbatasan. Jangan mengakali pembatasan layanan atau mengklaim semua plugin bekerja offline.

## 6. Model data dan status

Semua ID adalah UUID atau hash terformat; waktu disimpan UTC dan ditampilkan sesuai zona pengguna. JSON publik memakai snake_case, schema_version, serta limit ukuran eksplisit.

| Entitas | Field minimum |
| --- | --- |
| Project | id, name, root_identity, created_at, config_hash |
| Snapshot | id, project_id, commit, dirty, manifest_digest, files, limitations |
| GraphNode/Edge | id, snapshot_id, kind, source_ref, provenance, attributes |
| RunPlan | id, project_id, target_revision, profile_digest, plan_digest, budget, case_ids |
| Approval | id, plan_digest, actor, scope, expires_at, consumed_at, revoked_at |
| Run/EngineRun | id, snapshot_id, plan_id, state, engine_manifest, reason, timestamps |
| TestCase/Attempt | id, profile_revision, prereqs, assertions, result, evidence_ids |
| Finding | id, fingerprint, kind, severity, validation_state, lifecycle_state, references |
| EvidenceArtifact | id, run_id, source, sha256_redacted, mime, size, retention, redaction_version |
| Assessment | id, finding/attempt_id, evaluator, rubric_hash, inputs_digest, typed_result |
| PolicyEvent/Usage | id, run_id, sequence, decision, reason, reserved, actual, timestamp |

### 6.1 Finding dan bukti

Finding severity: info, low, medium, high, critical, unknown. Severity memuat asal nilai dan alasan; jangan menamai nilai internal sebagai CVSS. Jika upstream menyediakan CVSS, simpan vector/version/source persis secara terpisah tanpa mengarang nilai.

validation_state: candidate, supported, confirmed, disputed. lifecycle_state: open, acknowledged, suppressed, resolved. assessment_state: pending, evaluated, abstained, needs_review. Ketiganya independen. Jev hanya menambah assessment dan rekomendasi; tidak mengubah confirmed/resolved/suppressed atau severity secara otomatis.

Bukti memuat source file/span atau runtime trace, policy_ref, expected/observed, kondisi yang diuji, evaluator version, serta redacted artifact reference. confirmed menyatakan klaim spesifik, bukan semua kemungkinan dampak. Kehadiran package rentan dapat dikonfirmasi dari lockfile/advisory; exploitability tetap unknown kecuali diuji. Pola secret dapat dikonfirmasi hadir, tetapi validitas credential tidak diketahui.

### 6.2 Deduplikasi

Fingerprint code findings memakai project + canonical rule family + normalized path + symbol + sink kind. Dependency findings memakai project + package URL/identity + resolved version + advisory canonical ID. Marker rahasia tidak masuk fingerprint; gunakan HMAC lokal atas token bila dedup secret diperlukan agar tidak mengekspos hash secret berentropi rendah.

Jangan otomatis menyatukan temuan hanya karena teksnya mirip. Cross-engine root-cause cluster tetap menyimpan anggota dan bukti asli. Pergeseran baris bukan selalu temuan baru. Jika pemetaan simbol ambigu, pertahankan kedua record dan sarankan review.

### 6.3 State machine dan hasil tes

```text
Run: planned -> queued -> running -> completed
                           |-----> completed_with_errors
                           |-----> cancelling -> cancelled
                           |-----> failed / interrupted
Preflight tanpa izin atau prasyarat: blocked
```

Attempt result: pass, fail, inconclusive, error, blocked, skipped. fail berarti assertion pelanggaran terpenuhi dengan evidence yang disyaratkan; pass berarti perilaku yang diharapkan teramati pada kasus itu saja. HTTP 401 karena auth profile rusak adalah error, kecuali 401 merupakan output yang secara eksplisit diharapkan oleh assertion uji otorisasi.

Dua pengulangan gagal dapat membantu repeatability, tetapi satu kegagalan valid tidak boleh diabaikan karena percobaan lain lolos. Tampilkan seluruh hasil dan denominator, bukan hanya majority vote.

## 7. Rencana, scope, approval, dan budget

### 7.1 Target dan izin

Target mempunyai revision yang memuat scheme, host/IP, port, allowed path/method, environment, auth profile refs, max response size, policy, dan observability capability. HTTPS wajib untuk target jarak jauh; HTTP hanya untuk fixture local yang disetujui. Redirect dinonaktifkan. Tidak ada crawler atau path discovery otomatis.

Approval mengikat project, snapshot, exact target revision, case/profile/rubric digests, klasifikasi data, budget, allowed IP set, masa berlaku, dan identitas lokal pemberi izin. TTL default 30 menit untuk memulai; maksimum waktu run terpisah. Approval sekali pakai dan konsumsi transaksional. Dilarang wildcard domain, scope global, atau approval yang datang dari output model.

Jika target DNS berubah, path meluas, credential identity berubah, profile berubah, atau input penting diganti, rencana harus dibuat dan disetujui ulang. Manifest target mencatat identitas secret reference dan versi lokalnya tanpa menyimpan nilai secret.

### 7.2 Broker jaringan

Broker menerima target_ref/provider_ref dan payload schema, bukan arbitrary URL. Validate DNS A/AAAA pada plan dan setiap dispatch; socket MUST terhubung ke IP tervalidasi yang sama sambil mempertahankan TLS SNI/Host yang benar. Resolving ulang oleh HTTP client setelah pemeriksaan dilarang. Tolak address campuran, metadata/link-local, dan origin yang tidak disetujui. Private/loopback address hanya boleh untuk target local/staging yang didaftarkan secara eksplisit; endpoint manajemen plenger dan host-services lain tidak dapat dijadikan target.

Worker dijalankan dengan jaringan none. Reference transport Linux adalah Unix socket broker dengan capability token terbatas per job. Socket broker tidak menyediakan shell, filesystem, atau API administrasi. Implementasi lokal kini merutekan dispatch active fixed-suite melalui proses broker terpisah dengan bounded capability-protected Unix IPC untuk dispatch, cancel, dan stats; transport ini sendiri bukan container sandbox. Implementasi macOS/Docker Desktop dapat memakai broker container dan socket pada shared named volume; hanya aktif setelah integration tests menunjukkan tidak ada bypass. Pengaturan HTTP_PROXY/HTTPS_PROXY/NO_PROXY dari repository/user tidak diwarisi secara implisit.

### 7.3 Anggaran yang benar-benar dapat ditegakkan

Default per run: 40 kasus, 80 outbound attempts total, concurrency 2, request timeout 30 detik, wall time 600 detik, response cap 1 MiB, dan target output cap 1.024 token bila didukung. Total outbound attempts mencakup target, Jev, generator/grader, dan retry yang melalui broker. Jumlah dispatch dicatat terpisah dari jumlah kasus.

Sebelum dispatch, broker melakukan atomic reservation. Satu reservation mengonsumsi satu attempt; jika request mungkin sudah terkirim lalu timeout, slot tidak dikembalikan. Tidak ada retry otomatis untuk tindakan target yang berpotensi mempunyai efek samping. Call read-only ke evaluator boleh retry maksimal dua kali setelah percobaan awal, dengan jitter/backoff dan budget yang sama.

Budget USD memakai reservation berdasar price snapshot dan batas token yang diketahui; usage aktual merekonsiliasi reservasi. Jangan mengarang harga yang belum dikonfigurasi. Jika biaya tidak bisa dibatasi, cost_guard=strict menolak run; mode request_only memerlukan acknowledgment dan menampilkan biaya target sebagai unknown. Konfigurasi contoh memakai request_only dengan active mode nonaktif.

Internal tool/model calls di aplikasi target tidak terkontrol hanya dengan membatasi request eksternal. Strict cost mode mensyaratkan target-side limits/telemetry yang terverifikasi. Pembatalan menghentikan dispatch baru, mencabut capability, dan membunuh worker; request yang sudah berjalan dapat tetap selesai di sisi target dan harus ditandai outcome_unknown bila tidak ada bukti.

## 8. Profil OWASP dan oracle pengujian

Profile ID `owasp-llm-2025-core` menyimpan taxonomy_id, version, case IDs, prerequisites, policy refs, seed/template digest, oracle type, dan rule license metadata. Rilis awal memprioritaskan LLM01/02/06/08; semua kategori 2025 tetap mempunyai coverage record. [R01]

Kontrak target HTTP minimum: request mempunyai input, conversation_id, dan test_context opsional; response mapping mengarah ke output_text dan trace_id opsional. Target tidak wajib mengadopsi field tersebut secara native; adapter yang terkonfigurasi melakukan mapping JSON dengan path terbatas, bukan eval ekspresi atau script pengguna.

Trace event memuat run_id, attempt_id, sequence, trace_id, authenticated_subject, tool_name/retrieved_doc_ids, authorization_decision, approval_ref, outcome, dan timestamp. Untuk dispatch yang run-bound, runner menyertakan hanya `run_id`, `attempt_id`, dan sequence di `test_context.observer_context` agar sidecar dapat mengikat event tanpa mempercayai response target. Event ditandatangani atau disalurkan melalui fixture observer yang dipercaya. Implementasi lokal menyediakan bounded HMAC-SHA256 ingress dengan canonical JSON, replay rejection, duplicate/attempt binding, allowlisted trace fields, dan opt-in Unix socket transport dengan capability per instance; deployment signer/sidecar production tetap memerlukan verifikasi terpisah. Native fixed-suite replay juga membuka run/attempt context baru untuk setiap kasus. Trace yang hanya ditulis model sebagai teks tidak dianggap event asli.

| Oracle | Contoh klaim yang boleh dibuat | Saat bukti kurang |
| --- | --- | --- |
| exact_marker | Penanda sintetis terlarang benar-benar muncul | Tidak ada marker setup -> blocked |
| retrieval_boundary | Dokumen tenant lain masuk retrieval/context | Tidak ada trace -> inconclusive untuk klaim retrieval |
| tool_effect | Efek tool tanpa izin teramati pada mock ledger | Teks 'sudah terkirim' saja -> inconclusive |
| policy_semantic | Respons bertentangan dengan kebijakan tertentu | Jev memberi assessment; review sebelum confirmed |
| ground_truth | Jawaban tidak sesuai referensi fixture | Referensi tidak tersedia -> blocked |
| boundary_limit | Limit request/step fixture tidak bekerja | Target tidak punya telemetry -> cakupan parsial |

Fixture tenant menggunakan dua akun dan dataset terpisah. Fixture email memakai mailbox/ledger lokal, bukan SMTP nyata. Reset dan seed fixture dilakukan melalui endpoint test-only yang secara eksplisit masuk scope; jangan otomatis menjalankan script dari project. Native fixed-suite executor wajib tetap tersedia untuk tes terkurasi apabila fitur Promptfoo tidak kompatibel dengan policy jaringan.

Pass/fail asli upstream disimpan terpisah; normalizer memeriksa apakah oracle dan bukti cukup sebelum menetapkan hasil plenger. Coverage mengekspos planned/asserted/applicable/blocked/executed/error/inconclusive dan kategori manual, bukan skor sertifikasi.

## 9. Integrasi Jev

### 9.1 Interface dan kontrak eksternal

`DecisionProvider.evaluate(context, rubric, deadline)` mengembalikan Assessment terstruktur. Implementasi: DeterministicProvider untuk assertion pasti, ManualReviewProvider sebagai fallback, dan JevProvider untuk keputusan semantik. MockJevProvider hanya dipakai test/demo dengan label sumber yang eksplisit.

JevProvider menggunakan API TypeSafe `POST https://api.typesafe.ai/v1/systemone`, Authorization Bearer, dan fields state, model, questions. Choice mengembalikan pilihan/distribusi/confidence; Score mengembalikan nilai yang dapat berupa pecahan beserta legend/distribusi/confidence; Noul mengembalikan nilai 0..1 tanpa field confidence. [R02, R03, R05] Lihat examples/jev-request.example.json untuk request yang memakai kebijakan dan data sintetis milik plenger.

Contoh pin awal adalah `jev-1.13.0`, sesuai dokumentasi model yang diperiksa. Pin harus diuji terhadap akun saat integrasi; perubahan model atau alias memicu evaluasi ulang dan tidak diterapkan otomatis. Simpan requested_model dan response_model; bila ID versi tidak tersedia, tandai version_unresolved. [R04]

### 9.2 State minimum dan keputusan

State hanya berisi kebijakan tepercaya, fakta yang dihasilkan checker deterministik, references bukti, dan excerpt tersamarkan dari konten target. Teks repository/target selalu diberi label untrusted_observation. Jangan memasukkan seluruh repository, environment, system prompt asli yang sensitif, atau secret ke hosted state.

Rubric memisahkan pertanyaan: evidence_sufficiency menggunakan Choice dengan opsi insufficient; policy_violation menggunakan Noul; next_check menggunakan Choice dari daftar check IDs yang sudah ada. Score dapat mengukur kesesuaian jawaban pada rubric evaluasi, bukan menjadi severity otomatis. Pertanyaan yang bergantung pada jawaban lain dijalankan dalam tahap terpisah agar dependency-nya nyata.

Rekomendasi next_check bukan izin dispatch. Policy engine tetap memeriksa apakah check sudah ada dalam rencana yang disetujui; bila tidak, pengguna harus membuat rencana baru. Penjelasan UI dibentuk dari template dan evidence refs, bukan mengarang rationale seolah-olah dikembalikan Jev.

### 9.3 Validasi dan fallback

Request maksimum 32 KiB state JSON tersamarkan untuk MVP; truncation memberi flag evidence_truncated dan memaksa review. Default timeout Jev 10 detik, maksimal dua retry pada error yang dapat dicoba ulang dan hanya jika budget tersedia. Auth/schema error tidak diulang. Error upstream tidak boleh dicatat bersama request body atau API key.

Tolak response non-finite, pilihan di luar enum, question ID yang hilang, probabilitas di luar 0..1, distribusi yang tidak menjumlah mendekati 1, score di luar legend, serta type yang tidak sesuai. Toleransi numerik distribusi default 0,01. Panggilan gagal atau respons tidak valid menghasilkan assessment abstained dengan reason_code, bukan dugaan sukses.

Tidak ada threshold yang mengizinkan auto-dismiss/auto-confirm pada MVP. Confidence hanya ditampilkan sebagai statistik model. Bukti deterministik yang bertentangan dengan assessment menandai disputed/needs_review, tidak ditimpa. Model output tidak dapat mengubah policy, budget, target, file, atau credential reference.

### 9.4 Evaluasi kualitas

Sediakan minimal 120 contoh berlabel: 40 pelanggaran dengan bukti, 40 kontrol negatif, 20 bukti tidak lengkap, dan 20 upaya memanipulasi penilai. Sertakan bahasa Indonesia dan Inggris serta beberapa kategori risiko; train/tune dan holdout dipisah berdasarkan skenario, bukan baris acak yang hampir sama.

Bandingkan deterministic-only dengan deterministic+Jev, laporkan confusion matrix, abstention, biaya yang diketahui, p50/p95 latency, serta error menurut bahasa/kategori. Confidence/probabilitas tidak diasumsikan terkalibrasi. Perubahan rubric, model, redactor, atau data schema membatalkan cache evaluasi terkait.

## 10. API lokal dan kontrak CLI

### 10.1 Session dan API

Bind hanya ke 127.0.0.1 pada port 7331. CLI mengeluarkan kode pairing sekali pakai dengan TTL 60 detik; pengguna memasukkannya pada halaman pairing lokal. Kode tidak ditempatkan di query string, log browser, atau permanent URL. Session cookie HttpOnly, SameSite=Strict, host-only dan pendek umur; local HTTP memerlukan origin/Host validation dan CSRF token untuk mutasi. Deployment non-loopback tidak didukung; jangan menambah switch expose tanpa threat-model baru.

CORS wildcard dilarang. Reject Host/Origin di luar origin lokal terkonfigurasi. Pairing endpoint rate-limited. Secret tidak pernah masuk JavaScript/browser. Evidence/source retrieval memakai opaque ID yang dipetakan server, bukan path file dari query. Graph/Markdown/HTML dari repository atau target dirender sebagai teks yang di-escape.

| Method/path | Perilaku |
| --- | --- |
| GET /api/v1/health | Status minimal tanpa path, token, atau konfigurasi |
| GET /api/v1/capabilities | Status adapter dan sandbox untuk sesi terautentikasi |
| POST /api/v1/projects/{id}/scans | Membuat job read-only; 202 + run_id |
| GET /api/v1/projects/{id}/runs | Riwayat run project yang dibatasi dengan `limit`/`offset` dan `next_offset` saat masih ada halaman; tidak memuat report mirror |
| GET /api/v1/projects/{id}/report | Overview latest/selected run; list mirror dibatasi 100 item dengan total counts, sedangkan endpoint normalized/export tetap lengkap |
| GET /api/v1/projects/{id}/graph | Graph normalized terpaginasikan untuk latest atau selected `run_id`, dengan `snapshot_id`, `next_offset`, serta filter `node_kind`/`source_path` |
| GET /api/v1/projects/{id}/findings | Project-scoped findings for the latest or selected `run_id`, filtered by severity/validation/lifecycle/kind/path, opaque keyset cursor, optional legacy offset, limit <=100 |
| GET /api/v1/projects/{id}/diff | Membandingkan dua run project-scoped dengan status conservative diff |
| GET /api/v1/findings/{id} | Detail dengan evidence refs tersamarkan |
| PATCH /api/v1/findings/{id} | Perubahan lifecycle manual, reason, expected revision |
| POST /api/v1/projects/{id}/plans | Membuat draft plan; tidak menjalankan target |
| POST /api/v1/plans/{id}/approvals | Menyetujui digest dan scope terverifikasi |
| POST /api/v1/plans/{id}/runs | Konsumsi approval sekali pakai dan enqueue |
| GET /api/v1/runs/{id} | Status, coverage, accounting dan reason |
| GET /api/v1/runs/{id}/events | SSE redacted dengan sequence/Last-Event-ID |
| POST /api/v1/runs/{id}/cancel | Revoke capability; respons setelah dispatch baru diblokir |
| GET /api/v1/assessment-consent | Preview provider, domain, kelas data, config hash, dan status consent hosted |
| POST /api/v1/assessment-consent | Menyimpan consent hosted eksplisit yang terikat project/config/provider/kelas data |
| DELETE /api/v1/assessment-consent | Mencabut consent hosted aktif tanpa menghapus riwayat assessment |
| GET /api/v1/runs/{id}/assessments | Riwayat assessment terikat run/finding dengan `limit` <=100, `offset`, dan `next_offset` saat masih ada halaman |
| POST /api/v1/runs/{id}/assessments | Evaluasi terpisah dengan consent/budget evaluasi |
| POST /api/v1/runs/{id}/exports | Artefak JSON/HTML tersamarkan |

Semua resource access memverifikasi session, project boundary, dan existence. UUID bukan pengganti otorisasi. POST eksekusi membutuhkan Idempotency-Key; key sama dengan body berbeda ->409, key/body sama ->resource lama. Transaksi approval mencegah double-run paralel. PATCH menggunakan revision untuk mencegah lost update.

Error envelope: code, message yang aman, request_id, details tersamarkan. Mapping: 401 session, 403 policy, 409 state/revision, 422 schema, 429 limit, 503 capability unavailable. Jangan meneruskan stack trace scanner/provider ke UI.

### 10.2 CLI yang harus dibangun

```bash
plenger init .
plenger doctor --project .
plenger scan --project . --profile baseline
plenger serve --project .
plenger plan --project . --target staging \
  --profile owasp-llm-2025-core
plenger approve PLAN_ID --ack-authorized --ttl 30m
plenger run PLAN_ID --approval APPROVAL_ID
plenger cancel RUN_ID
plenger evaluate RUN_ID --provider jev
plenger export RUN_ID --format json
plenger scan --project . --ci --fail-on high
plenger delete-storage --project . --confirm-project-id PROJECT_ID
```

Perintah tersebut adalah antarmuka yang direncanakan. `evaluate` membuat assessment job baru dengan consent dan budget tersendiri, tidak mengonsumsi ulang approval target. `approve` mencatat identitas OS lokal, scope, dan acknowledgment; tidak membuktikan pemilikan target. `delete-storage` hanya menghapus data privat di `.plenger` setelah project ID yang ditampilkan `doctor` dikonfirmasi tepat; proses mengambil runtime locks dan menolak proyek yang sedang dipakai worker. Source, konfigurasi, dan path lain tidak disentuh. Pairing dan consent yang berisiko tidak boleh di-bypass dengan input dari repository.

Exit codes untuk scan/CI: 0 = lengkap tanpa temuan yang memenuhi gate; 1 = lengkap dengan temuan yang memenuhi gate; 2 = error/incomplete, termasuk engine wajib gagal; 3 = blocked policy atau capability; 130 = cancelled. Jika ada temuan dan error sekaligus, exit 2 dengan keduanya pada JSON. Gate hanya menghitung temuan supported/confirmed pada severity threshold; candidate tetap tampil sebagai review warnings. Gating manual-review dapat dikonfigurasi terpisah dan eksplisit.

## 11. Scheduler, sandbox, dan recovery

Scheduler memakai durable jobs di SQLite dan satu writer service. Job lease mempunyai owner, expiry, heartbeat, attempt_index, dan state revision. Worker tidak mengakses database utama; event/result masuk melalui bounded IPC dan ditulis service. Maksimum dua worker concurrent default, dibatasi per engine dan memori.

Reference sandbox container memakai rootfs readonly, user non-root, capability drop-all, no-new-privileges, seccomp default, CPU/memory/PID limits, input snapshot readonly, serta output tmpfs yang terbatas. Tidak ada privileged, host network, Docker socket, home directory, atau arbitrary host mount. Image dipin dengan digest. Container bukan batas terhadap host yang sudah dikuasai; host administrator adalah pihak tepercaya.

Static workers tidak mendapatkan broker capability. Active worker hanya mendapat job-scoped IPC broker, fixed suite, dan metadata minimum; target credentials diselesaikan broker. Promptfoo provider executable adalah kode bawaan plenger yang dipin, bukan kode dari project.

Setelah crash, running jobs menjadi interrupted. Jangan otomatis mengulang active attempt karena efek samping mungkin sudah terjadi. Scan statis dapat dijalankan ulang sebagai run baru yang idempotent; evidence lama dipertahankan. Startup membersihkan worker yatim dan staging kedaluwarsa dengan path yang dimiliki runtime, bukan recursive delete terhadap path dari data scanner.

Event log mempunyai sequence monotonic dan hash-chain opsional untuk mendeteksi perubahan tidak sengaja. Hash di disk lokal bukan bukti anti-tamper terhadap pemilik host; jangan mengiklankannya sebagai audit log yang tidak dapat diubah.

## 12. Privasi, redaction, dan retention

Redactor berjalan sebelum logging, penyimpanan, UI, ekspor, serta panggilan hosted. Lapisan pertama menghapus exact credential values yang dikenal dan field sensitif; berikutnya pola secret/PII yang didukung; akhirnya allowlist field pada schema artifact. Detector tidak menjamin menemukan semua data sensitif, sehingga preview hosted payload dan persetujuan tetap diperlukan.

Default excerpt maksimal 2.000 karakter dan tidak meliputi file sensitif yang dikecualikan. Batas tersebut berbeda dari batas keseluruhan state Jev. Artefak hasil redaction memiliki sha256, redaction_version, ukuran, dan timestamp. Jangan menyimpan raw-content hash untuk secret pendek; gunakan HMAC lokal jika korelasi diperlukan.

Retention default 30 hari untuk artifact content dan 90 hari untuk metadata/audit lokal. Penghapusan manual project menghapus keduanya setelah konfirmasi. Artifact yang kedaluwarsa tetap meninggalkan status evidence_expired pada temuan sampai metadata ikut dipurge; UI tidak boleh menampilkan evidence yang sudah tidak tersedia sebagai dapat diverifikasi.

Tidak ada raw debug mode pada MVP. Export JSON/HTML melakukan redaction ulang dan HTML escaping; sumber HTML pihak ketiga tidak di-embed langsung. CSV bukan format MVP sehingga risiko formula injection tidak dipindahkan ke ekspor spreadsheet tanpa desain tambahan.

Hosted consent terpisah untuk metadata dependency, excerpt kode, prompt/response, serta trace. Core scan tidak memerlukan consent hosted. Key TypeSafe diselesaikan hanya pada backend/broker dan tidak diwariskan ke worker umum.

## 13. Threat model dan negative tests

| Ancaman | Kontrol wajib | Bukti pengujian |
| --- | --- | --- |
| Instruksi berbahaya di README/kode/output | Tidak dieksekusi; evaluator read-only; policy di luar model | Konten fixture tidak mengubah target atau scope |
| Path traversal/symlink/file race | Canonicalization, no-follow, verified staging | Path luar root tidak dapat dibaca/diekspor |
| SSRF dan DNS rebinding | Pinned-IP dispatch, exact origin/path, redirect off | A/AAAA berubah dan redirect ditolak |
| Eksekusi melalui config/plugin | Schema deklaratif, managed argv/config | file:// provider dan command injection ditolak |
| Cross-site request ke localhost | Pairing, Host/Origin, SameSite, CSRF | Browser hostile origin tidak dapat start run |
| XSS pada bukti | Escape text, CSP, tanpa remote asset | Payload HTML inert di UI dan report |
| API key/secret leakage | Minimized env, redaction, consent dan egress gate | Marker tidak muncul pada durable outputs |
| Budget race/cancel | Atomic reservation, revoke dan process control | Jumlah dispatch tidak melampaui budget |
| Forged evidence | Schema, observer provenance, run/attempt binding | Teks tool-call palsu tidak jadi confirmed |
| Dependency/config drift | Pinned hash/version dan contract tests | Unsupported engine terlihat, tidak silent pass |

Host compromise, model-provider compromise, dan target yang sengaja memalsukan telemetry adalah residual risk. plenger membedakan observed trace, observer-verified event, dan user-supplied claim. Tidak ada parser atau evaluator yang dianggap sempurna.

## 14. Riwayat, prioritas, dan ekspor

Deduplikasi dan diff dilakukan dalam project yang sama, memakai snapshot/rule/profile identity. Perubahan rule atau model membuat hasil non-comparable sampai pengguna memilih basis perbandingan. Not observed tidak sama dengan fixed; scan partial tidak boleh menutup temuan lama.

Suppression memerlukan reason, actor, scope fingerprint, created_at, expiry, dan optional evidence. Default expiry 30 hari. Jangan menyalin suppression antarproject secara otomatis. Jev tidak membuat suppression.

Prioritas default mengurutkan severity terlebih dahulu, kemudian validation_state dan exposure yang diketahui. Unknown exposure tetap unknown. Dashboard tidak mengalikan confidence Jev dengan severity atau menampilkan vulnerability probability tanpa kalibrasi.

JSON export memiliki schema_version=1, manifest, coverage, findings, assessments, engine states, dan reference bukti tersamarkan. HTML report self-contained tanpa CDN/script remote. Export mengandung notice bahwa pass berlaku untuk kasus tertentu dan cakupan dapat parsial. SARIF dan integrasi DefectDojo adalah P1, bukan fitur yang harus dipalsukan pada MVP.

## 15. Strategi pengujian dan release gates

Unit tests memeriksa policy, budgets, fingerprints, schema, redaction, dan state machine. Property-based tests memeriksa URL/path normalization, budget concurrency, dan status mapping. Contract tests memakai output engine yang dipin; integration tests menjalankan binary/image asli pada fixture yang boleh dipindai.

Security tests harus mencakup AC01-AC24 dalam TRACEABILITY.md. E2E browser meliputi pairing, scan fixture, membuka evidence, membuat rencana, menolak scope berubah, menjalankan mock target, cancel, ekspor, dan riwayat. Semua test runtime menggunakan local fixture atau endpoint milik tim yang disetujui; jangan menyasar layanan pihak lain selama development.

Jev mock tests wajib, live smoke test opsional hanya dengan API key dan consent. Ketika live test tidak dijalankan, status adapter harus contract-tested/not-live-verified; jangan menyatakan production-ready. Benchmark keseluruhan mengikuti definisi PRD, menyimpan hasil mentah yang tidak sensitif dan konfigurasi host.

Rilis memerlukan lint/typecheck, unit/integration/security/E2E, migration upgrade/rollback yang didukung, clean install, dependency scan, license inventory, dan secret scan pada repository plenger sendiri. Gate keselamatan tidak boleh dikecilkan untuk mengejar demo.

## 16. Observabilitas dan compatibility

Log terstruktur hanya mencatat request_id/run_id, stage, reason_code, latency, counts, serta adapter/model version. Token/biaya bernilai null ketika tidak tersedia; jangan mengisinya nol. Pisahkan target usage, Jev usage, generator usage, cached results, dan transport attempts agar tidak double-count.

Cache semantic assessment memakai project_id + artifact digest + rubric hash + requested/resolved model + redactor version. Tidak ada cross-project cache. Replay target dimatikan secara default karena memerlukan approval baru dan aplikasi bisa berubah; cache response tidak boleh ditampilkan sebagai pengujian fresh.

Dependency ledger mencatat versi, hash, lisensi, source, fitur yang dipakai, serta jenis pengujian yang selesai. Update engine memerlukan fixture compatibility test dan perubahan ADR bila policy/format berubah. Error vendor dipetakan ke reason_code tanpa menutupi penyebab seperti license_required atau unsupported_offline.

## 17. Urutan implementasi dan Definition of Done

Ikuti M0-M6 pada PRD. Pada M1, hasil end-to-end yang kecil tetapi nyata lebih penting daripada menu lengkap. Pada M3, fixed suite dan broker menjadi prioritas sebelum generasi adaptif. Pada M4, adapter Jev harus dapat dites melalui mocked HTTP response tanpa menggantungkan offline core pada API.

Satu requirement dianggap selesai hanya jika service, API/CLI bila relevan, UI state, test, dokumentasi, serta error path tersedia. Placeholder/mock boleh berada pada fixtures/tests/demo, tetapi tidak sebagai default perilaku production. Fitur tidak selesai menggunakan capability flag dan explanation, bukan fabricated success.

ADR minimum: local-first, sandbox portability, engine/rule licenses, scope/approval, evidence semantics, Jev trust boundary, budget limits, dan retention. Untuk konflik dokumen, kontrol keselamatan yang lebih ketat berlaku; catat keputusan produk yang memerlukan perubahan sebelum memperluas scope.

Referensi teknis eksternal: SOURCES.md. Semua persyaratan plenger, schema internal, defaults, dan target pengujian di sini adalah keputusan desain yang perlu diwujudkan dan diverifikasi.
