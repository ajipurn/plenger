import {test, expect} from '@playwright/test';
import {readFileSync} from 'node:fs';

type E2EState = {
  available: boolean;
  reason?: string;
  code?: string;
  targetUrl?: string;
  targetProbePath?: string;
};

function state(): E2EState {
  const path = process.env.PLENGER_E2E_STATE;
  if (!path) throw new Error('E2E state path is missing');
  return JSON.parse(readFileSync(path, 'utf8')) as E2EState;
}

test('pairs a browser and renders a real local fixture report', async ({page}) => {
  const current = state();
  test.skip(!current.available, current.reason);
  if (!current.code) throw new Error('E2E pairing code is missing');

  await page.goto('/');
  await expect(page.getByRole('heading', {name: 'Pasangkan browser'})).toBeVisible();
  await page.getByLabel('Kode pairing').fill(current.code);
  const hostileOrigin = await page.context().request.get('/api/v1/health', {
    headers: {Origin: 'https://evil.example'},
  });
  expect(hostileOrigin.status()).toBe(403);
  expect(hostileOrigin.headers()['cache-control']).toBe('no-store');
  const hostileHost = await page.context().request.get('/api/v1/health', {
    headers: {Host: 'evil.example'},
  });
  expect(hostileHost.status()).toBe(403);
  expect(hostileHost.headers()['x-content-type-options']).toBe('nosniff');
  await page.getByLabel('Kode pairing').fill('invalid-pairing-code');
  await page.getByRole('button', {name: 'Pasangkan browser'}).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Kode pairing salah, kedaluwarsa, atau sudah mencapai batas percobaan.',
  );
  await page.getByLabel('Kode pairing').fill(current.code);
  await page.getByRole('button', {name: 'Pasangkan browser'}).click();

  await expect(page.getByRole('heading', {name: 'Hasil analisis'})).toBeVisible();
  const sessionCookie = (await page.context().cookies()).find((cookie) => cookie.name === 'plenger_session');
  expect(sessionCookie).toMatchObject({httpOnly: true, sameSite: 'Strict', domain: '127.0.0.1', path: '/'});
  expect(await page.evaluate(() => document.cookie)).not.toContain('plenger_session');
  const pairingReplay = await page.context().request.post('/api/v1/pair', {
    headers: {Origin: 'http://127.0.0.1:7331'},
    data: {code: current.code},
  });
  expect(pairingReplay.status()).toBe(401);

  // A different loopback port is cross-origin but same-site: the cookie can
  // accompany these requests, so SameSite alone cannot protect the API.
  if (!current.targetUrl) throw new Error('E2E target URL is missing');
  const hostilePage = await page.context().newPage();
  try {
    await hostilePage.goto(`${current.targetUrl}/hostile-page`);
    const rejected = hostilePage.waitForResponse((response) => (
      response.url() === 'http://127.0.0.1:7331/api/v1/logout'
      && response.request().method() === 'POST'
    ));
    const browserResponse = await hostilePage.evaluate(async () => {
      const response = await fetch('http://127.0.0.1:7331/api/v1/logout', {
        method: 'POST', credentials: 'include', mode: 'no-cors',
      });
      return {type: response.type, status: response.status};
    });
    expect(browserResponse).toEqual({type: 'opaque', status: 0});
    const response = await rejected;
    expect(response.status()).toBe(403);
    expect(response.headers()['access-control-allow-origin']).toBeUndefined();
    const sessionReadable = await hostilePage.evaluate(async () => {
      try {
        await fetch('http://127.0.0.1:7331/api/v1/session', {credentials: 'include'});
        return true;
      } catch {
        return false;
      }
    });
    expect(sessionReadable).toBe(false);
    expect((await page.context().request.get('/api/v1/session')).status()).toBe(200);
  } finally {
    await hostilePage.close();
  }
  const missingCsrfStatus = await page.evaluate(async () => {
    const response = await fetch('/api/v1/logout', {method: 'POST'});
    return response.status;
  });
  expect(missingCsrfStatus).toBe(403);
  await expect(page.getByRole('button', {name: 'Jalankan scan statis'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Temuan & bukti'})).toBeVisible();
  await expect(page.getByText('Fixture sintetis · hasil ini berasal dari kode demonstrasi.')).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Peta definisi'})).toBeVisible();
  const findingCard = page.locator('article').first();
  await findingCard.getByRole('button', {name: 'Tandai sudah ditinjau'}).click();
  await expect(page.getByText('Temuan ditandai sudah ditinjau.')).toBeVisible();
  await expect(findingCard.getByText(/Status workflow: acknowledged/)).toBeVisible();
  await findingCard.getByRole('button', {name: 'Sembunyikan sementara'}).click();
  await expect(page.getByText('Temuan disembunyikan sementara selama 30 hari.')).toBeVisible();
  await expect(findingCard.getByText(/Status workflow: suppressed/)).toBeVisible();
  await findingCard.getByRole('button', {name: 'Buka kembali'}).click();
  await expect(page.getByText('Temuan dibuka kembali untuk verifikasi.')).toBeVisible();
  await expect(findingCard.getByText(/Status workflow: open/)).toBeVisible();
  await findingCard.getByRole('button', {name: 'Tandai terselesaikan'}).click();
  await expect(page.getByText('Temuan ditandai terselesaikan dalam workflow.')).toBeVisible();
  await expect(findingCard.getByText(/Status workflow: resolved/)).toBeVisible();
  await page.getByText('Lihat bukti statis').click();
  await expect(page.getByText('Digest bukti tersamarkan')).toBeVisible();

  const hostileTitle = '<img src=x onerror="window.__plengerXss=1"> hostile finding';
  const hostileEvidence = '<script>window.__plengerXss=2</script> hostile evidence';
  const hostileGraphLabel = '<svg onload="window.__plengerXss=3"> hostile node';
  await page.route('**/api/v1/projects/*/report*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as {
      report?: {findings?: Array<{title?: string; evidence?: {observed?: string}}>};
    };
    const finding = payload.report?.findings?.[0];
    if (finding) {
      finding.title = hostileTitle;
      if (finding.evidence) finding.evidence.observed = hostileEvidence;
    }
    await route.fulfill({response, json: payload});
  });
  await page.route('**/api/v1/projects/*/findings?*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as {
      items?: Array<{title?: string; evidence?: {observed?: string}}>;
    };
    const finding = payload.items?.[0];
    if (finding) {
      finding.title = hostileTitle;
      if (finding.evidence) finding.evidence.observed = hostileEvidence;
    }
    await route.fulfill({response, json: payload});
  });
  await page.route('**/api/v1/projects/*/graph?*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json() as {nodes?: Array<{label?: string}>};
    const node = payload.nodes?.[0];
    if (node) node.label = hostileGraphLabel;
    await route.fulfill({response, json: payload});
  });
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Hasil analisis'})).toBeVisible();
  await expect(page.locator('article h3').first()).toHaveText(hostileTitle);
  await page.getByText('Lihat bukti statis').first().click();
  await expect(page.locator('article details p').filter({hasText: hostileEvidence})).toHaveText(hostileEvidence);
  await expect(page.locator('.graph-nodes code').first()).toHaveText(hostileGraphLabel);
  expect(await page.locator('article img[src="x"]').count()).toBe(0);
  expect(await page.locator('article script').count()).toBe(0);
  expect(await page.locator('article svg[onload]').count()).toBe(0);
  expect(await page.evaluate(() => (window as Window & {__plengerXss?: number}).__plengerXss)).toBeUndefined();
  await page.unroute('**/api/v1/projects/*/report*');
  await page.unroute('**/api/v1/projects/*/findings?*');
  await page.unroute('**/api/v1/projects/*/graph?*');
  await expect(page.getByRole('heading', {name: 'Assessment bukti'})).toBeVisible();
  const assessmentButton = page.getByRole('button', {name: 'Nilai bukti'}).first();
  await assessmentButton.click();
  await expect(page.getByText('Hasil assessment disimpan untuk ditinjau.', {exact: false})).toBeVisible();
  await expect(page.getByText(/deterministic · needs_review/)).toBeVisible();
  await assessmentButton.click();
  await expect(page.getByText(/deterministic · needs_review · cache/)).toBeVisible();
  await expect(page.getByText('Hasil ini berasal dari assessment tersimpan; bukan penilaian baru.')).toBeVisible();
  await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session')).json() as {project_id: string; csrf_token: string};
    const report = await (await fetch(`/api/v1/projects/${session.project_id}/report`)).json() as {
      report?: {run_id?: string; findings?: Array<{id?: string}>};
    };
    const runId = report.report?.run_id;
    const findingId = report.report?.findings?.[0]?.id;
    if (!runId || !findingId) throw new Error('Assessment pagination fixture is missing a finding');
    for (let index = 0; index < 101; index += 1) {
      const response = await fetch(`/api/v1/runs/${runId}/assessments`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token},
        body: JSON.stringify({finding_id: findingId, provider: 'manual', data_classes: []}),
      });
      if (!response.ok) throw new Error(`Assessment pagination fixture failed: ${response.status}`);
    }
  });
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Hasil analisis'})).toBeVisible();
  const assessmentResults = page.locator('.assessment-result');
  await expect(assessmentResults).toHaveCount(100);
  const nextAssessmentPage = page.getByRole('button', {name: 'Muat riwayat assessment berikutnya'});
  await expect(nextAssessmentPage).toBeVisible();
  await nextAssessmentPage.click();
  await expect(assessmentResults).toHaveCount(103);
  await expect(page.getByText('manual · needs_review', {exact: true})).toHaveCount(101);
  await page.getByLabel('Metode penilaian').selectOption('jev');
  const consentPreview = page.locator('.assessment-consent p');
  await expect(consentPreview).toContainText('api.typesafe.ai');
  await expect(consentPreview).toContainText('metadata, code_excerpt, response');
  await page.getByLabel(/Saya menyetujui dan menyimpan consent/).click();
  await expect(page.getByText('Consent hosted disimpan untuk konfigurasi ini.')).toBeVisible();
  await expect(page.getByText('Consent tersimpan untuk hash konfigurasi ini.')).toBeVisible();
  await page.getByRole('button', {name: 'Cabut consent hosted'}).click();
  await expect(page.getByText('Consent hosted dicabut. Assessment Jev berikutnya akan meminta persetujuan lagi.')).toBeVisible();
  await page.getByLabel('Metode penilaian').selectOption('deterministic');

  if (!current.targetUrl) throw new Error('E2E target URL is missing');
  await page.getByLabel('Base URL target').fill(current.targetUrl);
  await page.getByLabel('Case IDs').fill('LLM01-direct-policy');
  await page.getByLabel(/Saya memahami biaya internal target/).check();
  const firstPlanResponsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/plans') && response.request().method() === 'POST'
  ));
  await page.getByRole('button', {name: 'Buat plan'}).click();
  const scopePreview = page.locator('.active-preview');
  await expect(scopePreview.getByRole('heading', {name: 'Scope untuk persetujuan'})).toBeVisible();
  await expect(scopePreview.getByText('127.0.0.1', {exact: true})).toBeVisible();
  await expect(scopePreview.getByText('LLM01-direct-policy', {exact: true})).toBeVisible();
  await expect(scopePreview.getByText('Digest rubric', {exact: true})).toBeVisible();
  await expect(scopePreview).toContainText('Maksimum 40 case dan 80 attempt');
  await expect(scopePreview).toContainText('browser-user · berlaku 5 menit · sekali pakai');
  const firstPlan = await (await firstPlanResponsePromise).json() as {id: string};
  await expect(page.getByLabel('Base URL target')).toBeDisabled();
  await expect(page.getByLabel('Path yang diizinkan')).toBeDisabled();
  await page.evaluate(async (planId) => {
    const session = await (await fetch('/api/v1/session')).json() as {csrf_token: string};
    const response = await fetch(`/api/v1/plans/${planId}/revoke`, {
      method: 'POST',
      headers: {'X-CSRF-Token': session.csrf_token},
    });
    if (!response.ok) throw new Error(`revoke failed: ${response.status}`);
  }, firstPlan.id);
  await page.getByLabel(/Saya sudah meninjau digest rubric/).check();
  await page.getByRole('button', {name: 'Setujui scope sekali pakai'}).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Plan ini tidak lagi dapat disetujui. Cabut plan, lalu buat plan baru.',
  );
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Hasil analisis'})).toBeVisible();
  await page.getByLabel('Base URL target').fill(current.targetUrl);
  await page.getByLabel('Case IDs').fill('LLM01-direct-policy');
  await page.getByLabel(/Saya memahami biaya internal target/).check();
  await page.getByRole('button', {name: 'Buat plan'}).click();
  await expect(page.locator('.active-preview').getByRole('heading', {name: 'Scope untuk persetujuan'})).toBeVisible();
  await page.getByLabel(/Saya sudah meninjau digest rubric/).check();
  await page.getByRole('button', {name: 'Setujui scope sekali pakai'}).click();
  await expect(page.getByText('Plan disetujui sekali pakai.')).toBeVisible();
  await page.getByRole('button', {name: 'Cabut plan aktif'}).click();
  await expect(page.getByText('Plan aktif dicabut. Periksa scope lalu buat plan baru.')).toBeVisible();
  await page.getByLabel(/Saya memahami biaya internal target/).check();
  await page.getByRole('button', {name: 'Buat plan'}).click();
  await expect(page.locator('.active-preview').getByRole('heading', {name: 'Scope untuk persetujuan'})).toBeVisible();
  await page.getByLabel(/Saya sudah meninjau digest rubric/).check();
  await page.getByRole('button', {name: 'Setujui scope sekali pakai'}).click();
  await expect(page.getByText('Plan disetujui sekali pakai.')).toBeVisible();
  await page.getByRole('button', {name: 'Jalankan fixed suite'}).click();
  await expect(page.getByRole('heading', {name: 'Hasil fixed suite'})).toBeVisible({timeout: 20_000});
  await expect(page.getByText(/digest [0-9a-f]{64}/)).toBeVisible();
  await expect(page.getByText(/rubric [0-9a-f]{64}/)).toBeVisible();
  await expect(page.getByText(/Kasus yang dipilih: 1\./)).toBeVisible();
  await expect(page.locator('[aria-label="Ringkasan status coverage"]')).toContainText('Direncanakan');
  await expect(page.locator('[aria-label="Ringkasan status coverage"]')).toContainText('Dilewati');
  await expect(page.locator('[aria-label="Ringkasan status coverage"]')).toContainText('9');
  await expect(page.getByText('LLM10 · planned', {exact: true})).toBeVisible();
  await expect(page.locator('.test-results').getByText('LLM01-direct-policy', {exact: true})).toBeVisible();
  await expect(page.getByText('pass', {exact: true})).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', {name: 'Unduh JSON'}).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('plenger.json');

  const staticRun = page.locator('#history-run option').filter({hasText: 'deterministic'}).first();
  const staticRunId = await staticRun.getAttribute('value');
  if (!staticRunId) throw new Error('Static run is missing from browser history');
  await page.locator('#history-run').selectOption(staticRunId);
  await page.getByLabel('Path yang diizinkan').fill('/slow');
  await page.getByLabel(/Saya memahami biaya internal target/).check();
  await expect(page.getByRole('button', {name: 'Buat plan'})).toBeEnabled();
  await page.getByRole('button', {name: 'Buat plan'}).click();
  await expect(page.locator('.active-preview').getByRole('heading', {name: 'Scope untuk persetujuan'})).toBeVisible();
  await page.getByLabel(/Saya sudah meninjau digest rubric/).check();
  await page.getByRole('button', {name: 'Setujui scope sekali pakai'}).click();
  await expect(page.getByText('Plan disetujui sekali pakai.')).toBeVisible();
  await page.getByRole('button', {name: 'Jalankan fixed suite'}).click();
  await expect(page.getByRole('button', {name: 'Cancel run'})).toBeVisible({timeout: 10_000});
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Hasil analisis'})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Cancel run'})).toBeVisible({timeout: 10_000});
  if (!current.targetProbePath) throw new Error('E2E target probe path is missing');
  await expect.poll(() => readFileSync(current.targetProbePath, 'utf8')).toContain('/slow');
  await page.getByRole('button', {name: 'Cancel run'}).click();
  await expect(page.getByText('Pengujian aktif cancelled.')).toBeVisible({timeout: 20_000});
  await expect(page.locator('#history-run option').filter({hasText: 'cancelled'})).toHaveCount(1);

  await page.route('**/api/v1/projects/*/report?run_id=foreign', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({code: 'not_found', request_id: 'e2e-foreign-report'}),
    });
  });
  await page.locator('#history-run').evaluate((element) => {
    const select = element as HTMLSelectElement;
    select.add(new Option('foreign · not found', 'foreign'));
  });
  await page.locator('#history-run').selectOption('foreign');
  await expect(page.getByRole('alert')).toHaveText(
    'Data yang diminta tidak ditemukan. Muat ulang hasil analisis, lalu coba lagi.',
  );
  await expect(page.getByRole('heading', {name: 'Temuan & bukti'})).not.toBeVisible();
  await expect(page.getByRole('heading', {name: 'Peta definisi'})).not.toBeVisible();
  await page.unroute('**/api/v1/projects/*/report?run_id=foreign');

  await page.getByRole('button', {name: 'Tutup sesi'}).click();
  await expect(page.getByRole('heading', {name: 'Pasangkan browser'})).toBeVisible();
  expect((await page.context().cookies()).some((cookie) => cookie.name === 'plenger_session')).toBe(false);
  if (!sessionCookie) throw new Error('Authenticated session cookie was missing');
  const revokedSession = await page.context().request.get('/api/v1/session', {
    headers: {Cookie: `plenger_session=${sessionCookie.value}`},
  });
  expect(revokedSession.status()).toBe(401);
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Pasangkan browser'})).toBeVisible();
  await expect(page.getByRole('heading', {name: 'Temuan & bukti'})).not.toBeVisible();
});
