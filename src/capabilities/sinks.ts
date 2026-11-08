import type { CapabilityKind } from "../inventory/model.ts";

/**
 * Calls with an effect outside the program: patterns over canonical call names (see
 * facts/pattern.ts), with the path of the argument that says what the effect acts
 * on (command, path, URL, query, code, recipient).
 */
export interface Sink {
  kind: CapabilityKind;
  calls: string[];
  /** Calls the patterns of `calls` match that are not this sink. */
  except?: string[];
  /** Argument path of an option that, set to a literal true, makes the call safe (`weights_only=True`). */
  safeOption?: string;
  /**
   * The call is this sink only when the argument at `option` names a matching value: a
   * loader that builds objects (`yaml.load(s, Loader=yaml.Loader)`) or a literal true
   * (`numpy.load(f, allow_pickle=True)`). Without one the call is safe.
   */
  requires?: { option: string; value: RegExp };
  /** Argument path (facts/query.ts `select`) of the main input. */
  input?: string;
  /** Take the input from the first call of the chain (`Path(p).write_text()` acts on `p`). */
  chainInput?: boolean;
  /** Python `open()`-style mode argument: a mode with w, a, x or + writes; otherwise it reads. */
  mode?: string;
  /**
   * For files: the call opens what the file at the path holds, which fails for a path
   * that ends in `..`, a directory. Listing, linking, moving or changing a path acts on
   * `..` itself.
   */
  contents?: true;
  /**
   * For `process`: the command runs through a shell (`true`), or does when the option
   * at this argument path is true (`shell=True`, `{ shell: true }`). Otherwise the
   * input names the program and `args` holds its arguments.
   */
  shell?: true | string;
  /** For `process`: argument path of the program's arguments; `*` for every positional argument after the first. */
  args?: string;
  /** For `process`: interpolations are quoted one argument each (`zx`'s and Bun's `$` templates). */
  quoted?: true;
  /** For `database`: the input is a query in a query language (SQL), not data. */
  query?: true;
  /** For `code`: the input is a template a template engine compiles and runs. */
  template?: true;
  /** Also matches calls on the project's own classes, such as a Django model's manager. */
  projectClasses?: true;
}

const each = (base: string, members: string) => `${base}.{${members}}`;

const PY_HTTP = "get,post,put,patch,delete,head,options,request,stream,send";
const JS_HTTP = "get,post,put,patch,delete,head,options,request";
// A default import of a Node built-in reads like `require` (`node:fs#readFile`); one of
// fs-extra, a CommonJS package, reads `fs-extra#default.readFile`.
const FS = "{node:fs,fs,node:fs/promises,fs/promises,fs-extra}";
const PATH = "pathlib.{Path,PurePath,PosixPath,WindowsPath}()";
/**
 * A pathlib chain past a member that is no longer a path: text (`Path(p).suffix`,
 * `Path(p).read_text()`), its parts, or an open file. `Path(p).suffix.replace(".", "")`
 * is `str.replace`.
 */
const PATH_TEXT = `${PATH}**.{name,stem,suffix,suffixes,parts,anchor,drive,root,as_posix(),as_uri(),read_text(),read_bytes(),open()}.**`;

export const PYTHON_SINKS: Sink[] = [
  {
    kind: "process",
    calls: [each("subprocess", "run,call,check_call,check_output,Popen")],
    input: "args|cmd|command|#0",
    shell: "shell",
  },
  {
    kind: "process",
    calls: [
      each("subprocess", "getoutput,getstatusoutput"),
      each("os", "system,popen"),
      "asyncio.create_subprocess_shell",
      "paramiko.SSHClient()**.exec_command",
      "fabric.Connection()**.{run,sudo,local}",
    ],
    input: "args|cmd|command|#0",
    shell: true,
  },
  {
    kind: "process",
    calls: [
      "asyncio.create_subprocess_exec",
      each("os", "execl,execle,execlp,execlpe,spawnl,spawnle,spawnlp,spawnlpe"),
    ],
    input: "program|#0",
    args: "*",
  },
  {
    kind: "process",
    calls: [
      each(
        "os",
        "execv,execve,execvp,execvpe,spawnv,spawnve,spawnvp,spawnvpe,posix_spawn,posix_spawnp",
      ),
    ],
    input: "path|file|#0",
    args: "argv|args|#1",
  },
  {
    kind: "process",
    calls: ["pty.spawn", each("pexpect", "spawn,run")],
    input: "argv|command|#0",
    args: "args|#1",
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
    kind: "code",
    calls: [
      "flask.render_template_string",
      "jinja2.Template",
      "jinja2.Environment()**.from_string",
      "mako.template.Template",
      "django.template.Template",
    ],
    input: "source|text|template_string|#0",
    template: true,
  },
  {
    kind: "database",
    calls: [
      "django.db.connection.cursor()**.{execute,executemany}",
      "django.db.connections**.cursor()**.{execute,executemany}",
      "django.db.models{,.expressions}.RawSQL",
      "sqlalchemy{,.sql,.sql.expression}.text",
    ],
    input: "sql|text|#0",
    query: true,
  },
  {
    kind: "database",
    calls: ["**.objects.{raw,extra}"],
    input: "raw_query|select|where|#0",
    query: true,
    projectClasses: true,
  },
  {
    // Prisma Client Python's raw SQL, on the client or a project object holding it.
    kind: "database",
    calls: ["**.{query_raw,query_first,execute_raw}"],
    input: "query|#0",
    query: true,
    projectClasses: true,
  },
  {
    kind: "deserialize",
    calls: [
      each("pickle", "load,loads"),
      each("dill", "load,loads"),
      each("cloudpickle", "load,loads"),
      "marshal.loads",
      each("yaml", "unsafe_load,full_load,unsafe_load_all,full_load_all"),
      "joblib.load",
      each("shelve", "open"),
      "pandas.read_pickle",
      "statsmodels.{iolib,iolib.api,iolib.smpickle,api}.load_pickle",
    ],
    input: "filepath_or_buffer|fname|#0",
  },
  {
    kind: "deserialize",
    calls: [each("yaml", "load,load_all")],
    input: "stream|#0",
    // These loaders build Python objects from tags; SafeLoader and BaseLoader do not.
    requires: { option: "Loader|#1", value: /(?:^|\.)C?(?:Unsafe|Full)?Loader$/ },
  },
  {
    kind: "deserialize",
    calls: ["numpy.load"],
    input: "file|#0",
    // Object arrays are unpickled only when allowed; the default refuses them.
    requires: { option: "allow_pickle", value: /^(?:True|true)$/ },
  },
  {
    // Hub code named by a model's `auto_map`, downloaded and imported.
    kind: "code",
    calls: [
      "transformers{,.dynamic_module_utils}.{get_class_from_dynamic_module,get_cached_module_file}",
    ],
    input: "class_reference|#0",
  },
  {
    kind: "deserialize",
    calls: ["torch.load"],
    input: "#0",
    // `weights_only=True` loads tensors and plain containers with an unpickler that
    // refuses other classes.
    safeOption: "weights_only",
  },
  {
    kind: "file_read",
    calls: ["open", "io.open", "aiofiles.open", "codecs.open"],
    input: "file|#0",
    mode: "mode|#1",
    contents: true,
  },
  {
    // Responses that send the file at a path (`send_from_directory` joins safely).
    kind: "file_read",
    calls: ["flask{,.helpers}.send_file", "{fastapi,starlette}.responses.FileResponse"],
    input: "path_or_file|path|#0",
    contents: true,
  },
  {
    kind: "file_write",
    calls: [`${PATH}**.{write_text,write_bytes}`],
    except: [PATH_TEXT],
    chainInput: true,
    contents: true,
  },
  {
    kind: "file_write",
    calls: [`${PATH}**.{touch,mkdir,rename,replace,symlink_to,chmod}`],
    except: [PATH_TEXT],
    chainInput: true,
  },
  {
    kind: "file_write",
    calls: [
      each("shutil", "copy,copy2,copyfile,copytree,move"),
      each("os", "rename,replace,symlink,link"),
    ],
    input: "dst|#1|#0",
  },
  {
    // The second argument of these is a mode or an owner, not a path.
    kind: "file_write",
    calls: [each("os", "makedirs,mkdir,chmod,chown")],
    input: "path|name|#0",
  },
  {
    kind: "file_delete",
    calls: [each("os", "remove,unlink,rmdir,removedirs"), "shutil.rmtree"],
    input: "path|#0",
  },
  {
    kind: "file_delete",
    calls: [`${PATH}**.{unlink,rmdir}`],
    except: [PATH_TEXT],
    chainInput: true,
  },
  {
    kind: "file_read",
    calls: [`${PATH}**.{read_text,read_bytes,open}`],
    except: [PATH_TEXT],
    chainInput: true,
    contents: true,
  },
  {
    kind: "file_read",
    calls: [`${PATH}**.{iterdir,glob,rglob}`],
    except: [PATH_TEXT],
    chainInput: true,
    // `base.glob("../../*")` climbs out of the base its pattern is matched under.
    input: "pattern|#0",
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
      "sqlalchemy.orm.{Session,sessionmaker}()**.execute",
    ],
    input: "#0",
    query: true,
  },
  {
    kind: "database",
    calls: [
      "sqlalchemy.orm.{Session,sessionmaker}()**.{add,add_all,delete,merge,commit}",
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
    calls: ["{node:child_process,child_process}#{exec,execSync}", "shelljs{#default,}.exec"],
    input: "#0",
    shell: true,
  },
  {
    kind: "process",
    calls: [
      "{node:child_process,child_process}#{spawn,spawnSync,execFile,execFileSync,fork}",
      "execa#{execa,execaSync}",
    ],
    input: "#0",
    args: "#1",
    shell: "#1.shell|#2.shell",
  },
  {
    kind: "process",
    calls: ["execa#{execaCommand,execaCommandSync}", "Bun.spawn", "Bun.spawnSync", "Deno.run"],
    input: "#0.cmd|cmd|#0",
  },
  {
    kind: "process",
    calls: ["Deno.Command"],
    input: "#0",
    args: "#1.args",
  },
  {
    kind: "process",
    calls: ["execa#$", "zx#$", "Bun.$"],
    input: "#0",
    quoted: true,
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
    kind: "code",
    calls: [
      "ejs{#default,}.{render,compile}",
      "ejs#{render,compile}",
      "handlebars{#default,}.compile",
      "handlebars#compile",
      "pug{#default,}.{compile,render}",
      "pug#{compile,render}",
      "nunjucks{#default,}.renderString",
      "nunjucks#renderString",
      "nunjucks{#default,#Environment,.Environment}()**.renderString",
      "lodash{#default,}.template",
      "lodash#template",
      "lodash.template{#default,}",
      "underscore{#default,}.template",
      "underscore#template",
    ],
    input: "#0",
    template: true,
  },
  {
    kind: "database",
    calls: [
      "sequelize{#default,#Sequelize}()**.query",
      "typeorm#{DataSource,Connection}()**.query",
      "typeorm#{getManager,getConnection,getRepository}()**.query",
    ],
    input: "#0",
    query: true,
  },
  {
    // Prisma's unsafe raw SQL, and Pyodide's Python, on objects projects often wrap.
    kind: "database",
    calls: ["**.{$queryRawUnsafe,$executeRawUnsafe}"],
    input: "#0",
    query: true,
    projectClasses: true,
  },
  {
    kind: "code",
    calls: ["**.{runPython,runPythonAsync}"],
    input: "#0",
    projectClasses: true,
  },
  {
    kind: "deserialize",
    calls: ["node-serialize{#default,}.unserialize", "node-serialize#unserialize"],
    input: "#0",
  },
  {
    kind: "file_write",
    calls: [
      `${FS}{#,#default.}{writeFile,writeFileSync,appendFile,appendFileSync,createWriteStream,outputFile,outputJson,writeJson}`,
      `${FS}#{promises,default}.{writeFile,appendFile}`,
      "Bun.write",
    ],
    input: "#0",
    contents: true,
  },
  {
    kind: "file_write",
    calls: [
      `${FS}{#,#default.}{mkdir,mkdirSync,rename,renameSync,copyFile,copyFileSync,cp,cpSync,symlink,chmod,copy,move,ensureDir}`,
      `${FS}#{promises,default}.{mkdir,rename,copyFile,cp,symlink,chmod}`,
    ],
    input: "#0",
  },
  {
    kind: "file_delete",
    calls: [
      `${FS}{#,#default.}{unlink,unlinkSync,rm,rmSync,rmdir,rmdirSync,remove,removeSync,emptyDir}`,
      `${FS}#{promises,default}.{unlink,rm,rmdir}`,
      "rimraf#{rimraf,default,sync}",
    ],
    input: "#0",
  },
  {
    kind: "file_read",
    calls: [
      `${FS}{#,#default.}{readFile,readFileSync,createReadStream,readJson}`,
      `${FS}#{promises,default}.readFile`,
      "Bun.file",
    ],
    input: "#0",
    contents: true,
  },
  {
    kind: "file_read",
    calls: [
      `${FS}{#,#default.}{readdir,readdirSync,opendir}`,
      `${FS}#{promises,default}.{readdir,opendir}`,
    ],
    input: "#0",
  },
  {
    kind: "network",
    calls: [
      "fetch",
      // A default import reads `axios#default.get`; `require("axios")` reads `axios#get`.
      "axios{#default,}",
      `axios{#default.,#}{${JS_HTTP}}`,
      `axios{#default.,#}create()**.{${JS_HTTP}}`,
      "{node:http,node:https,http,https}#{request,get}",
      "got{#default,}",
      `got{#default.,#}{${JS_HTTP}}`,
      "undici#{fetch,request,stream}",
      "ky{#default,}",
      `ky{#default.,#}{${JS_HTTP}}`,
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
      "@prisma/client#PrismaClient()**.{$executeRawUnsafe,$queryRawUnsafe}",
      "knex{#default,}()**.raw",
    ],
    input: "#0",
    query: true,
  },
  {
    kind: "database",
    calls: [
      "@prisma/client#PrismaClient()**.{create,createMany,update,updateMany,upsert,delete,deleteMany,findMany,findUnique,findFirst,$executeRaw,$queryRaw}",
      "mongodb#MongoClient()**.{insertOne,insertMany,updateOne,updateMany,replaceOne,deleteOne,deleteMany,find,findOne,aggregate,drop}",
      "@supabase/supabase-js#createClient()**.{insert,update,upsert,delete,select,rpc}",
      "drizzle-orm/**#drizzle()**.{insert,update,delete,select,execute}",
      "knex{#default,}()**.{insert,update,del,delete,select}",
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
    // The Claude Agent SDK's tools, by the names `allowed_tools` gives them.
    { name: /^Bash$/, kind: "process" },
    { name: /^(?:Write|Edit|MultiEdit|NotebookEdit)$/, kind: "file_write" },
    { name: /^(?:Read|Glob|Grep)$/, kind: "file_read" },
    { name: /^WebSearch$/, kind: "network", hosted: true },
    {
      name: /^(?:ApplyPatchTool|applyPatchTool|FileWriterTool|WriteFileTool|CopyFileTool|MoveFileTool)$/,
      kind: "file_write",
    },
    { name: /^DeleteFileTool$/, kind: "file_delete" },
    { name: /^(?:ReadFileTool|ListDirectoryTool)$/, kind: "file_read" },
    { name: /^Requests(?:Get|Post|Patch|Put|Delete)Tool$/, kind: "network" },
    {
      name: /^(?:CodeInterpreterTool|codeInterpreterTool|CodeExecutionTool)$/,
      kind: "code",
      hosted: true,
    },
    {
      name: /^(?:PythonInterpreterTool|CodeInterpreterTool|PythonREPLTool|PythonAstREPLTool)$/,
      kind: "code",
    },
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

/**
 * Calls that check or narrow an input before an effect uses it. Seeing one lowers
 * confidence in a finding; it does not prove the check is right.
 */
export const GUARDS: { kinds: CapabilityKind[]; calls: string[] }[] = [
  {
    kinds: ["file_read", "file_write", "file_delete"],
    calls: [
      "os.path.{realpath,abspath,normpath,commonpath,commonprefix,basename}",
      `${PATH}**.{resolve,is_relative_to,relative_to}`,
      "werkzeug.utils.secure_filename",
      "{node:path,path}#{resolve,normalize,basename,relative}",
      "{node:path,path}#default.{resolve,normalize,basename,relative}",
      "{node:fs,fs,node:fs/promises,fs/promises}#{realpath,realpathSync}",
      "sanitize-filename{#default,}",
    ],
  },
  {
    kinds: ["network", "browser"],
    calls: [
      "urllib.parse.{urlparse,urlsplit}",
      "ipaddress.{ip_address,ip_network}",
      "validators.url",
      "URL",
      "ipaddr.js{#default,}.{parse,process}",
      "ssrf-req-filter{#default,}",
      "request-filtering-agent#*",
    ],
  },
  {
    kinds: ["process"],
    calls: ["shlex.{quote,join}", "shell-quote#quote", "shell-escape{#default,}"],
  },
];

/** Calls that stop and ask a person before going on. */
export const APPROVAL_CALLS: string[] = [
  "input",
  "builtins.input",
  "click.{confirm,prompt}",
  "typer.{confirm,prompt}",
  "rich.prompt.{Confirm,Prompt}.ask",
  "questionary.confirm",
  "langgraph.types.interrupt",
  "@langchain/langgraph#interrupt",
  "{node:readline,readline,node:readline/promises,readline/promises}#createInterface()**.question",
  "@inquirer/prompts#confirm",
  "@inquirer/confirm{#default,}",
  "confirm",
];

/** Tool and agent options that make a person approve calls (`needs_approval=True`, `needsApproval: true`). */
export const APPROVAL_OPTIONS = [
  "needs_approval",
  "requires_approval",
  "require_approval",
  "needsApproval",
  "requireApproval",
  "requiresApproval",
];
