# plenger - Matriks penerimaan dan traceability

Versi 0.1, 19 September 2026. AC berikut adalah acceptance tests yang harus diimplementasikan, bukan hasil tes yang sudah dijalankan. Setiap test menghasilkan record pass/fail/blocked beserta alasan, commit produk, fixture version, dan engine manifest.

## AC01 - Init, schema, dan workspace

**FR01; M0-M1.** Jalankan init pada direktori fixture lalu ulangi. Konfigurasi tidak tertimpa, tidak ada build/install/import aplikasi, dan tidak ada network attempt. Uji YAML duplicate key, object tags, alias berlebihan, path traversal, file di luar root, serta environment yang tidak dikenal. Input invalid ditolak sebelum job dibuat.

## AC02 - Ketepatan graph

**FR02; M1.** Minimal 50 fixture pola Python/FastAPI/agent yang didukung mempunyai expected nodes/edges. Ukur precision >=95% dan recall >=90% pada cakupan yang dinyatakan. Semua edge mempunyai lokasi dan provenance. Dynamic dispatch yang tidak terpecahkan tidak boleh diberi label observed_runtime atau pasti reachable.

## AC03 - SAST nyata dan kegagalan engine

**FR03; M2.** Jalankan versi Semgrep yang dipin terhadap positive/negative fixture dan cocokkan normalized findings. Simulasikan engine missing, timeout, malformed output, output terlalu besar, dan managed-config override. Seluruh kegagalan terlihat sebagai incomplete/error; tidak pernah menghasilkan scan bersih palsu. Aturan yang dibundel mempunyai metadata lisensi.

## AC04 - Dependency scan offline

**FR04; M2.** Dengan advisory DB lokal yang dipin, seeded vulnerable dependency ditemukan dan kontrol fixed tidak dilaporkan untuk advisory tersebut. Database hilang menjadi unavailable; database >7 hari memunculkan stale warning. Tidak ada download saat scan. Unresolved/ranged dependency dicatat, bukan diasumsikan aman.

## AC05 - Perlindungan secret

**FR05, FR14; M2.** Tanam marker secret sintetis dalam file yang disetujui untuk scan. Temuan mempertahankan jenis dan lokasi, tetapi tidak nilai aslinya. Cari marker pada SQLite, persistent logs, artifacts, UI response, ekspor dan mock hosted request: harus nol. Raw marker hanya boleh ada di input fixture dan temporary scanner memory/staging yang dibersihkan.

## AC06 - Deduplikasi konservatif

**FR06; M2.** Dua scanner dengan bukti akar masalah sama dapat dikelompokkan tanpa menghapus anggota. Dua masalah berbeda pada file yang sama tidak disatukan. Pergeseran baris mempertahankan identitas jika simbol tetap cocok. Advisory alias canonicalization tidak menghilangkan source attribution.

## AC07 - Approval dan replay

**FR07; M3.** Plan tanpa approval diblokir. Perubahan target, IP, profile, snapshot, auth identity, budget, rubric, atau case digest membatalkan approval. Approval expired/revoked tidak dapat dipakai. Dua request paralel dengan approval sama membuat maksimum satu run. Idempotency key yang sama dengan body berbeda menghasilkan conflict.

## AC08 - Batas jaringan

**FR08, FR14; M3.** Uji URL normal, IPv4/IPv6, DNS rebinding, A/AAAA campuran, redirect ke origin lain, link-local/metadata, wildcard host, dan proxy environment. Hanya origin/path/method/IP yang disetujui bisa dicapai. Native worker maupun Promptfoo tidak bisa membuka koneksi langsung di luar broker. Local fixture yang diizinkan tetap bekerja.

## AC09 - Budget dan cancel

**FR08; M3.** Jalankan 100 dispatch paralel pada budget 10: tidak lebih dari 10 outbound attempts. Retry dihitung, timeout yang mungkin terkirim tetap mengonsumsi slot. Setelah cancel diakui, tidak ada dispatch baru; worker fixture berhenti <=5 detik. Tindakan target tidak replay otomatis. Strict cost guard menolak target tanpa batas biaya yang dapat dipercaya.

## AC10 - Semantik coverage

**FR09; M3.** Dashboard selalu memuat 10 kategori OWASP LLM 2025 dengan profile digest. Blocked/skipped/error/inconclusive tidak dihitung sebagai pass. Absennya dataset poisoning atau ground truth tidak diberi status aman. Selected profile dan denominator kasus ditampilkan jelas, tanpa klaim sertifikasi atau coverage penuh.

## AC11 - Kontrak Jev

**FR10; M4.** Mock HTTP mencakup Choice, Score pecahan, Noul tanpa confidence, missing ID, enum invalid, NaN, distribusi invalid, timeout, 401, 422, 429 dan 529. Hanya respons valid menghasilkan evaluated. Retry dibatasi budget; auth/schema error tidak retry. Catat requested/resolved model, rubric hash dan redaction version. Live test memerlukan consent dan kredensial terpisah.

## AC12 - Jev tidak mempunyai authority

**FR10; M4.** State fixture berisi instruksi untuk mengubah target, membaca secret, dan mengizinkan tindakan. Tidak ada perubahan izin, filesystem, severity, lifecycle, atau validation_state karena jawaban model. Recommendation untuk check di luar plan tidak memicu eksekusi. Contradictory deterministic evidence menghasilkan review, bukan auto-dismiss.

## AC13 - Dashboard lokal dan isolasi resource

**FR11; M1/M6.** Uji pairing sekali pakai/expired, session invalid, hostile Origin/Host, CSRF, evidence ID lintas project, path injection, dan XSS pada temuan. Smoke Playwright pada disposable project memverifikasi pairing, report statis nyata, section evidence/graph, deterministic assessment history dengan cached-result label, one-use active plan/approval/execution, cancellation terhadap target lambat, JSON export, dan logout; API smoke mencakup lifecycle aktif, assessment, serta history. Hanya sesi dan project yang benar dapat membaca/mutasi resource. Seluruh halaman memiliki empty/loading/error states; data demo tidak menyamar sebagai data scan.

## AC14 - Lifecycle dan pembandingan

**FR12; M5.** Seed new/recurring/not_observed/resolved/reopened. Partial scan tidak menutup temuan. Suppression memerlukan actor/reason/expiry dan expired suppression kembali terlihat. Perubahan model/profile/rule menandai non-comparable; tidak diam-diam menyimpulkan perbaikan.

## AC15 - Ekspor dan CI

**FR13; M5.** JSON valid terhadap schema, HTML self-contained dan inert terhadap payload script. Artefak melewati redaction ulang. Uji exit 0/1/2/3/130, termasuk adanya temuan bersamaan dengan engine error. Temuan candidate tidak otomatis menggagalkan severity gate supported/confirmed tanpa kebijakan eksplisit.

## AC16 - Offline dan hosted consent

**FR14; M1/M4/M6.** Full static baseline dengan seluruh engine/DB terpasang dijalankan di jaringan yang memblokir egress: tidak ada koneksi yang berhasil maupun upaya hosted tersembunyi. Jev tanpa consent/key tidak dipanggil. Consent satu project tidak berlaku pada project lain. UI memperlihatkan preview jenis data dan domain sebelum hosted assessment diaktifkan.

## AC17 - Integritas dan kecukupan bukti

**FR15; M3.** Temuan punya snapshot dan evidence refs yang valid. Hash berubah, artefak kedaluwarsa, trace berbeda run, atau evidence missing ditandai jelas. Teks respons 'tool berhasil' tidak cukup untuk confirmed tindakan; gunakan observer/mock ledger. Fixture/native replay membuka konteks run/attempt per kasus, dan signed ingress lokal memverifikasi canonical envelope, HMAC, replay, serta binding attempt; API/background runner, synchronous `run` CLI, dan `serve` CLI meneruskan observer opt-in dengan secret file owner-only. Deployment sidecar produksi dan hash lokal tetap tidak diklaim sebagai anti-tamper terhadap host owner.

## AC18 - Crash dan recovery

**FR16; M5.** Hentikan proses saat queued/running/dispatch/write-result. Setelah startup, tidak ada approval ganda atau active retry otomatis; run menjadi interrupted dan ledger tetap konsisten. Worker yatim dibersihkan. Deletion hanya mengenai temp directories atau private storage milik plenger, bukan path yang dikirim scanner; project storage deletion memerlukan project-ID confirmation dan runtime locks.

## AC19 - Kompatibilitas dan lisensi

**FR17; M2/M6.** Setiap engine mempunyai versi/hash, output fixture, lisensi engine/rule, dan status contract-tested/integration-tested/live-verified. Unsupported version tidak dijalankan diam-diam. Promptfoo remote-only/config executable ditolak. Integration test asli diperlukan untuk adapter yang dinyatakan didukung.

## AC20 - Demo offline end-to-end

**FR18; M1.** Dengan runtime lokal yang memenuhi doctor checks dan tanpa API key, pengguna dapat init, scan fixture, melihat graph/temuan, dan mengekspor hasil nyata. Hasil diberi banner fixture. Jev disabled tidak menyebabkan crash. Mocks tidak menjadi default engine production.

## AC21 - Fixture aplikasi LLM vulnerable/fixed

**FR18; M3.** Minimal empat keluarga fixture: prompt injection berbasis kebijakan, synthetic disclosure, tool permission, dan cross-tenant retrieval. Masing-masing memiliki vulnerable/fixed mode serta negative controls. Mock mailbox tidak mengirim email; dokumen sintetis tidak menyentuh data nyata. Trace hilang menghasilkan inconclusive untuk klaim yang memerlukan trace.

## AC22 - Benchmark yang dapat diulang

**FR18; M6.** Catat CPU/RAM/OS/versi engine/cache state. Jalankan minimal 20 pengulangan pada 10.000 LOC dan daftar 5.000 temuan. Bandingkan startup p95 <=5 s, warm scan p95 <=120 s, listing p95 <=500 ms. Hasil di luar target dilaporkan dengan bottleneck dan tidak diberi angka hasil rekaan.

## AC23 - Instalasi, migration, dan packaging

**FR18; M6.** Instalasi bersih membawa aset UI yang sudah dibangun dan dependency locks. Init tidak otomatis download scanner image. Migration mempertahankan findings/events dan schema version. Sandbox tidak tersedia menghasilkan capability unavailable. Linux aktif dan macOS aktif dinyatakan supported hanya setelah suite isolasi platform tersebut lulus.

## AC24 - Evaluasi evaluator

**FR10, FR18; M4/M6.** Minimal 120 kasus berlabel sesuai SPEC, termasuk Indonesia/Inggris dan adversarial judge input. Pisahkan tuning dari holdout per skenario. Laporkan confusion matrix, abstention, biaya yang diketahui, latency, dan keterbatasan. Tidak ada klaim akurasi Jev tanpa hasil uji; auto-dismiss tetap nonaktif terlepas dari confidence.

## Format laporan acceptance

Satu record memuat test_id, requirement_ids, milestone, product_commit, environment, engine/model identities, result, evidence_path, dan limitation. Status blocked berarti syarat belum tersedia, bukan pass. Semua kontrol keselamatan P0 harus lulus sebelum mode aktif dirilis.
