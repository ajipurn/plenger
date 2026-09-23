import {appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawn, spawnSync, type ChildProcessWithoutNullStreams} from 'node:child_process';

type E2EState = {
  available: boolean;
  reason?: string;
  code?: string;
  project?: string;
  targetUrl?: string;
  targetProbePath?: string;
};

const repoRoot = resolve(import.meta.dirname, '../..');
const statePath = join(tmpdir(), `plenger-e2e-${process.pid}.json`);

function browserExecutable(): string | null {
  const configured = process.env.PLENGER_E2E_BROWSER;
  if (configured && existsSync(configured)) return configured;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? [
          join(process.env.PROGRAMFILES ?? '', 'Google/Chrome/Application/chrome.exe'),
          join(process.env['PROGRAMFILES(X86)'] ?? '', 'Google/Chrome/Application/chrome.exe'),
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const command of ['google-chrome', 'chromium', 'chromium-browser']) {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const found = result.stdout.trim().split(/\r?\n/)[0];
    if (found && existsSync(found)) return found;
  }
  return null;
}

function writeState(state: E2EState): void {
  mkdirSync(dirname(statePath), {recursive: true, mode: 0o700});
  writeFileSync(statePath, JSON.stringify(state), {mode: 0o600});
  process.env.PLENGER_E2E_STATE = statePath;
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

async function waitForServer(server: ChildProcessWithoutNullStreams, output: {value: string}): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = output.value.match(/kode sekali pakai \(60 detik\):\s*([^\s]+)/i);
    if (match) {
      try {
        const response = await fetch('http://127.0.0.1:7331/api/v1/health', {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) return match[1];
      } catch {
        // The server may have printed the code before uvicorn accepts requests.
      }
    }
    if (server.exitCode !== null) {
      throw new Error(`plenger serve exited early:\n${output.value}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Timed out waiting for plenger serve:\n${output.value}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const browser = browserExecutable();
  if (!browser) {
    writeState({
      available: false,
      reason: 'No supported system browser is installed; browser E2E is skipped.',
    });
    return async () => {
      await rm(statePath, {force: true});
    };
  }
  process.env.PLENGER_E2E_BROWSER = browser;

  const project = await mkdtemp(join(tmpdir(), 'plenger-e2e-project-'));
  const fixture = join(repoRoot, 'fixtures', 'python');
  cpSync(fixture, project, {recursive: true});
  rmSync(join(project, '.plenger'), {recursive: true, force: true});
  run('uv', ['run', '--locked', 'plenger', 'init', project]);
  run('uv', ['run', '--locked', 'plenger', 'scan', '--project', project, '--profile', 'deterministic', '--fixture']);

  const targetProbePath = join(project, '.e2e-target-events');
  writeFileSync(targetProbePath, '', {mode: 0o600});
  const targetServer: Server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/hostile-page') {
      response.writeHead(200, {'Content-Type': 'text/html'});
      response.end('<!doctype html><title>Hostile origin fixture</title>');
      return;
    }
    if (request.method !== 'POST' || !['/test', '/slow'].includes(request.url ?? '')) {
      response.writeHead(404).end();
      return;
    }
    appendFileSync(targetProbePath, `${request.url}\n`);
    request.resume();
    request.on('end', () => {
      const body = JSON.stringify({output_text: 'safe fixture response'});
      const respond = () => {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        });
        response.end(body);
      };
      if (request.url === '/slow') {
        setTimeout(respond, 5_000);
      } else {
        respond();
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    targetServer.once('error', reject);
    targetServer.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = targetServer.address();
  if (!address || typeof address === 'string') throw new Error('Could not determine E2E target port');
  const targetUrl = `http://127.0.0.1:${address.port}`;

  const server = spawn('uv', ['run', '--locked', 'plenger', 'serve', '--project', project], {
    cwd: repoRoot,
    env: {...process.env, PYTHONUNBUFFERED: '1'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = {value: ''};
  server.stdout.on('data', (chunk: Buffer) => { output.value += chunk.toString(); });
  server.stderr.on('data', (chunk: Buffer) => { output.value += chunk.toString(); });
  try {
    const code = await waitForServer(server, output);
    writeState({available: true, code, project, targetProbePath});
  } catch (error) {
    server.kill('SIGTERM');
    targetServer.close();
    await rm(project, {recursive: true, force: true});
    throw error;
  }

  const currentState = JSON.parse(readFileSync(statePath, 'utf8')) as E2EState;
  currentState.targetUrl = targetUrl;
  currentState.targetProbePath = targetProbePath;
  writeState(currentState);

  return async () => {
    if (server.exitCode === null) server.kill('SIGTERM');
    await new Promise<void>((resolvePromise) => {
      if (server.exitCode !== null) {
        resolvePromise();
      } else {
        server.once('exit', () => resolvePromise());
      }
    });
    await new Promise<void>((resolvePromise) => targetServer.close(() => resolvePromise()));
    await rm(project, {recursive: true, force: true});
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as E2EState;
    if (state.project === project) await rm(statePath, {force: true});
  };
}
