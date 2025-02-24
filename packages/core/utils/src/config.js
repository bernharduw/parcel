// @flow

import type {ConfigResult, File, FilePath} from '@parcel/types';
import type {FileSystem} from '@parcel/fs';
import path from 'path';
import clone from 'clone';
import {parse as json5} from 'json5';
import {parse as toml} from '@iarna/toml';

export type ConfigOutput = {|
  config: ConfigResult,
  files: Array<File>,
|};

export type ConfigOptions = {|
  parse?: boolean,
|};

export function resolveConfig(
  fs: FileSystem,
  filepath: FilePath,
  filenames: Array<FilePath>,
): Promise<?FilePath> {
  return Promise.resolve(
    fs.findAncestorFile(filenames, path.dirname(filepath)),
  );
}

export function resolveConfigSync(
  fs: FileSystem,
  filepath: FilePath,
  filenames: Array<FilePath>,
): ?FilePath {
  return fs.findAncestorFile(filenames, path.dirname(filepath));
}

export async function loadConfig(
  fs: FileSystem,
  filepath: FilePath,
  filenames: Array<FilePath>,
  opts: ?ConfigOptions,
): Promise<ConfigOutput | null> {
  let configFile = await resolveConfig(fs, filepath, filenames);
  if (configFile) {
    try {
      let extname = path.extname(configFile).slice(1);
      if (extname === 'js') {
        return {
          // $FlowFixMe
          config: clone(require(configFile)),
          files: [{filePath: configFile}],
        };
      }

      let configContent = await fs.readFile(configFile, 'utf8');
      if (!configContent) {
        return null;
      }

      let config;
      if (opts && opts.parse === false) {
        config = configContent;
      } else {
        let parse = getParser(extname);
        config = parse(configContent);
      }

      return {
        config: config,
        files: [{filePath: configFile}],
      };
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' || err.code === 'ENOENT') {
        return null;
      }

      throw err;
    }
  }

  return null;
}

function getParser(extname) {
  switch (extname) {
    case 'toml':
      return toml;
    case 'json':
    default:
      return json5;
  }
}
