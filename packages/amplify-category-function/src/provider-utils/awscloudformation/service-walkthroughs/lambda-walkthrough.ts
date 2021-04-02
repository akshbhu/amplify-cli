import { generalQuestionsWalkthrough, settingsUpdateSelection } from './generalQuestionsWalkthrough';
import autogeneratedParameters from './autogeneratedParameters';
import { runtimeWalkthrough, templateWalkthrough } from '../utils/functionPluginLoader';
import _ from 'lodash';
import { FunctionParameters, ProjectLayer } from 'amplify-function-plugin-interface';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import path from 'path';
import {
  ServiceName,
  functionParametersFileName,
  parametersFileName,
  advancedSettingsList,
  resourceAccessSetting,
  cronJobSetting,
  lambdaLayerSetting,
} from '../utils/constants';
import { category } from '../../../constants';
import { getNewCFNParameters, getNewCFNEnvVariables } from '../utils/cloudformationHelpers';
import { askExecRolePermissionsQuestions } from './execPermissionsWalkthrough';
import { scheduleWalkthrough } from './scheduleWalkthrough';
import { merge } from '../utils/funcParamsUtils';
import { tryUpdateTopLevelComment } from '../utils/updateTopLevelComment';
import { addLayersToFunctionWalkthrough } from './addLayerToFunctionWalkthrough';
import { convertLambdaLayerMetaToLayerCFNArray } from '../utils/layerArnConverter';
import { loadFunctionParameters } from '../utils/loadFunctionParameters';
import {
  fetchPermissionCategories,
  fetchPermissionResourcesForCategory,
  fetchPermissionsForResourceInCategory,
} from '../utils/permissionMapUtils';
import { JSONUtilities } from 'amplify-cli-core';

/**
 * Starting point for CLI walkthrough that generates a lambda function
 * @param context The Amplify Context object
 */
export async function createWalkthrough(
  context: any,
  templateParameters: Partial<FunctionParameters>,
): Promise<Partial<FunctionParameters>> {
  // merge in parameters that don't require any additional input
  templateParameters = merge(templateParameters, autogeneratedParameters(context));

  // ask generic function questions and merge in results
  templateParameters = merge(templateParameters, await generalQuestionsWalkthrough(context));
  if (templateParameters.functionName) {
    templateParameters.resourceName = templateParameters.functionName;
  }

  // ask runtime selection questions and merge in results
  if (!templateParameters.runtime) {
    let runtimeSelection = await runtimeWalkthrough(context, templateParameters);
    templateParameters = merge(templateParameters, runtimeSelection[0]);
  }

  // ask template selection questions and merge in results
  templateParameters = merge(templateParameters, await templateWalkthrough(context, templateParameters));

  // list out the advanced settings before asking whether to configure them
  context.print.info('');
  context.print.success('Available advanced settings:');
  advancedSettingsList.forEach(setting => context.print.info('- '.concat(setting)));
  context.print.info('');

  // ask whether to configure advanced settings
  if (await context.amplify.confirmPrompt('Do you want to configure advanced settings?', false)) {
    if (await context.amplify.confirmPrompt('Do you want to access other resources in this project from your Lambda function?')) {
      templateParameters = merge(
        templateParameters,
        await askExecRolePermissionsQuestions(context, templateParameters.functionName, undefined, templateParameters.environmentMap),
      );
    }

    // ask scheduling Lambda questions and merge in results
    templateParameters = merge(templateParameters, await scheduleWalkthrough(context, templateParameters));

    // ask lambda layer questions and merge in results
    templateParameters = merge(templateParameters, await addLayersToFunctionWalkthrough(context, templateParameters.runtime));
  }

  return templateParameters;
}

function provideInformation(context, lambdaToUpdate, functionRuntime, currentParameters, scheduleParameters) {
  // Provide general information
  context.print.success('General information');
  context.print.info('| Name: '.concat(lambdaToUpdate));
  context.print.info('| Runtime: '.concat(functionRuntime));
  context.print.info('');

  // Provide resource access permission information
  context.print.success('Resource access permission');
  const currentCategoryPermissions = fetchPermissionCategories(currentParameters.permissions);
  if (currentCategoryPermissions.length) {
    currentCategoryPermissions.forEach(category => {
      const currentResources = fetchPermissionResourcesForCategory(currentParameters.permissions, category);
      currentResources.forEach(resource => {
        const currentPermissions = fetchPermissionsForResourceInCategory(currentParameters.permissions, category, resource);
        const formattedCurrentPermissions = ' ('.concat(currentPermissions.join(', ').concat(')'));
        context.print.info('- '.concat(resource).concat(formattedCurrentPermissions));
      });
    });
  } else {
    context.print.info('- Not configured');
  }
  context.print.info('');

  // Provide scheduling information
  context.print.success('Scheduled recurring invocation');
  if (scheduleParameters.cloudwatchRule && scheduleParameters.cloudwatchRule !== 'NONE') {
    context.print.info('| '.concat(scheduleParameters.cloudwatchRule));
    context.print.info('');
  } else {
    context.print.info('| Not configured');
    context.print.info('');
  }

  // Provide lambda layer information
  context.print.success('Lambda layers');
  if (currentParameters.lambdaLayers && currentParameters.lambdaLayers.length) {
    currentParameters.lambdaLayers.forEach(layer => {
      if (layer.arn) {
        context.print.info('- '.concat(layer.arn));
      }
    });
    context.print.info('');
  } else {
    context.print.info('- Not configured');
    context.print.info('');
  }
}

/**
 * TODO this function needs to be refactored so it doesn't have side-effects of writing to CFN files
 */
export async function updateWalkthrough(context, lambdaToUpdate?: string) {
  const lambdaFuncResourceNames = ((await context.amplify.getResourceStatus()).allResources as any[])
    .filter(resource => resource.service === ServiceName.LambdaFunction && resource.mobileHubMigrated !== true)
    .map(resource => resource.resourceName);

  if (lambdaFuncResourceNames.length === 0) {
    context.print.error('No Lambda function resource to update. Use "amplify add function" to create a new function.');
    return;
  }

  if (lambdaToUpdate) {
    if (!lambdaFuncResourceNames.includes(lambdaToUpdate)) {
      context.print.error(`No Lambda function named ${lambdaToUpdate} exists in the project.`);
      return;
    }
  } else {
    const resourceQuestion = [
      {
        name: 'resourceName',
        message: 'Select the Lambda function you want to update',
        type: 'list',
        choices: lambdaFuncResourceNames,
      },
    ];
    lambdaToUpdate = (await inquirer.prompt(resourceQuestion)).resourceName as string;
  }

  // initialize function parameters for update
  const functionParameters: Partial<FunctionParameters> = {
    resourceName: lambdaToUpdate,
    environmentMap: {
      ENV: {
        Ref: 'env',
      },
      REGION: {
        Ref: 'AWS::Region',
      },
    },
  };

  const projectBackendDirPath = context.amplify.pathManager.getBackendDirPath();
  const resourceDirPath = path.join(projectBackendDirPath, category, functionParameters.resourceName);
  const currentParameters = loadFunctionParameters(context, resourceDirPath);
  const functionRuntime = context.amplify.readBreadcrumbs(category, functionParameters.resourceName).functionRuntime as string;

  const cfnParameters: any = JSONUtilities.readJson(path.join(resourceDirPath, parametersFileName), { throwIfNotExist: false }) || {};
  const scheduleParameters = {
    cloudwatchRule: cfnParameters.CloudWatchRule,
    resourceName: functionParameters.resourceName,
  };

  provideInformation(context, lambdaToUpdate, functionRuntime, currentParameters, scheduleParameters);

  // Determine which settings need to be updated
  const { selectedSettings }: any = await settingsUpdateSelection();

  if (selectedSettings.includes(resourceAccessSetting)) {
    const additionalParameters = await askExecRolePermissionsQuestions(context, lambdaToUpdate, currentParameters.permissions);
    additionalParameters.dependsOn = additionalParameters.dependsOn || [];
    merge(functionParameters, additionalParameters);

    const cfnFileName = `${functionParameters.resourceName}-cloudformation-template.json`;
    const cfnFilePath = path.join(resourceDirPath, cfnFileName);
    const cfnContent: any = JSONUtilities.readJson(cfnFilePath);
    const dependsOnParams = { env: { Type: 'String' } };

    Object.keys(functionParameters.environmentMap)
      .filter(key => key !== 'ENV')
      .filter(key => key !== 'REGION')
      .filter(resourceProperty => 'Ref' in functionParameters.environmentMap[resourceProperty])
      .forEach(resourceProperty => {
        dependsOnParams[functionParameters.environmentMap[resourceProperty].Ref] = {
          Type: 'String',
          Default: functionParameters.environmentMap[resourceProperty].Ref,
        };
      });

    cfnContent.Parameters = getNewCFNParameters(
      cfnContent.Parameters,
      currentParameters,
      dependsOnParams,
      functionParameters.mutableParametersState,
    );

    if (!cfnContent.Resources.AmplifyResourcesPolicy) {
      cfnContent.Resources.AmplifyResourcesPolicy = {
        DependsOn: ['LambdaExecutionRole'],
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyName: 'amplify-lambda-execution-policy',
          Roles: [
            {
              Ref: 'LambdaExecutionRole',
            },
          ],
          PolicyDocument: {
            Version: '2012-10-17',
            Statement: [],
          },
        },
      };
    }

    if (functionParameters.categoryPolicies.length === 0) {
      delete cfnContent.Resources.AmplifyResourcesPolicy;
    } else {
      cfnContent.Resources.AmplifyResourcesPolicy.Properties.PolicyDocument.Statement = functionParameters.categoryPolicies;
    }

    cfnContent.Resources.LambdaFunction.Properties.Environment.Variables = getNewCFNEnvVariables(
      cfnContent.Resources.LambdaFunction.Properties.Environment.Variables,
      currentParameters,
      functionParameters.environmentMap,
      functionParameters.mutableParametersState,
    );

    context.amplify.writeObjectAsJson(cfnFilePath, cfnContent, true);
    tryUpdateTopLevelComment(resourceDirPath, _.keys(functionParameters.environmentMap));
  } else {
    // Need to load previous dependsOn
    functionParameters.dependsOn = _.get(context.amplify.getProjectMeta(), ['function', lambdaToUpdate, 'dependsOn'], []);
  }

  // ask scheduling Lambda questions and merge in results
  if (selectedSettings.includes(cronJobSetting)) {
    merge(functionParameters, await scheduleWalkthrough(context, scheduleParameters, true));
  }

  // ask lambdalayer questions and merge results
  if (selectedSettings.includes(lambdaLayerSetting)) {
    const currentFunctionParameters: any =
      JSONUtilities.readJson(path.join(resourceDirPath, functionParametersFileName), { throwIfNotExist: false }) || {};
    const { lambdaLayers, dependsOn } = await addLayersToFunctionWalkthrough(
      context,
      { value: functionRuntime },
      currentFunctionParameters.lambdaLayers,
      true,
    );
    if (lambdaLayers.length) {
      _.assign(functionParameters, { lambdaLayers, dependsOn });
    } else {
      const oldLambdaLayers = currentFunctionParameters.lambdaLayers;
      functionParameters.lambdaLayers = [];
      oldLambdaLayers.forEach(layer => {
        if (layer.type === 'ProjectLayer') {
          functionParameters.dependsOn = functionParameters.dependsOn.filter(
            resource => !(resource.category === 'function' && resource.resourceName === layer.resourceName),
          );
        }
      });
    }
    // writing to the CFN here because it's done above for the schedule and the permissions but we should really pull all of it into another function
    const cfnFileName = `${functionParameters.resourceName}-cloudformation-template.json`;
    const cfnFilePath = path.join(resourceDirPath, cfnFileName);
    const cfnContent: any = JSONUtilities.readJson(cfnFilePath);

    // check for layer parameters if not added
    functionParameters.lambdaLayers.forEach(layer => {
      const resourceName = _.get(layer as ProjectLayer, ['resourceName'], null);
      if (resourceName) {
        const param: string = `function${resourceName}Arn`;
        if (cfnContent.Parameters[`${param}`] === undefined) {
          cfnContent.Parameters[`${param}`] = {
            Type: 'String',
            Default: `${param}`,
          };
        }
      }
    });
    cfnContent.Resources.LambdaFunction.Properties.Layers = convertLambdaLayerMetaToLayerCFNArray(
      context,
      functionParameters.lambdaLayers,
      context.amplify.getEnvInfo().envName,
    );
    context.amplify.writeObjectAsJson(cfnFilePath, cfnContent, true);
  }

  return functionParameters;
}

export function migrate(context, projectPath, resourceName) {
  const resourceDirPath = path.join(projectPath, 'amplify', 'backend', category, resourceName);
  const cfnFilePath = path.join(resourceDirPath, `${resourceName}-cloudformation-template.json`);
  const oldCfn: any = JSONUtilities.readJson(cfnFilePath);
  const newCfn: any = {};
  Object.assign(newCfn, oldCfn);

  // Add env parameter
  if (!newCfn.Parameters) {
    newCfn.Parameters = {};
  }
  newCfn.Parameters.env = {
    Type: 'String',
  };

  // Add conditions block
  if (!newCfn.Conditions) {
    newCfn.Conditions = {};
  }
  newCfn.Conditions.ShouldNotCreateEnvResources = {
    'Fn::Equals': [
      {
        Ref: 'env',
      },
      'NONE',
    ],
  };

  // Add if condition for resource name change
  const oldFunctionName = newCfn.Resources.LambdaFunction.Properties.FunctionName;

  newCfn.Resources.LambdaFunction.Properties.FunctionName = {
    'Fn::If': [
      'ShouldNotCreateEnvResources',
      oldFunctionName,
      {
        'Fn::Join': [
          '',
          [
            oldFunctionName,
            '-',
            {
              Ref: 'env',
            },
          ],
        ],
      },
    ],
  };

  newCfn.Resources.LambdaFunction.Properties.Environment = { Variables: { ENV: { Ref: 'env' } } };

  const oldRoleName = newCfn.Resources.LambdaExecutionRole.Properties.RoleName;

  newCfn.Resources.LambdaExecutionRole.Properties.RoleName = {
    'Fn::If': [
      'ShouldNotCreateEnvResources',
      oldRoleName,
      {
        'Fn::Join': [
          '',
          [
            oldRoleName,
            '-',
            {
              Ref: 'env',
            },
          ],
        ],
      },
    ],
  };

  const jsonString = JSON.stringify(newCfn, null, '\t');
  fs.writeFileSync(cfnFilePath, jsonString, 'utf8');
}
