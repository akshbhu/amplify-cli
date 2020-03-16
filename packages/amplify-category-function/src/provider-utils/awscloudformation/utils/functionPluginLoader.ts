import inquirer from 'inquirer'
import {
  FunctionParameters,
  FunctionTemplateCondition,
  FunctionRuntimeCondition,
  FunctionRuntimeParameters,
  FunctionTemplateParameters,
  ContributorFactory
} from 'amplify-function-plugin-interface';
import _ from 'lodash';

/*
 * This file contains the logic for loading, selecting and executing function plugins (currently runtime and template plugins)
 */

 /**
  * Selects a function template
  */
export async function templateWalkthrough(context: any, params: Partial<FunctionParameters>): Promise<FunctionTemplateParameters> {
  const selectionOptions: PluginSelectionOptions<FunctionTemplateCondition> = {
    pluginType: 'functionTemplate',
    itemName: 'template',
    listOptionsField: 'templates',
    predicate: condition => {
      return condition.provider === params.providerContext.provider
        && condition.service === params.providerContext.service
        && condition.runtime === params.runtime.name
    }
  }
  const selection = await getSelectionFromContributors<FunctionTemplateCondition>(context, selectionOptions);
  const executionParams: PluginExecutionParameters = {
    ...selection,
    context,
    expectedFactoryFunction: 'functionTemplateContributorFactory',
  }
  return await getContributionFromPlugin<FunctionTemplateParameters>(executionParams)
}

/**
 * Selects a function runtime
 */
export async function runtimeWalkthrough(context: any, params: Partial<FunctionParameters>): Promise<FunctionRuntimeParameters> {
  const selectionOptions: PluginSelectionOptions<FunctionRuntimeCondition> = {
    pluginType: 'functionRuntime',
    itemName: 'runtime',
    listOptionsField: 'runtimes',
    predicate: condition => {
      return condition.provider === params.providerContext.provider
        && condition.service === params.providerContext.service
    }
  }
  const selection = await getSelectionFromContributors<FunctionRuntimeCondition>(context, selectionOptions);
  const executionParams: PluginExecutionParameters = {
    ...selection,
    context,
    expectedFactoryFunction: 'functionRuntimeContributorFactory',
  }
  return await getContributionFromPlugin<FunctionRuntimeParameters>(executionParams)

}

/**
 * Parses plugin metadat to present plugin selections to the user and return the selection.
 */
async function getSelectionFromContributors<T>(context: any, selectionOptions: PluginSelectionOptions<T>): Promise<PluginSelection> {
  // get providers from context
  const templateProviders = context.pluginPlatform.plugins[selectionOptions.pluginType];
  if (!templateProviders) {
    throw 'No template plugins found. You can either create your function from scratch or download and install template plugins then rerun this command.';
  }

  // load the selections contributed from each provider, constructing a map of selection to provider as we go
  const selectionMap: Map<string, string> = new Map();
  const selections = templateProviders
    .filter(meta => selectionOptions.predicate(meta.manifest[selectionOptions.pluginType].conditions))
    .map(meta => {
      const packageLoc = meta.packageLocation;
      (meta.manifest[selectionOptions.pluginType][selectionOptions.listOptionsField] as ListOption[]).forEach(op => {
        selectionMap.set(op.value, packageLoc)
      })
      return meta;
    })
    .map(meta => meta.manifest[selectionOptions.pluginType])
    .flatMap(contributes => contributes[selectionOptions.listOptionsField]);

  // sanity checks
  let selection;
  if (selections.length === 0) {
    context.print.warning(`No ${selectionOptions.itemName} found for the selected function configuration`)
    context.print.warning(`You can download and install ${selectionOptions.itemName} plugins then rerun this command`)
  } else if (selections.length === 1) {
    context.print.info(`${selections[0].name} found for selected function configuration.`)
    selection = selections[0].value;
  } else {
    // ask which template to use
    let answer = await inquirer.prompt([{
      type: 'list',
      name: 'selection',
      message: `Choose the function ${selectionOptions.itemName} that you want to use:`,
      choices: selections
    }]);
    selection = answer.selection;
  }

  return {
    selection,
    pluginPath: selectionMap.get(selection),
  }
}

// Executes the selected option using the given plugin
async function getContributionFromPlugin<T extends Partial<FunctionParameters>>(params: PluginExecutionParameters): Promise<T> {
  let plugin;
  try {
    plugin = await import(params.pluginPath);
  } catch (err) {
    throw new Error('Could not load selected plugin');
  }
  if (!plugin) {
    throw new Error('Could not load selected plugin');
  }
  return await (plugin[params.expectedFactoryFunction] as ContributorFactory<T>)(params.context)
    .contribute(params.selection)
}


// Convenience interfaces that are private to this class

interface PluginSelectionOptions<T extends FunctionRuntimeCondition | FunctionTemplateCondition> {
  pluginType: string
  itemName: string
  predicate: (condition: T) => boolean
  listOptionsField: string
}

type PluginSelection = Pick<PluginExecutionParameters, 'pluginPath' | 'selection'>

interface PluginExecutionParameters {
  pluginPath: string
  selection: string
  expectedFactoryFunction: string
  context: any // Amplify core context
}

interface ListOption {
  name: string
  value: string
}
