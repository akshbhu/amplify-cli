import { $TSContext } from 'amplify-cli-core';
import _ from 'lodash';
import { AmplifyRootStackTransform, CommandType, RootStackTransformOptions } from './root-stack-builder';
import { rootStackFileName } from '.';
import { pathManager, PathConstants, stateManager, JSONUtilities } from 'amplify-cli-core';
import { Template } from 'cloudform-types';
const moment = require('moment');
const path = require('path');
const glob = require('glob');
const archiver = require('./utils/archiver');
const fs = require('fs-extra');
const ora = require('ora');
const sequential = require('promise-sequential');
const Cloudformation = require('./aws-utils/aws-cfn');
const { S3 } = require('./aws-utils/aws-s3');
const constants = require('./constants');
const configurationManager = require('./configuration-manager');
const amplifyServiceManager = require('./amplify-service-manager');
const amplifyServiceMigrate = require('./amplify-service-migrate');
const { fileLogger } = require('./utils/aws-logger');
const { prePushCfnTemplateModifier } = require('./pre-push-cfn-processor/pre-push-cfn-modifier');
const logger = fileLogger('attach-backend');
const { configurePermissionsBoundaryForInit } = require('./permissions-boundary/permissions-boundary');

export async function run(context) {
  await configurationManager.init(context);
  if (!context.exeInfo || context.exeInfo.isNewEnv) {
    context.exeInfo = context.exeInfo || {};
    const { projectName } = context.exeInfo.projectConfig;
    const timeStamp = `${moment().format('Hmmss')}`;
    const { envName = '' } = context.exeInfo.localEnvInfo;
    let stackName = normalizeStackName(`amplify-${projectName}-${envName}-${timeStamp}`);
    const awsConfig = await configurationManager.getAwsConfig(context);
    const amplifyServiceParams = {
      context,
      awsConfig,
      projectName,
      envName,
      stackName,
    };
    const { amplifyAppId, verifiedStackName, deploymentBucketName } = await amplifyServiceManager.init(amplifyServiceParams);
    await configurePermissionsBoundaryForInit(context);

    // start root stack builder and deploy

    // moved cfn build to next its builder
    stackName = verifiedStackName;
    const Tags = context.amplify.getTags(context);

    const authRoleName = `${stackName}-authRole`;
    const unauthRoleName = `${stackName}-unauthRole`;

    // CFN transform for Root stack
    const props: RootStackTransformOptions = {
      resourceConfig: {
        stackFileName: rootStackFileName,
      },
    };
    // generate , override and deploy stacks to disk
    const rootTransform = new AmplifyRootStackTransform(props, CommandType.INIT);
    const rootStack = await rootTransform.transform();
    // prepush modifier
    await prePushCfnTemplateModifier(rootStack);
    // Track Amplify Console generated stacks
    if (!!process.env.CLI_DEV_INTERNAL_DISABLE_AMPLIFY_APP_DELETION) {
      rootStack.Description = 'Root Stack for AWS Amplify Console';
    }

    // deploy steps
    const params = {
      StackName: stackName,
      Capabilities: ['CAPABILITY_NAMED_IAM', 'CAPABILITY_AUTO_EXPAND'],
      TemplateBody: JSON.stringify(rootStack),
      Parameters: [
        {
          ParameterKey: 'DeploymentBucketName',
          ParameterValue: deploymentBucketName,
        },
        {
          ParameterKey: 'AuthRoleName',
          ParameterValue: authRoleName,
        },
        {
          ParameterKey: 'UnauthRoleName',
          ParameterValue: unauthRoleName,
        },
      ],
      Tags,
    };

    const spinner = ora();
    spinner.start('Initializing project in the cloud...');

    try {
      const cfnItem = await new Cloudformation(context, 'init', awsConfig);
      const stackDescriptionData = await cfnItem.createResourceStack(params);

      processStackCreationData(context, amplifyAppId, stackDescriptionData);
      cloneCLIJSONForNewEnvironment(context);

      spinner.succeed('Successfully created initial AWS cloud resources for deployments.');

      return context;
    } catch (e) {
      spinner.fail('Root stack creation failed');
      throw e;
    }
  } else if (
    // This part of the code is invoked by the `amplify init --appId xxx` command
    // on projects that are already fully setup by `amplify init` with the Amplify CLI version prior to 4.0.0.
    // It expects all the artifacts in the `amplify/.config` directory, the amplify-meta.json file in both
    // the `#current-cloud-backend` and the `backend` directories, and the team-provider-info file to exist.
    // It allows the local project's env to be added to an existing Amplify Console project, as specified
    // by the appId, without unneccessarily creating another Amplify Console project by the post push migration.
    !context.exeInfo.isNewProject &&
    context.exeInfo.inputParams &&
    context.exeInfo.inputParams.amplify &&
    context.exeInfo.inputParams.amplify.appId
  ) {
    await amplifyServiceMigrate.run(context);
  } else {
    setCloudFormationOutputInContext(context, {});
  }
}

function processStackCreationData(context, amplifyAppId, stackDescriptiondata) {
  const metadata = {};
  if (stackDescriptiondata.Stacks && stackDescriptiondata.Stacks.length) {
    const { Outputs } = stackDescriptiondata.Stacks[0];
    Outputs.forEach(element => {
      metadata[element.OutputKey] = element.OutputValue;
    });
    if (amplifyAppId) {
      metadata[constants.AmplifyAppIdLabel] = amplifyAppId;
    }

    setCloudFormationOutputInContext(context, metadata);
  } else {
    throw new Error('No stack data present');
  }
}

function setCloudFormationOutputInContext(context: $TSContext, cfnOutput: object) {
  _.set(context, ['exeInfo', 'amplifyMeta', 'providers', constants.ProviderName], cfnOutput);
  const { envName } = context.exeInfo.localEnvInfo;
  if (envName) {
    const providerInfo = _.get(context, ['exeInfo', 'teamProviderInfo', envName, constants.ProviderName]);
    if (providerInfo) {
      _.merge(providerInfo, cfnOutput);
    } else {
      _.set(context, ['exeInfo', 'teamProviderInfo', envName, constants.ProviderName], cfnOutput);
    }
  }
}

function cloneCLIJSONForNewEnvironment(context) {
  if (context.exeInfo.isNewEnv && !context.exeInfo.isNewProject) {
    const { projectPath } = context.exeInfo.localEnvInfo;
    const { envName } = stateManager.getLocalEnvInfo(undefined, {
      throwIfNotExist: false,
      default: {},
    });

    if (envName) {
      const currentEnvCLIJSONPath = pathManager.getCLIJSONFilePath(projectPath, envName);

      if (fs.existsSync(currentEnvCLIJSONPath)) {
        const newEnvCLIJSONPath = pathManager.getCLIJSONFilePath(projectPath, context.exeInfo.localEnvInfo.envName);

        fs.copyFileSync(currentEnvCLIJSONPath, newEnvCLIJSONPath);
      }
    }
  }
}

export async function onInitSuccessful(context) {
  configurationManager.onInitSuccessful(context);
  if (context.exeInfo.isNewEnv) {
    await storeRootStackTemplate();
    context = await storeCurrentCloudBackend(context);
    await storeArtifactsForAmplifyService(context);
  }
  return context;
}

export const storeRootStackTemplate = async (template?: Template) => {
  // generate template again as the folder structure was not created when root stack was initiaized
  if (template === undefined) {
    const props: RootStackTransformOptions = {
      resourceConfig: {
        stackFileName: rootStackFileName,
      },
    };
    const rootTransform = new AmplifyRootStackTransform(props, CommandType.INIT);
    template = await rootTransform.transform();
    // prepush modifier
    await prePushCfnTemplateModifier(template);
  }

  // RootStack deployed to backend/awscloudformation/build
  const projectRoot = pathManager.findProjectRoot();
  const rootStackBackendBuildDir = pathManager.getRootStackDirPath(projectRoot);
  const rootStackCloudBackendBuildDir = pathManager.getCurrentCloudRootStackDirPath(projectRoot);

  fs.ensureDirSync(rootStackBackendBuildDir);
  const rootStackBackendFilePath = path.join(rootStackBackendBuildDir, rootStackFileName);
  const rootStackCloudBackendFilePath = path.join(rootStackCloudBackendBuildDir, rootStackFileName);

  JSONUtilities.writeJson(rootStackBackendFilePath, template);
  // copy the awscloudformation backend to #current-cloud-backend
  fs.copySync(rootStackBackendFilePath, rootStackCloudBackendFilePath);
};

function storeCurrentCloudBackend(context) {
  const zipFilename = '#current-cloud-backend.zip';
  const backendDir = context.amplify.pathManager.getBackendDirPath();
  const tempDir = path.join(backendDir, '.temp');
  const currentCloudBackendDir = context.exeInfo
    ? path.join(context.exeInfo.localEnvInfo.projectPath, PathConstants.AmplifyDirName, PathConstants.CurrentCloudBackendDirName)
    : context.amplify.pathManager.getCurrentCloudBackendDirPath();

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }

  const cliJSONFiles = glob.sync(PathConstants.CLIJSONFileNameGlob, {
    cwd: pathManager.getAmplifyDirPath(),
    absolute: true,
  });

  // handle tag file
  const tagFilePath = pathManager.getTagFilePath();
  const tagCloudFilePath = pathManager.getCurrentTagFilePath();
  if (fs.existsSync(tagFilePath)) {
    fs.copySync(tagFilePath, tagCloudFilePath, { overwrite: true });
  }

  const zipFilePath = path.normalize(path.join(tempDir, zipFilename));
  let log = null;

  return archiver
    .run(currentCloudBackendDir, zipFilePath, undefined, cliJSONFiles)
    .then(result => {
      const s3Key = `${result.zipFilename}`;
      return S3.getInstance(context).then(s3 => {
        const s3Params = {
          Body: fs.createReadStream(result.zipFilePath),
          Key: s3Key,
        };
        log = logger('storeCurrentCloudBackend.s3.uploadFile', [{ Key: s3Key }]);
        log();
        return s3.uploadFile(s3Params);
      });
    })
    .catch(ex => {
      log(ex);
      throw ex;
    })
    .then(() => {
      fs.removeSync(tempDir);
      return context;
    });
}

function storeArtifactsForAmplifyService(context) {
  return S3.getInstance(context).then(async s3 => {
    const currentCloudBackendDir = context.amplify.pathManager.getCurrentCloudBackendDirPath();
    const amplifyMetaFilePath = path.join(currentCloudBackendDir, 'amplify-meta.json');
    const backendConfigFilePath = path.join(currentCloudBackendDir, 'backend-config.json');
    const fileUploadTasks = [];

    fileUploadTasks.push(() => uploadFile(s3, amplifyMetaFilePath, 'amplify-meta.json'));
    fileUploadTasks.push(() => uploadFile(s3, backendConfigFilePath, 'backend-config.json'));
    await sequential(fileUploadTasks);
  });
}

async function uploadFile(s3, filePath, key) {
  if (fs.existsSync(filePath)) {
    const s3Params = {
      Body: fs.createReadStream(filePath),
      Key: key,
    };
    const log = logger('uploadFile.s3.uploadFile', [{ Key: key }]);
    try {
      log();
      await s3.uploadFile(s3Params);
    } catch (ex) {
      log(ex);
      throw ex;
    }
  }
}

function normalizeStackName(stackName) {
  let result = stackName.toLowerCase().replace(/[^-a-z0-9]/g, '');
  if (/^[^a-zA-Z]/.test(result) || result.length === 0) {
    result = `a${result}`;
  }
  return result;
}
