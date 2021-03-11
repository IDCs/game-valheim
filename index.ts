import Bluebird from 'bluebird';
import * as path from 'path';
import { fs, selectors, types, util } from 'vortex-api';
import Parser, { IniFile, WinapiFormat } from 'vortex-parse-ini';
import * as payloadDeployer from './payloadDeployer';

import { FBX_EXT, GAME_ID, genProps, IGNORABLE_FILES, INSLIMVML_IDENTIFIER,
  IProps, OBJ_EXT, STEAM_ID, VBUILD_EXT } from './common';
import { installCoreRemover, installFullPack, installInSlimModLoader, installVBuildMod,
  testCoreRemover, testFullPack, testInSlimModLoader, testVBuild } from './installers';
import { migrate103 } from './migrations';
import { isDependencyRequired } from './tests';

import { migrateR2ToVortex, userHasR2Installed } from './r2Vortex';

const STOP_PATTERNS = ['config', 'plugins', 'patchers'];
function toWordExp(input) {
  return '(^|/)' + input + '(/|$)';
}

function findGame(): any {
  return util.GameStoreHelper.findByAppId([STEAM_ID])
    .then(game => game.gamePath);
}

function requiresLauncher(gamePath) {
  return fs.readdirAsync(gamePath)
    .then(files => (files.find(file => file.toLowerCase() === 'steam_appid.txt') !== undefined)
      ? Promise.resolve({
        launcher: 'steam',
        addInfo: {
          appId: STEAM_ID,
          parameters: ['-force-glcore'],
          launchType: 'gamestore',
        },
      })
      : Promise.resolve(undefined))
    .catch(err => Promise.reject(err));
}

async function ensureUnstrippedAssemblies(props: IProps): Promise<void> {
  const api = props.api;
  const t = api.translate;
  const expectedFilePath = path.join(props.discovery.path,
    'unstripped_managed', 'mono.security.dll');
  const fullPackCorLib = path.join(props.discovery.path,
    'BepInEx', 'core_lib', 'mono.security.dll');

  const raiseMissingAssembliesDialog = () => new Promise<void>((resolve, reject) => {
    api.showDialog('info', 'Missing unstripped assemblies', {
      bbcode: t('Valheim\'s assemblies are distributed in an "optimised" state to reduce required '
      + 'disk space. This unfortunately means that Valheim\'s modding capabilities are also affected.{{br}}{{br}}'
      + 'In order to mod Valheim, the unoptimised/unstripped assemblies are required - please download these '
      + 'from Nexus Mods.{{br}}{{br}} You can choose the Vortex/mod manager download or manual download '
      + '(simply drag and drop the archive into the mods dropzone to add it to Vortex).{{br}}{{br}}'
      + 'Vortex will then be able to install the assemblies where they are needed to enable '
      + 'modding, leaving the original ones untouched.', { replace: { br: '[br][/br]' } }),
    }, [
      { label: 'Cancel', action: () => reject(new util.UserCanceled()) },
      {
        label: 'Download Unstripped Assemblies',
        action: () => util.opn('https://www.nexusmods.com/valheim/mods/15')
          .catch(err => null)
          .finally(() => resolve()),
      },
    ]);
  });

  const assignOverridePath = async (overridePath: string) => {
    const doorStopConfig = path.join(props.discovery.path, 'doorstop_config.ini');
    const parser = new Parser(new WinapiFormat());
    try {
      const iniData: IniFile<any> = await parser.read(doorStopConfig);
      iniData.data['UnityDoorstop']['dllSearchPathOverride'] = overridePath;
      await parser.write(doorStopConfig, iniData);
    } catch (err) {
      api.showErrorNotification('failed to modify doorstop configuration', err);
    }
  };

  const mods: { [modId: string]: types.IMod } =
    util.getSafe(props.state, ['persistent', 'mods', GAME_ID], {});
  const coreLibModId = Object.keys(mods).find(key =>
    util.getSafe(mods[key], ['attributes', 'IsCoreLibMod'], false));
  if (coreLibModId !== undefined) {
    const isCoreLibModEnabled = util.getSafe(props.profile,
      ['modState', coreLibModId, 'enabled'], false);
    if (isCoreLibModEnabled) {
      assignOverridePath('BepInEx\\core_lib');
      return;
    }
  }
  for (const filePath of [fullPackCorLib, expectedFilePath]) {
    try {
      await fs.statAsync(filePath);
      const dllOverridePath = filePath.replace(props.discovery.path + path.sep, '')
                                      .replace(path.sep + 'mono.security.dll', '');
      await assignOverridePath(dllOverridePath);
      return;
    } catch (err) {
      // nop
    }
  }

  return raiseMissingAssembliesDialog();
}

function prepareForModding(context: types.IExtensionContext, discovery: types.IDiscoveryResult) {
  const state = context.api.getState();
  const prevProfId: string = selectors.lastActiveProfileForGame(state, GAME_ID);
  const profile: types.IProfile = selectors.profileById(state, prevProfId);
  const modTypes: { [typeId: string]: string } = selectors.modPathsForGame(state, GAME_ID);
  const createDirectories = async () => {
    for (const modType of Object.keys(modTypes)) {
      try {
        await fs.ensureDirWritableAsync(modTypes[modType]);
      } catch (err) {
        return Promise.reject(err);
      }
    }
  };
  return new Bluebird<void>((resolve, reject) => createDirectories()
    .then(() => payloadDeployer.onWillDeploy(context, profile?.id))
    .then(() => resolve())
    .catch(err => reject(err)))
  .then(() => ensureUnstrippedAssemblies({ api: context.api, state, profile, discovery }));
}

function modsPath(gamePath: string) {
  return path.join(gamePath, 'BepInEx', 'plugins');
}

function main(context: types.IExtensionContext) {
  context.registerGame({
    id: GAME_ID,
    name: 'Valheim',
    mergeMods: true,
    queryPath: findGame,
    queryModPath: modsPath,
    logo: 'gameart.jpg',
    executable: () => 'valheim.exe',
    requiresLauncher,
    setup: discovery => prepareForModding(context, discovery),
    requiredFiles: [
      'valheim.exe',
    ],
    environment: {
      SteamAPPId: STEAM_ID,
    },
    details: {
      steamAppId: +STEAM_ID,
      stopPatterns: STOP_PATTERNS.map(toWordExp),
      ignoreConflicts: IGNORABLE_FILES,
      ignoreDeploy: IGNORABLE_FILES,
    },
  });

  const getGamePath = () => {
    const props: IProps = genProps(context);
    return (props?.discovery?.path !== undefined)
      ? props.discovery.path : '.';
  };

  const isSupported = (gameId: string) => (gameId === GAME_ID);
  const hasInstruction = (instructions: types.IInstruction[],
                          pred: (inst: types.IInstruction) => boolean) =>
                            instructions.find(instr => (instr.type === 'copy')
                                                    && (pred(instr))) !== undefined;

  const findInstrMatch = (instructions: types.IInstruction[],
                          pattern: string,
                          mod?: (input: string) => string) => {
    if (mod === undefined) {
      mod = (input) => input;
    }
    return hasInstruction(instructions, (instr) =>
      mod(instr.source).toLowerCase() === pattern.toLowerCase());
  };

  const vbuildDepTest = () => {
    const gamePath = getGamePath();
    const buildShareAssembly = path.join(gamePath, 'InSlimVML', 'Mods', 'CR-BuildShare_VML.dll');
    return isDependencyRequired(context.api, {
      dependentModType: 'vbuild-mod',
      masterModType: 'inslimvml-mod',
      masterName: 'BuildShare (AdvancedBuilding)',
      masterURL: 'https://www.nexusmods.com/valheim/mods/5',
      requiredFiles: [ buildShareAssembly ],
    });
  };

  const customMeshesTest = () => {
    const basePath = modsPath(getGamePath());
    const requiredAssembly = path.join(basePath, 'CustomMeshes.dll');
    return isDependencyRequired(context.api, {
      dependentModType: 'valheim-custom-meshes',
      masterModType: '',
      masterName: 'CustomMeshes',
      masterURL: 'https://www.nexusmods.com/valheim/mods/184',
      requiredFiles: [ requiredAssembly ],
    });
  };

  const customTexturesTest = () => {
    const basePath = modsPath(getGamePath());
    const requiredAssembly = path.join(basePath, 'CustomTextures.dll');
    return isDependencyRequired(context.api, {
      dependentModType: 'valheim-custom-textures',
      masterModType: '',
      masterName: 'CustomTextures',
      masterURL: 'https://www.nexusmods.com/valheim/mods/48',
      requiredFiles: [ requiredAssembly ],
    });
  };

  context.registerAction('mod-icons', 115, 'import', {}, 'Import From r2modman', () => {
    migrateR2ToVortex(context.api);
  }, () => userHasR2Installed() && getGamePath() !== '.');

  context.registerTest('vbuild-dep-test', 'gamemode-activated', vbuildDepTest);
  context.registerTest('vbuild-dep-test', 'mod-installed', vbuildDepTest);

  context.registerTest('textures-dep-test', 'gamemode-activated', customMeshesTest);
  context.registerTest('textures-dep-test', 'mod-installed', customMeshesTest);

  context.registerTest('meshes-dep-test', 'gamemode-activated', customTexturesTest);
  context.registerTest('meshes-dep-test', 'mod-installed', customTexturesTest);

  context.registerInstaller('valheim-core-remover', 20, testCoreRemover, installCoreRemover);
  context.registerInstaller('valheim-inslimvm', 20, testInSlimModLoader, installInSlimModLoader);
  context.registerInstaller('valheim-vbuild', 20, testVBuild, installVBuildMod);
  context.registerInstaller('valheim-full-bep-pack', 10, testFullPack, installFullPack);

  context.registerMigration((oldVersion: string) => migrate103(context.api, oldVersion));

  context.registerModType('inslimvml-mod-loader', 20, isSupported, getGamePath,
    (instructions: types.IInstruction[]) => {
      const hasVMLIni = findInstrMatch(instructions, INSLIMVML_IDENTIFIER, path.basename);
      return Bluebird.Promise.Promise.resolve(hasVMLIni);
    }, { name: 'InSlimVML Mod Loader' });

  context.registerModType('inslimvml-mod', 10, isSupported,
    () => path.join(getGamePath(), 'InSlimVML', 'Mods'), (instructions: types.IInstruction[]) => {
      // Unfortunately there are currently no identifiers to differentiate between
      //  BepInEx and InSlimVML mods and therefore cannot automatically assign
      //  this modType automatically. We do know that CR-AdvancedBuilder.dll is an InSlim
      //  mod, but that's about it.
      const vmlSuffix = '_vml.dll';
      const mod = (input: string) => (input.length > vmlSuffix.length)
        ? path.basename(input).slice(-vmlSuffix.length)
        : '';
      const testRes = findInstrMatch(instructions, 'cr-buildshare_vml.dll', path.basename)
        || findInstrMatch(instructions, '_vml.dll', mod);
      return Bluebird.Promise.Promise.resolve(testRes);
    }, { name: 'InSlimVML Mod' });

  context.registerModType('vbuild-mod', 10, isSupported, () => path.join(getGamePath(), 'AdvancedBuilder', 'Builds'),
    (instructions: types.IInstruction[]) => {
      const res = findInstrMatch(instructions, VBUILD_EXT, path.extname);
      return Bluebird.Promise.Promise.resolve(res);
    }, { name: 'BuildShare Mod' });

  context.registerModType('valheim-custom-meshes', 10, isSupported,
    () => path.join(modsPath(getGamePath()), 'CustomMeshes'),
    (instructions: types.IInstruction[]) => {
      const supported = findInstrMatch(instructions, FBX_EXT, path.extname)
        || findInstrMatch(instructions, OBJ_EXT, path.extname);
      return Bluebird.Promise.Promise.resolve(supported);
    }, { name: 'CustomMeshes Mod' });

  context.registerModType('valheim-custom-textures', 10, isSupported,
    () => path.join(modsPath(getGamePath()), 'CustomTextures'),
    (instructions: types.IInstruction[]) => {
      const textureRgx: RegExp = new RegExp(/^texture_.*.png$/);
      let supported = false;
      for (const instr of instructions) {
        if ((instr.type === 'copy')
          && textureRgx.test(path.basename(instr.source).toLowerCase())) {
            supported = true;
            break;
        }
      }
      return Bluebird.Promise.Promise.resolve(supported);
    }, { name: 'CustomTextures Mod' });

  context.registerModType('unstripped-assemblies', 20, isSupported, getGamePath,
    (instructions: types.IInstruction[]) => {
      const testPath = path.join('unstripped_managed', 'mono.posix.dll');
      const supported = hasInstruction(instructions,
        (instr) => instr.source.toLowerCase().includes(testPath));
      return Bluebird.Promise.Promise.resolve(supported);
    }, { name: 'Unstripped Assemblies' });

  context.registerModType('bepinex-root-mod', 25, isSupported, () => path.join(getGamePath(), 'BepInEx'),
  (instructions: types.IInstruction[]) => {
    const matcher = (filePath: string) => {
      const segments = filePath.split(path.sep);
      for (const stop of STOP_PATTERNS) {
        if (segments.includes(stop)) {
          return true;
        }
      }
      return false;
    };
    const supported = hasInstruction(instructions, (instr) => matcher(instr.source));
    return Bluebird.Promise.Promise.resolve(supported);
    }, { name: 'BepInEx Root Mod' });

  context.once(() => {
    context.api.onAsync('will-deploy', async (profileId) => {
      const state = context.api.getState();
      const profile = selectors.profileById(state, profileId);
      if (profile?.gameId !== GAME_ID) {
        return Promise.resolve();
      }
      return payloadDeployer.onWillDeploy(context, profileId)
        .then(() => ensureUnstrippedAssemblies(genProps(context, profileId)))
        .catch(err => err instanceof util.UserCanceled
          ? Promise.resolve()
          : Promise.reject(err));
    });

    context.api.onAsync('did-purge', async (profileId) =>
      payloadDeployer.onDidPurge(context, profileId));
  });

  return true;
}

export default main;
