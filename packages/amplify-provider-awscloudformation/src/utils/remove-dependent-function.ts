import { appsyncTableSuffix } from 'amplify-category-function/lib/provider-utils/awscloudformation/utils/constants';
import { $TSContext, $TSObject, pathManager } from 'amplify-cli-core';
import path from 'path';
import * as TransformPackage from 'graphql-transformer-core';
import { updateDependentFunctionsCfn } from 'amplify-category-function';

export async function removeDependencyOnFunctions(
  context: $TSContext,
  apiResource: $TSObject,
  allResources: $TSObject[],
): Promise<$TSObject[]> {
  // get #current-cloud-backed and cloud backend schema.graphql
  let functionResource;
  const backendDir = pathManager.getBackendDirPath();
  const currentBackendDir = pathManager.getCurrentCloudBackendDirPath();
  const modelsDeleted = await getSchemaDiff(currentBackendDir, backendDir, apiResource[0].resourceName);
  if (modelsDeleted.length) {
    functionResource = await updateDependentFunctionsCfn(context, allResources, backendDir, modelsDeleted, apiResource[0].resourceName);
  }
  return functionResource;
}

export async function getSchemaDiff(currentBackendDir: string, BackendDir: string, apiResourceName: string) {
  const deployedModelNames = await getDeployedModelNames(currentBackendDir, apiResourceName);
  const currentModelNames = await getDeployedModelNames(BackendDir, apiResourceName);
  var modelsDeleted = deployedModelNames.filter(val => !currentModelNames.includes(val));
  return modelsDeleted;
}

export async function getDeployedModelNames(backendDir: string, apiResourceName: string) {
  // need all object type name definition node with @model directives present
  const resourceDirPath = path.join(backendDir, 'api', apiResourceName);
  const project = await TransformPackage.readProjectConfiguration(resourceDirPath);
  const directivesMap: any = TransformPackage.collectDirectivesByTypeNames(project.schema);
  const modelNames = Object.keys(directivesMap.types)
    .filter(typeName => directivesMap.types[typeName].includes('model'))
    .map(modelName => `${modelName}:${appsyncTableSuffix}`);
  return modelNames;
}