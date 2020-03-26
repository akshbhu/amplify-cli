import path from 'path';
import fs from 'fs-extra';
import childProcess from 'child_process';
import glob from 'glob';
import { BuildRequest, BuildResult } from 'amplify-function-plugin-interface';

// copied from the existing build-resources.js file in amplify-cli with changes for new interface
export async function buildResource(request: BuildRequest): Promise<BuildResult> {
  const resourceDir = path.join(request.srcRoot);
  const projectPath = path.join(resourceDir);
  if (!request.lastBuildTimestamp || isBuildStale(request.srcRoot, request.lastBuildTimestamp)) {
    installDependencies(projectPath);
    return Promise.resolve({ rebuilt: true });
  }
  return Promise.resolve({ rebuilt: false });
}

function installDependencies(resourceDir: string) {
  runPackageManager(resourceDir);
}

function runPackageManager(cwd: string) {
  const packageManager = 'gradle';
  const args = ['build'];
  const childProcessResult = childProcess.spawnSync(packageManager, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf-8',
  });
  if (childProcessResult.status !== 0) {
    throw new Error(childProcessResult.output.join());
  }
}

function isBuildStale(resourceDir: string, lastBuildTimestamp: Date) {
  const dirTime = new Date(fs.statSync(resourceDir).mtime);
  if (dirTime > lastBuildTimestamp) {
    return true;
  }
  // change this
  const fileUpdatedAfterLastBuild = glob
    .sync(`${resourceDir}/*/!(bin|obj)/**`)
    .find(file => new Date(fs.statSync(file).mtime) > lastBuildTimestamp);
  return !!fileUpdatedAfterLastBuild;
}
