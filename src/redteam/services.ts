import { randomBytes, randomUUID } from "node:crypto";
import { FASTAPI_SERVICES, type FastapiService } from "./constants.ts";
import { EXPIRES_LABEL, removeContainer, runContainer } from "./worker.ts";

/** Margin past the deadline for the expiry label, as for workers. */
const BACKSTOP_GRACE_MS = 10_000;
const SERVICE_LIMITS: Record<FastapiService, { memory: string; pids: number }> = {
  mysql: { memory: "768m", pids: 256 },
  redis: { memory: "128m", pids: 64 },
};

export interface DisposableService {
  name: FastapiService;
  image: string;
  /** The network alias the application reaches the service through. */
  host: string;
  port: number;
  ready: boolean;
}

/** The services of one preparation: a private network, one container each, and the settings the worker receives. */
export interface DisposableServices {
  network: string;
  services: DisposableService[];
  /** Conventional connection settings for the application; the values exist for this run only. */
  env: Record<string, string>;
  /** Remove every container and the network. Resolves to whether all of them are confirmed gone. */
  dispose: () => Promise<boolean>;
}

/** Starts the named services and waits for each to answer. */
export type ServiceLauncher = (
  engine: "docker" | "podman",
  names: readonly FastapiService[],
  signal: AbortSignal,
  options: { timeoutMs: number },
) => Promise<DisposableServices>;

/** Pull a pinned service image once; an image already present is not contacted again. */
export async function pullServiceImage(
  engine: "docker" | "podman",
  image: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await runContainer({
      engine,
      args: ["image", "inspect", "--format", "{{.Id}}", image],
      input: "",
      timeoutMs: 10_000,
      signal,
    });
    return;
  } catch {
    signal.throwIfAborted();
  }
  await runContainer({
    engine,
    args: ["pull", "--quiet", image],
    input: "",
    timeoutMs: 600_000,
    signal,
    maxOutputBytes: 1024 * 1024,
  });
}

/** `network create` for a network with no route out of it. */
export function networkArguments(
  engine: "docker" | "podman",
  name: string,
  expiresAt: number,
): string[] {
  return [
    "network",
    "create",
    "--internal",
    "--label",
    `org.plenger.purpose=redteam-services`,
    "--label",
    `${EXPIRES_LABEL}=${expiresAt}`,
    ...(engine === "podman" ? [] : ["--driver", "bridge"]),
    name,
  ];
}

/** `run` arguments for one service: pinned image, private network, no published ports, bounded resources. */
export function serviceRunArguments(
  engine: "docker" | "podman",
  service: FastapiService,
  options: { container: string; network: string; expiresAt: number; env: Record<string, string> },
): string[] {
  const limits = SERVICE_LIMITS[service];
  const image = FASTAPI_SERVICES[service].image;
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    options.container,
    "--label",
    "org.plenger.purpose=redteam-services",
    "--label",
    `${EXPIRES_LABEL}=${options.expiresAt}`,
    "--pull=never",
    `--network=${options.network}`,
    `--network-alias=${service}`,
    "--cap-drop=ALL",
    // The MySQL entrypoint runs as root, prepares a data directory owned by the mysql
    // user and switches to that user; it needs exactly these file and identity capabilities.
    // Redis needs none: it starts as its own user and keeps nothing on disk here.
    ...(service === "mysql"
      ? [
          "--cap-add=CHOWN",
          "--cap-add=DAC_OVERRIDE",
          "--cap-add=FOWNER",
          "--cap-add=SETGID",
          "--cap-add=SETUID",
        ]
      : ["--user=999:999"]),
    "--security-opt=no-new-privileges",
    `--pids-limit=${limits.pids}`,
    `--memory=${limits.memory}`,
    `--memory-swap=${limits.memory}`,
    "--cpus=1",
    "--restart=no",
    "--stop-timeout=0",
    "--no-healthcheck",
    "--log-driver=none",
    ...(engine === "podman"
      ? [`--timeout=${Math.ceil((options.expiresAt - Date.now()) / 1000)}`]
      : []),
    ...Object.entries(options.env).map(([key, value]) => `--env=${key}=${value}`),
    image,
    ...(service === "redis" ? ["redis-server", "--save", "", "--appendonly", "no"] : []),
  ];
}

/** Random credentials that live only in this process and the service containers. */
function credentials(): { user: string; password: string; database: string } {
  return {
    user: "plenger",
    password: randomBytes(18).toString("base64url"),
    database: "plenger",
  };
}

/** Start MySQL and Redis on a private network, wait until both answer, and return their settings. */
export const startDisposableServices: ServiceLauncher = async (engine, names, signal, options) => {
  const id = randomUUID();
  const network = `plenger-services-${id}`;
  const expiresAt = Date.now() + options.timeoutMs + BACKSTOP_GRACE_MS;
  const command = (args: string[], timeoutMs = 30_000) =>
    runContainer({ engine, args, input: "", timeoutMs, signal, maxOutputBytes: 65536 });
  const services: DisposableService[] = [];
  const containers: string[] = [];
  const env: Record<string, string> = {};
  const mysql = credentials();
  const dispose = async (): Promise<boolean> => {
    let confirmed = true;
    for (const container of containers) {
      try {
        await removeContainer(engine, container);
      } catch {
        confirmed = false;
      }
    }
    try {
      await runContainer({
        engine,
        args: ["network", "rm", network],
        input: "",
        timeoutMs: 30_000,
        maxOutputBytes: 65536,
      });
    } catch {
      confirmed = false;
    }
    return confirmed;
  };
  try {
    for (const name of names) await pullServiceImage(engine, FASTAPI_SERVICES[name].image, signal);
    await command(networkArguments(engine, network, expiresAt));
    for (const name of names) {
      const container = `plenger-service-${name}-${id}`;
      const serviceEnv =
        name === "mysql"
          ? {
              MYSQL_ROOT_PASSWORD: mysql.password,
              MYSQL_DATABASE: mysql.database,
              MYSQL_USER: mysql.user,
              MYSQL_PASSWORD: mysql.password,
            }
          : {};
      containers.push(container);
      await command(
        serviceRunArguments(engine, name, { container, network, expiresAt, env: serviceEnv }),
      );
      services.push({
        name,
        image: FASTAPI_SERVICES[name].image,
        host: name,
        port: FASTAPI_SERVICES[name].port,
        ready: false,
      });
    }
    const deadline = Date.now() + Math.min(options.timeoutMs, 180_000);
    for (const service of services) {
      const probe =
        service.name === "mysql"
          ? [
              "exec",
              `plenger-service-mysql-${id}`,
              "mysqladmin",
              "ping",
              "-h127.0.0.1",
              "-uroot",
              `-p${mysql.password}`,
            ]
          : ["exec", `plenger-service-redis-${id}`, "redis-cli", "ping"];
      while (!service.ready) {
        signal.throwIfAborted();
        try {
          const answer = await command(probe, 10_000);
          service.ready = service.name === "mysql" ? /alive/.test(answer) : /PONG/.test(answer);
        } catch {
          /* not accepting connections yet */
        }
        if (service.ready) break;
        if (Date.now() >= deadline)
          throw new Error(`The disposable ${service.name} service did not become ready in time.`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (names.includes("mysql"))
      Object.assign(env, {
        MYSQL_HOST: "mysql",
        MYSQL_PORT: String(FASTAPI_SERVICES.mysql.port),
        MYSQL_USER: mysql.user,
        MYSQL_PASSWORD: mysql.password,
        MYSQL_DATABASE: mysql.database,
      });
    if (names.includes("redis"))
      Object.assign(env, {
        REDIS_HOST: "redis",
        REDIS_PORT: String(FASTAPI_SERVICES.redis.port),
        REDIS_DB: "0",
      });
    return { network, services, env, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
};

/**
 * Remove service networks left by a host process that died, by the same expiry label as
 * workers. Containers on them carry the label too and are removed by the worker sweep.
 */
export async function removeExpiredNetworks(
  engine: "docker" | "podman",
  now = Date.now(),
): Promise<number> {
  const command = (args: string[]) =>
    runContainer({ engine, args, input: "", timeoutMs: 10_000, maxOutputBytes: 65536 });
  let ids: string[];
  try {
    ids = (await command(["network", "ls", "--quiet", "--filter", `label=${EXPIRES_LABEL}`]))
      .split("\n")
      .map((id) => id.trim())
      .filter(Boolean);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const id of ids) {
    try {
      const label = (
        await command([
          "network",
          "inspect",
          "--format",
          `{{index .Labels "${EXPIRES_LABEL}"}}`,
          id,
        ])
      ).trim();
      if (!/^\d{1,16}$/.test(label) || Number(label) >= now) continue;
      await command(["network", "rm", id]);
      removed++;
    } catch {
      // In use by a live run or already gone; the next sweep retries.
    }
  }
  return removed;
}
