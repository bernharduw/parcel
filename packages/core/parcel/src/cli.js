// @flow

import type {InitialParcelOptions} from '@parcel/types';
import {BuildError} from '@parcel/core';
import {NodePackageManager} from '@parcel/package-manager';
import {NodeFS} from '@parcel/fs';
import ThrowableDiagnostic from '@parcel/diagnostic';
import {prettyDiagnostic, openInBrowser} from '@parcel/utils';
import {Disposable} from '@parcel/events';
import {INTERNAL_ORIGINAL_CONSOLE} from '@parcel/logger';
import chalk from 'chalk';
import program from 'commander';
import path from 'path';
import getPort from 'get-port';
import {version} from '../package.json';

require('v8-compile-cache');

// Exit codes in response to signals are traditionally
// 128 + signal value
// https://tldp.org/LDP/abs/html/exitcodes.html
const SIGINT_EXIT_CODE = 130;

async function logUncaughtError(e: mixed) {
  if (e instanceof ThrowableDiagnostic) {
    for (let diagnostic of e.diagnostics) {
      let out = await prettyDiagnostic(diagnostic);
      INTERNAL_ORIGINAL_CONSOLE.error(out.message);
      INTERNAL_ORIGINAL_CONSOLE.error(out.codeframe || out.stack);
      for (let h of out.hints) {
        INTERNAL_ORIGINAL_CONSOLE.error(h);
      }
    }
  } else {
    INTERNAL_ORIGINAL_CONSOLE.error(e);
  }

  // A hack to definitely ensure we logged the uncaught exception
  await new Promise(resolve => setTimeout(resolve, 100));
}

const handleUncaughtException = async exception => {
  try {
    await logUncaughtError(exception);
  } catch (err) {
    console.error(exception);
    console.error(err);
  }

  process.exit(1);
};

process.on('unhandledRejection', handleUncaughtException);

// Capture the NODE_ENV this process was launched with, so that it can be
// used in Parcel (such as in process.env inlining).
const initialNodeEnv = process.env.NODE_ENV;
// Then, override NODE_ENV to be PARCEL_BUILD_ENV (replaced with `production` in builds)
// so that dependencies of Parcel like React (which renders the cli through `ink`)
// run in the appropriate mode.
if (typeof process.env.PARCEL_BUILD_ENV === 'string') {
  process.env.NODE_ENV = process.env.PARCEL_BUILD_ENV;
}

program.version(version);

// --no-cache, --cache-dir, --no-source-maps, --no-autoinstall, --global?, --public-url, --log-level
// --no-content-hash, --experimental-scope-hoisting, --detailed-report

const commonOptions = {
  '--no-cache': 'disable the filesystem cache',
  '--config <path>':
    'specify which config to use. can be a path or a package name',
  '--cache-dir <path>': 'set the cache directory. defaults to ".parcel-cache"',
  '--no-source-maps': 'disable sourcemaps',
  '--no-content-hash': 'disable content hashing',
  '--target [name]': [
    'only build given target(s)',
    (val, list) => list.concat([val]),
    [],
  ],
  '--log-level <level>': [
    'set the log level, either "none", "error", "warn", "info", or "verbose".',
    /^(none|error|warn|info|verbose)$/,
  ],
  '--dist-dir <dir>':
    'output directory to write to when unspecified by targets',
  '--profile': 'enable build profiling',
  '-V, --version': 'output the version number',
  '--detailed-report [depth]': [
    'Print the asset timings and sizes in the build report',
    /^([0-9]+)$/,
  ],
};

var hmrOptions = {
  '--no-hmr': 'disable hot module replacement',
  '-p, --port <port>': [
    'set the port to serve on. defaults to $PORT or 1234',
    process.env.PORT,
  ],
  '--host <host>':
    'set the host to listen on, defaults to listening on all interfaces',
  '--https': 'serves files over HTTPS',
  '--cert <path>': 'path to certificate to use with HTTPS',
  '--key <path>': 'path to private key to use with HTTPS',
  '--no-autoinstall': 'disable autoinstall',
  '--hmr-port <port>': ['hot module replacement port', process.env.HMR_PORT],
};

function applyOptions(cmd, options) {
  for (let opt in options) {
    cmd.option(
      opt,
      ...(Array.isArray(options[opt]) ? options[opt] : [options[opt]]),
    );
  }
}

let serve = program
  .command('serve [input...]')
  .description('starts a development server')
  .option('--public-url <url>', 'the path prefix for absolute urls')
  .option(
    '--open [browser]',
    'automatically open in specified browser, defaults to default browser',
  )
  .option('--watch-for-stdin', 'exit when stdin closes')
  .action(runCommand);

applyOptions(serve, hmrOptions);
applyOptions(serve, commonOptions);

let watch = program
  .command('watch [input...]')
  .description('starts the bundler in watch mode')
  .option('--public-url <url>', 'the path prefix for absolute urls')
  .option('--watch-for-stdin', 'exit when stdin closes')
  .action(runCommand);

applyOptions(watch, hmrOptions);
applyOptions(watch, commonOptions);

let build = program
  .command('build [input...]')
  .description('bundles for production')
  .option('--no-minify', 'disable minification')
  .option('--no-scope-hoist', 'disable scope-hoisting')
  .option('--public-url <url>', 'the path prefix for absolute urls')
  .action(runCommand);

applyOptions(build, commonOptions);

program
  .command('help [command]')
  .description('display help information for a command')
  .action(function(command) {
    let cmd = program.commands.find(c => c.name() === command) || program;
    cmd.help();
  });

program.on('--help', function() {
  INTERNAL_ORIGINAL_CONSOLE.log('');
  INTERNAL_ORIGINAL_CONSOLE.log(
    '  Run `' +
      chalk.bold('parcel help <command>') +
      '` for more information on specific commands',
  );
  INTERNAL_ORIGINAL_CONSOLE.log('');
});

// Make serve the default command except for --help
var args = process.argv;
if (args[2] === '--help' || args[2] === '-h') args[2] = 'help';
if (!args[2] || !program.commands.some(c => c.name() === args[2])) {
  args.splice(2, 0, 'serve');
}

program.parse(args);

function runCommand(...args) {
  run(...args).catch(handleUncaughtException);
}

async function run(entries: Array<string>, command: any) {
  entries = entries.map(entry => path.resolve(entry));

  if (entries.length === 0) {
    INTERNAL_ORIGINAL_CONSOLE.log('No entries found');
    return;
  }
  let Parcel = require('@parcel/core').default;
  let options = await normalizeOptions(command);
  let fs = new NodeFS();
  let packageManager = new NodePackageManager(fs);
  let parcel = new Parcel({
    entries,
    packageManager,
    // $FlowFixMe - flow doesn't know about the `paths` option (added in Node v8.9.0)
    defaultConfig: require.resolve('@parcel/config-default', {
      paths: [fs.cwd(), __dirname],
    }),
    patchConsole: true,
    ...options,
  });

  let disposable = new Disposable();
  let unsubscribe: () => Promise<mixed>;
  let isExiting;
  async function exit(exitCode: number = 0) {
    if (isExiting) {
      return;
    }

    isExiting = true;
    if (unsubscribe != null) {
      await unsubscribe();
    } else if (parcel.isProfiling) {
      await parcel.stopProfiling();
    }

    if (process.stdin.isTTY && process.stdin.isRaw) {
      // $FlowFixMe
      process.stdin.setRawMode(false);
    }

    disposable.dispose();
    process.exit(exitCode);
  }

  const isWatching = command.name() === 'watch' || command.name() === 'serve';
  if (process.stdin.isTTY) {
    // $FlowFixMe
    process.stdin.setRawMode(true);
    require('readline').emitKeypressEvents(process.stdin);

    let stream = process.stdin.on('keypress', async (char, key) => {
      if (!key.ctrl) {
        return;
      }

      switch (key.name) {
        case 'c':
          // Detect the ctrl+c key, and gracefully exit after writing the asset graph to the cache.
          // This is mostly for tools that wrap Parcel as a child process like yarn and npm.
          //
          // Setting raw mode prevents SIGINT from being sent in response to ctrl-c:
          // https://nodejs.org/api/tty.html#tty_readstream_setrawmode_mode
          //
          // We don't use the SIGINT event for this because when run inside yarn, the parent
          // yarn process ends before Parcel and it appears that Parcel has ended while it may still
          // be cleaning up. Handling events from stdin prevents this impression.

          // Enqueue a busy message to be shown if Parcel doesn't shut down
          // within the timeout.
          setTimeout(
            () =>
              INTERNAL_ORIGINAL_CONSOLE.log(
                chalk.bold.yellowBright('Parcel is shutting down...'),
              ),
            500,
          );
          // When watching, a 0 success code is acceptable when Parcel is interrupted with ctrl-c.
          // When building, fail with a code as if we received a SIGINT.
          await exit(isWatching ? 0 : SIGINT_EXIT_CODE);
          break;
        case 'e':
          await (parcel.isProfiling
            ? parcel.stopProfiling()
            : parcel.startProfiling());
          break;
        case 'y':
          await parcel.takeHeapSnapshot();
          break;
      }
    });

    disposable.add(() => {
      stream.destroy();
    });
  }

  if (isWatching) {
    ({unsubscribe} = await parcel.watch(err => {
      if (err) {
        throw err;
      }
    }));

    if (command.open && options.serve) {
      await openInBrowser(
        `${options.serve.https ? 'https' : 'http'}://${options.serve.host ||
          'localhost'}:${options.serve.port}`,
        command.open,
      );
    }

    if (command.watchForStdin) {
      process.stdin.on('end', async () => {
        INTERNAL_ORIGINAL_CONSOLE.log('STDIN closed, ending');

        await exit();
      });
      process.stdin.resume();
    }

    // In non-tty cases, respond to SIGINT by cleaning up. Since we're watching,
    // a 0 success code is acceptable.
    process.on('SIGINT', exit);
    process.on('SIGTERM', exit);
  } else {
    try {
      await parcel.run();
    } catch (err) {
      // If an exception is thrown during Parcel.build, it is given to reporters in a
      // buildFailure event, and has been shown to the user.
      if (!(err instanceof BuildError)) {
        await logUncaughtError(err);
      }
      await exit(1);
    }

    await exit();
  }
}

function parsePort(portValue: string): number {
  let parsedPort = Number(portValue);

  // Throw an error if port value is invalid...
  if (!Number.isInteger(parsedPort)) {
    throw new Error(`Port ${portValue} is not a valid integer.`);
  }

  return parsedPort;
}

async function normalizeOptions(command): Promise<InitialParcelOptions> {
  let nodeEnv;
  if (command.name() === 'build') {
    nodeEnv = initialNodeEnv || 'production';
    command.autoinstall = false;
  } else {
    nodeEnv = initialNodeEnv || 'development';
  }

  let https = !!command.https;
  if (command.cert && command.key) {
    https = {
      cert: command.cert,
      key: command.key,
    };
  }

  let serve = false;
  let {host} = command;

  // Ensure port is valid and available
  let port = parsePort(command.port || '1234');
  let originalPort = port;
  if (command.name() === 'serve' || command.hmr) {
    port = await getPort({port, host});

    if (port !== originalPort) {
      let errorMessage = `Port "${port}" could not be used`;
      if (command.port != null) {
        // Throw the error if the user defined a custom port
        throw new Error(errorMessage);
      } else {
        // Parcel logger is not set up at this point, so just use native INTERNAL_ORIGINAL_CONSOLE
        INTERNAL_ORIGINAL_CONSOLE.warn(errorMessage);
      }
    }
  }

  if (command.name() === 'serve') {
    let {publicUrl} = command;

    serve = {
      https,
      port,
      host,
      publicUrl,
    };
  }

  let hmr = null;
  if (command.name() !== 'build' && command.hmr !== false) {
    let hmrport = command.hmrPort ? parsePort(command.hmrPort) : port;

    hmr = {port: hmrport, host};
  }

  let mode = command.name() === 'build' ? 'production' : 'development';
  return {
    disableCache: command.cache === false,
    cacheDir: command.cacheDir,
    mode,
    minify: command.minify != null ? command.minify : mode === 'production',
    sourceMaps: command.sourceMaps ?? true,
    scopeHoist: command.scopeHoist,
    publicUrl: command.publicUrl,
    distDir: command.distDir,
    hot: hmr,
    contentHash: hmr ? false : command.contentHash,
    serve,
    targets: command.target.length > 0 ? command.target : null,
    autoinstall: command.autoinstall ?? true,
    logLevel: command.logLevel,
    profile: command.profile,
    detailedReport: command.detailedReport,
    env: {
      NODE_ENV: nodeEnv,
    },
  };
}
