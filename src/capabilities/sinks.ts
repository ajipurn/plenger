import type { CapabilityKind } from "../inventory/model.ts";

/**
 * Calls with an effect outside the program: patterns over canonical call names (see
 * inventory/pattern.ts), with the path of the argument that says what the effect acts
 * on (command, path, URL, query, code, recipient).
 */
export interface Sink {
  kind: CapabilityKind;
  calls: string[];
  /** Argument path (inventory/values.ts `select`) of the main input. */
  input?: string;
  /** Take the input from the first call of the chain (`Path(p).write_text()` acts on `p`). */
  chainInput?: boolean;
  /** Python `open()`-style mode argument: a mode with w, a, x or + writes; otherwise it reads. */
  mode?: string;
}

const each = (base: string, members: string) => `${base}.{${members}}`;

const PY_HTTP = "get,post,put,patch,delete,head,options,request,stream,send";
const JS_HTTP = "get,post,put,patch,delete,head,options,request";
const FS = "{node:fs,fs,node:fs/promises,fs/promises,fs-extra}";

export const PYTHON_SINKS: Sink[] = [
  {
    kind: "process",
    calls: [
      each("subprocess", "run,call,check_call,check_output,Popen,getoutput,getstatusoutput"),
      each("os", "system,popen"),
      each("asyncio", "create_subprocess_shell,create_subprocess_exec"),
      "pty.spawn",
      each("pexpect", "spawn,run"),
      "paramiko.SSHClient()**.exec_command",
      "fabric.Connection()**.{run,sudo,local}",
    ],
    input: "args|cmd|command|#0",
  },
  {
    kind: "process",
    calls: [
      each(
        "os",
        "execv,execve,execvp,execvpe,execl,execle,execlp,execlpe,spawnv,spawnve,spawnl,spawnlp,posix_spawn,posix_spawnp",
      ),
    ],
    input: "#0",
  },
  {
    kind: "code",
    calls: [
      "eval",
      "exec",
      "compile",
      "__import__",
      "importlib.import_module",
      each("runpy", "run_path,run_module"),
    ],
    input: "#0",
  },
  {
    kind: "deserialize",
    calls: [
      each("pickle", "load,loads"),
      each("dill", "load,loads"),
      each("cloudpickle", "load,loads"),
      "marshal.loads",
      each("yaml", "unsafe_load,full_load"),
      "joblib.load",
      "torch.load",
      each("shelve", "open"),
    ],
    input: "#0",
  },
  {
    kind: "file_read",
    calls: ["open", "io.open", "aiofiles.open", "codecs.open"],
    input: "file|#0",
    mode: "mode|#1",
  },
  {
    kind: "file_write",
    calls: [
      "pathlib.{Path,PurePath,PosixPath,WindowsPath}()**.{write_text,write_bytes,touch,mkdir,rename,replace,symlink_to,chmod}",
    ],
    chainInput: true,
  },
  {
    kind: "file_write",
    calls: [
      each("shutil", "copy,copy2,copyfile,copytree,move"),
      each("os", "rename,replace,makedirs,mkdir,chmod,chown,symlink,link"),
    ],
    input: "dst|#1|#0",
  },
  {
    kind: "file_delete",
    calls: [each("os", "remove,unlink,rmdir,removedirs"), "shutil.rmtree"],
    input: "path|#0",
  },
  {
    kind: "file_delete",
    calls: ["pathlib.{Path,PurePath,PosixPath,WindowsPath}()**.{unlink,rmdir}"],
    chainInput: true,
  },
  {
    kind: "file_read",
    calls: [
      "pathlib.{Path,PurePath,PosixPath,WindowsPath}()**.{read_text,read_bytes,open,iterdir,glob,rglob}",
    ],
    chainInput: true,
  },
  {
    kind: "file_read",
    calls: [each("os", "listdir,scandir,walk"), each("glob", "glob,iglob")],
    input: "#0",
  },
  {
    kind: "network",
    calls: [
      `requests{,.api}.{${PY_HTTP}}`,
      `requests.Session()**.{${PY_HTTP}}`,
      `httpx.{${PY_HTTP}}`,
      `httpx.{Client,AsyncClient}()**.{${PY_HTTP}}`,
      `aiohttp.ClientSession()**.{${PY_HTTP},ws_connect}`,
      "urllib.request.{urlopen,urlretrieve}",
      "urllib3.PoolManager()**.request",
      "http.client.{HTTPConnection,HTTPSConnection}",
      "socket.{socket,create_connection}",
      "websockets.connect",
      "ftplib.{FTP,FTP_TLS}",
    ],
    input: "url|#0",
  },
  {
    kind: "database",
    calls: [
      "sqlite3.connect()**.{execute,executemany,executescript}",
      "{psycopg2,psycopg,pymysql,MySQLdb,mysql.connector,pyodbc,oracledb,duckdb}.connect()**.{execute,executemany}",
      "asyncpg.{connect,create_pool}()**.{execute,executemany,fetch,fetchrow,fetchval}",
      "sqlalchemy.create_engine()**.{execute,exec_driver_sql}",
      "sqlalchemy.orm.{Session,sessionmaker}()**.{execute,add,add_all,delete,merge,commit}",
      "pymongo.MongoClient()**.{insert_one,insert_many,update_one,update_many,replace_one,delete_one,delete_many,find,find_one,aggregate,drop}",
      "motor.motor_asyncio.AsyncIOMotorClient()**.{insert_one,insert_many,update_one,update_many,delete_one,delete_many,find,find_one}",
      "supabase.create_client()**.{insert,update,upsert,delete,select,rpc}",
      "redis.{Redis,StrictRedis,from_url}()**.{set,delete,hset,lpush,rpush,execute_command}",
    ],
    input: "#0",
  },
  {
    kind: "message",
    calls: [
      "smtplib.{SMTP,SMTP_SSL}()**.{sendmail,send_message}",
      "slack_sdk.{WebClient,AsyncWebClient}()**.{chat_postMessage,chat_postEphemeral,files_upload_v2}",
      "twilio.rest.Client()**.messages.create",
      "sendgrid.SendGridAPIClient()**.send",
      "resend.Emails.send",
      "telegram.Bot()**.send_message",
      "discord_webhook.DiscordWebhook()**.execute",
    ],
    input: "to_addrs|to|channel|chat_id|#1|#0",
  },
  {
    kind: "payment",
    calls: [
      "stripe.{PaymentIntent,Charge,Refund,Transfer,Payout,Subscription,Invoice,Customer,checkout.Session}.{create,modify,cancel,delete,confirm,capture}",
      "stripe.StripeClient()**.{payment_intents,charges,refunds,transfers,payouts,subscriptions}.{create,update,cancel,confirm,capture}",
    ],
    input: "amount",
  },
  {
    kind: "secret",
    calls: [
      each("os", "getenv,environ.get"),
      "keyring.get_password",
      "**.get_secret_value",
      "hvac.Client()**.read_secret_version",
    ],
    input: "key|#0",
  },
  {
    kind: "browser",
    calls: ["playwright.**.goto", "selenium.webdriver.**.get", "pyppeteer.**.goto"],
    input: "url|#0",
  },
];

export const JAVASCRIPT_SINKS: Sink[] = [
  {
    kind: "process",
    calls: [
      "{node:child_process,child_process}#{exec,execSync,spawn,spawnSync,execFile,execFileSync,fork}",
      "execa#{execa,execaSync,execaCommand,execaCommandSync,$}",
      "zx#$",
      "shelljs{#default,}.exec",
      "Bun.spawn",
      "Bun.spawnSync",
      "Bun.$",
      "Deno.Command",
      "Deno.run",
    ],
    input: "#0",
  },
  {
    kind: "code",
    calls: [
      "eval",
      "Function",
      "{node:vm,vm}#{runInNewContext,runInThisContext,runInContext,compileFunction,Script}",
      "vm2#{VM,NodeVM}().run",
    ],
    input: "#0",
  },
  {
    kind: "deserialize",
    calls: ["node-serialize{#default,}.unserialize", "node-serialize#unserialize"],
    input: "#0",
  },
  {
    kind: "file_write",
    calls: [
      `${FS}#{writeFile,writeFileSync,appendFile,appendFileSync,mkdir,mkdirSync,rename,renameSync,copyFile,copyFileSync,cp,cpSync,createWriteStream,symlink,chmod,outputFile,outputJson,writeJson,copy,move,ensureDir}`,
      `${FS}#{promises,default}.{writeFile,appendFile,mkdir,rename,copyFile,cp,symlink,chmod}`,
      "Bun.write",
    ],
    input: "#0",
  },
  {
    kind: "file_delete",
    calls: [
      `${FS}#{unlink,unlinkSync,rm,rmSync,rmdir,rmdirSync,remove,removeSync,emptyDir}`,
      `${FS}#{promises,default}.{unlink,rm,rmdir}`,
      "rimraf#{rimraf,default,sync}",
    ],
    input: "#0",
  },
  {
    kind: "file_read",
    calls: [
      `${FS}#{readFile,readFileSync,readdir,readdirSync,createReadStream,opendir,readJson}`,
      `${FS}#{promises,default}.{readFile,readdir,opendir}`,
      "Bun.file",
    ],
    input: "#0",
  },
  {
    kind: "network",
    calls: [
      "fetch",
      `axios{#default,}{,.${JS_HTTP.split(",").join(",.")}}`,
      `axios{#default,}.create()**.{${JS_HTTP}}`,
      "{node:http,node:https,http,https}#{request,get}",
      `got{#default,}{,.${JS_HTTP.split(",").join(",.")}}`,
      "undici#{fetch,request,stream}",
      `ky{#default,}{,.${JS_HTTP.split(",").join(",.")}}`,
      "node-fetch{#default,}",
      "{node:net,net}#{connect,createConnection}",
      "WebSocket",
      "ws{#default,#WebSocket}",
    ],
    input: "#0|url",
  },
  {
    kind: "database",
    calls: [
      "pg#{Client,Pool}()**.query",
      "{pg,postgres}{#default,}()**.{unsafe,query}",
      "mysql2{,/promise}#{createConnection,createPool}()**.{query,execute}",
      "better-sqlite3{#default,}()**.{exec,prepare}",
      "@prisma/client#PrismaClient()**.{create,createMany,update,updateMany,upsert,delete,deleteMany,findMany,findUnique,findFirst,$executeRaw,$executeRawUnsafe,$queryRaw,$queryRawUnsafe}",
      "mongodb#MongoClient()**.{insertOne,insertMany,updateOne,updateMany,replaceOne,deleteOne,deleteMany,find,findOne,aggregate,drop}",
      "@supabase/supabase-js#createClient()**.{insert,update,upsert,delete,select,rpc}",
      "drizzle-orm/**#drizzle()**.{insert,update,delete,select,execute}",
      "knex{#default,}()**.{insert,update,del,delete,select,raw}",
      "redis#createClient()**.{set,del,hSet,lPush,rPush,sendCommand}",
      "ioredis{#default,}()**.{set,del,hset,lpush,rpush,call}",
    ],
    input: "#0",
  },
  {
    kind: "message",
    calls: [
      "nodemailer{#default,}.createTransport()**.sendMail",
      "@slack/web-api#WebClient()**.chat.{postMessage,postEphemeral}",
      "twilio{#default,}()**.messages.create",
      "resend#Resend()**.emails.send",
      "@sendgrid/mail{#default,}.send",
      "discord.js#**.send",
    ],
    input: "#0.to|#0.channel|#0",
  },
  {
    kind: "payment",
    calls: [
      "stripe{#default,#Stripe,}()**.{paymentIntents,charges,refunds,transfers,payouts,subscriptions,invoices}.{create,update,cancel,confirm,capture}",
    ],
    input: "#0.amount",
  },
  {
    kind: "browser",
    calls: [
      "playwright{,-core}#*.launch()**.goto",
      "@playwright/test#**.goto",
      "puppeteer{,-core}{#default,}.launch()**.goto",
    ],
    input: "#0",
  },
];

/** Built-in tools whose effect is known from their name. `hosted`: it runs at the model provider. */
export const BUILTIN_TOOL_CAPABILITIES: { name: RegExp; kind: CapabilityKind; hosted?: boolean }[] =
  [
    { name: /^(?:ShellTool|LocalShellTool|shellTool)$/, kind: "process" },
    { name: /^(?:ApplyPatchTool|applyPatchTool|FileWriterTool)$/, kind: "file_write" },
    {
      name: /^(?:CodeInterpreterTool|codeInterpreterTool|CodeExecutionTool)$/,
      kind: "code",
      hosted: true,
    },
    { name: /^(?:PythonInterpreterTool|CodeInterpreterTool)$/, kind: "code" },
    { name: /^(?:ComputerTool|computerTool|BrowserbaseLoadTool)$/, kind: "browser" },
    {
      name: /^(?:WebSearchTool|webSearchTool|WebFetchTool|XSearchTool)$/,
      kind: "network",
      hosted: true,
    },
    { name: /^(?:FileSearchTool|fileSearchTool)$/, kind: "file_read", hosted: true },
    { name: /^(?:HostedMCPTool|hostedMcpTool|MCPServerTool)$/, kind: "mcp", hosted: true },
    {
      name: /Search|Scrape|Serper|Website|Web|Visit|Wikipedia|Firecrawl|Exa|Tavily|Browser|Crawl/,
      kind: "network",
    },
    {
      name: /FileRead|DirectoryRead|DirectorySearch|PDF|CSV|DOCX|JSONSearch|TXTSearch|XMLSearch|MDX/,
      kind: "file_read",
    },
    { name: /SQL|Database|PG|MySQL|Postgres|Snowflake/, kind: "database" },
  ];
