import inquirer from 'inquirer';
import _ from 'lodash';
import path from 'path';
import { LayerParameters, Permissions, layerMetadataFactory, OrgsLayer, AccountsLayer} from '../utils/layerParams';
import { runtimeWalkthrough } from '../utils/functionPluginLoader';
import { layerNameQuestion, layerPermissionsQuestion, layerAccountAccessQuestion, layerOrgAccessQuestion, createVersionsMap, layerVersionQuestion} from '../utils/layerHelpers';
import { ServiceName, categoryName, layerParametersFileName } from '../utils/constants';
import * as fs from 'fs-extra';

export async function createLayerWalkthrough(context: any, parameters: Partial<LayerParameters> = {}): Promise<Partial<LayerParameters>> {
  _.assign(parameters, await inquirer.prompt(layerNameQuestion(context)));

  let runtimeReturn = await runtimeWalkthrough(context, parameters);
  parameters.runtimes = runtimeReturn.map(val => val.runtime);

  _.assign(parameters, await inquirer.prompt(layerPermissionsQuestion(parameters.layerPermissions)));

  for (let permissions of parameters.layerPermissions) {
    switch (permissions) {
      case Permissions.awsAccounts:
        _.assign(parameters, await inquirer.prompt(layerAccountAccessQuestion()));
        break;
      case Permissions.awsOrg:
        _.assign(parameters, await inquirer.prompt(layerOrgAccessQuestion()));
        break;
    }
  }
  _.assign(parameters,{layerVersion : "1"});
  // add layer version to parameters
  _.assign(parameters, {layerVersionsMap: createVersionsMap(parameters,"1")});
  _.assign(parameters,{build : true})
  return parameters;
}

export async function updateLayerWalkthrough(
  context: any,
  templateParameters: Partial<LayerParameters>,
): Promise<Partial<LayerParameters>> {
  const { allResources } = await context.amplify.getResourceStatus();
  const resources = allResources.filter(resource => resource.service === ServiceName.LambdaLayer).map(resource => resource.resourceName);

  if (resources.length === 0) {
    context.print.error('No Lambda Layer resource to update. Please use "amplify add function" command to create a new Function');
    process.exit(0);
    return;
  }
  const resourceQuestion = [
    {
      name: 'resourceName',
      message: 'Please select the Lambda Layer you want to update',
      type: 'list',
      choices: resources,
    },
  ];
  const resourceAnswer = await inquirer.prompt(resourceQuestion);
  _.assign(templateParameters ,{layerName : resourceAnswer.resourceName});

  const projectBackendDirPath = context.amplify.pathManager.getBackendDirPath();
  const resourceDirPath = path.join(projectBackendDirPath, categoryName, templateParameters.layerName);
  const parametersFilePath = path.join(resourceDirPath, layerParametersFileName);
  let currentParameters;
  try {
    currentParameters = context.amplify.readJsonFile(parametersFilePath);
  } catch (e) {
    currentParameters = {};
  }

  _.assign(templateParameters, currentParameters.parameters);
  // get the LayerObj

  const layerData = layerMetadataFactory(_.pick(templateParameters,['runtimes','layerVersionsMap']));
  // runtime question
  let islayerVersionChanged: boolean = true;
  if (await context.amplify.confirmPrompt.run('Do you want to change the compatible runtimes?', false)) {
    let runtimeReturn = await runtimeWalkthrough(context, templateParameters as LayerParameters);
    templateParameters.runtimes = runtimeReturn.map(val => val.runtime);
  } else {
    islayerVersionChanged = false;
  }

  // get the latest version from #currentcloudbackend
  let latestVersionPushed =  getLastestVersionPushed(context,templateParameters.layerName);
  let latestVersion = layerData.listVersions().reduce((a,b)=>Math.max(a,b));

  // get the latest accounts/orgsid
  let layerPermissions = layerData.getVersion(latestVersion).permissions.map(permission => permission.type);
  let defaultorgsId =  layerData.getVersion(latestVersion).permissions.filter(permission => permission.type === Permissions.awsOrg);
  let defaultaccountsId = layerData.getVersion(latestVersion).permissions.filter(permission => permission.type === Permissions.awsAccounts);
  let defaultaccounts : string[] = defaultaccountsId.length !== 0 ? (defaultaccountsId[0] as AccountsLayer).accounts : [];
  let defaultorgs : string[] = defaultorgsId.length !== 0 ? (defaultorgsId[0] as OrgsLayer).orgs : [];

  if (await context.amplify.confirmPrompt.run('Do you want to adjust who can access the current & new layer version?', true)) {
    _.assign(templateParameters,{layerPermissions : layerPermissions}); // assign permissions if layer is updated
    _.assign(templateParameters, await inquirer.prompt(layerPermissionsQuestion(templateParameters.layerPermissions)));
    // get the account/ordsID based on the permissions selected and pass defaults in the questions workflow

    for (let permissions of templateParameters.layerPermissions) {
      switch (permissions) {
        case Permissions.awsAccounts:
          _.assign(templateParameters, await inquirer.prompt(layerAccountAccessQuestion(defaultaccounts)));
          break;
        case Permissions.awsOrg:
          _.assign(templateParameters, await inquirer.prompt(layerOrgAccessQuestion(defaultorgs)));
          break;
      }
    }
  }
  if(islayerVersionChanged){
    if(latestVersion === latestVersionPushed){
      latestVersion += 1;
    }
    // updating map for a new version
    let map = createVersionsMap(templateParameters,String(latestVersion));
    templateParameters.layerVersionsMap[Object.keys(map)[0]] = map[Object.keys(map)[0]];
  }
  else{
    //updating map for the selected version
    let versions = layerData.listVersions();
    const versionAnswer = await inquirer.prompt(layerVersionQuestion(versions));
    let map = createVersionsMap(templateParameters,String(versionAnswer.layerVersion));
    templateParameters.layerVersionsMap[Object.keys(map)[0]] = map[Object.keys(map)[0]];
  }
  _.assign(templateParameters,{layerVersion : String(latestVersion)});

  if(latestVersion === latestVersionPushed){
    _.assign(templateParameters,{build : false});
  }
  else{
    _.assign(templateParameters,{build: true});
  }
  return templateParameters;
}

 function getLastestVersionPushed(context,layerName : string){
  const projectBackendDirPath = context.amplify.pathManager.getCurrentCloudBackendDirPath();
  const resourceDirPath = path.join(projectBackendDirPath, categoryName, layerName);
  if(!fs.existsSync(resourceDirPath)){
    return 0;
  }
  const parametersFilePath = path.join(resourceDirPath, layerParametersFileName);
  let prevParameters =  context.amplify.readJsonFile(parametersFilePath);
  const prevlayerData = layerMetadataFactory(prevParameters.parameters);
  let latestVersionPushed = prevlayerData.listVersions().reduce((a,b)=> Math.max(a,b));
  return latestVersionPushed;
}