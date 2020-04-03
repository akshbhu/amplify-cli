import { nspawn as spawn, ExecutionContext, KEY_DOWN_ARROW } from 'amplify-e2e-core';
import { getCLIPath, getProjectMeta, invokeFunction } from '../utils';
import { Lambda } from 'aws-sdk';

type FunctionActions = 'create' | 'update';

type FunctionRuntimes = 'dotnetCore31' | 'go' | 'java' | 'nodejs' | 'python';

type FunctionCallback = (chain: any, cwd: string, settings: any) => any;

// runtimeChoices are shared between tests
export const runtimeChoices = ['.NET Core 3.1', 'Go', 'Java', 'NodeJS', 'Python'];

// templateChoices is per runtime
const dotNetCore31TemplateChoices = ['Hello World', 'Serverless', 'Trigger (DynamoDb, Kinesis)'];

const goTemplateChoices = ['Hello World'];

const javaTemplateChoices = ['Hello World'];

export const nodeJSTemplateChoices = [
  'CRUD function for DynamoDB (Integration with API Gateway)',
  'Hello World',
  'Lambda trigger',
  'Serverless ExpressJS function (Integration with API Gateway)',
];

const pythonTemplateChoices = ['Hello World'];

export const moveDown = (chain: ExecutionContext, nMoves: number) =>
  Array.from(Array(nMoves).keys()).reduce((chain, _idx) => chain.send(KEY_DOWN_ARROW), chain);

export const moveUp = (chain: ExecutionContext, nMoves: number) =>
  Array.from(Array(nMoves).keys()).reduce((chain, _idx) => chain.send('k'), chain);

export const singleSelect = <T>(chain: ExecutionContext, item: T, allChoices: T[]) => multiSelect(chain, [item], allChoices);

export const multiSelect = <T>(chain: ExecutionContext, items: T[], allChoices: T[]) =>
  items
    .map(item => allChoices.indexOf(item))
    .filter(idx => idx > -1)
    .sort()
    // calculate the diff with the latest, since items are sorted, always positive
    // represents the numbers of moves down we need to make to selection
    .reduce((diffs, move) => (diffs.length > 0 ? [...diffs, move - diffs[diffs.length - 1]] : [move]), [] as number[])
    .reduce((chain, move) => moveDown(chain, move).send(' '), chain)
    .sendCarriageReturn();

const coreFunction = (
  cwd: string,
  settings: any,
  action: FunctionActions,
  runtime: FunctionRuntimes,
  functionConfigCallback: FunctionCallback,
) => {
  return new Promise((resolve, reject) => {
    let chain = spawn(getCLIPath(), [action == 'update' ? 'update' : 'add', 'function'], {
      cwd,
      stripColors: true,
    });

    if (action === 'create') {
      chain
        .wait('Provide a friendly name for your resource to be used as a label')
        .sendLine(settings.name || '')
        .wait('Provide the AWS Lambda function name:')
        .sendLine(settings.name || '');

      selectRuntime(chain, runtime);

      const templateChoices = getTemplateChoices(runtime);
      if (templateChoices.length > 1) {
        singleSelect(chain.wait('Choose the function template that you want to use'), settings.functionTemplate, templateChoices);
      }
    } else {
      chain.wait('Please select the Lambda Function you would want to update').sendCarriageReturn();
    }

    if (functionConfigCallback) {
      functionConfigCallback(chain, cwd, settings);
    }

    if (!settings.expectFailure) {
      chain.wait(
        action == 'create'
          ? 'Do you want to access other resources created in this project from your Lambda function?'
          : 'Do you want to update permissions granted to this Lambda function to perform on other resources in your project?',
      );

      if (settings.additionalPermissions) {
        multiSelect(
          chain.sendLine('y').wait('Select the category'),
          settings.additionalPermissions.permissions,
          settings.additionalPermissions.choices,
        );
        // when single resource, it gets autoselected
        if (settings.additionalPermissions.resources.length > 1) {
          multiSelect(
            chain.wait('Select the one you would like your'),
            settings.additionalPermissions.resources,
            settings.additionalPermissions.resourceChoices,
          );
        }

        // n-resources repeated questions
        settings.additionalPermissions.resources.reduce(
          (chain, elem) =>
            multiSelect(chain.wait(`Select the operations you want to permit for ${elem}`), settings.additionalPermissions.operations, [
              'create',
              'read',
              'update',
              'delete',
            ]),
          chain,
        );
      } else {
        chain.sendLine('n');
      }

      //scheduling questions
      if (action == 'create') {
        chain.wait('Do you want to invoke this function on a recurring schedule?');
      } else {
        if (
          settings.schedulePermissions === undefined ||
          (settings.schedulePermissions && settings.schedulePermissions.noScheduleAdd === 'true')
        ) {
          chain.wait('Do you want to invoke this function on a recurring schedule?');
        } else {
          chain.wait(`Do you want to update or remove the function's schedule?`);
        }
      }

      if (settings.schedulePermissions === undefined) {
        chain.sendLine('n');
      } else {
        chain.sendLine('y');
        cronWalkthrough(chain, settings, action);
      }

      chain
        .wait('Do you want to edit the local lambda function now?')
        .sendLine('n')
        .sendEof();
    }

    chain.run((err: Error) => {
      if (!err) {
        resolve();
      } else {
        reject(err);
      }
    });
  });
};

export const addFunction = (
  cwd: string,
  settings: any,
  runtime: FunctionRuntimes,
  functionConfigCallback: FunctionCallback = undefined,
) => {
  return coreFunction(cwd, settings, 'create', runtime, functionConfigCallback);
};

export const updateFunction = (cwd: string, settings: any, runtime: FunctionRuntimes) => {
  return coreFunction(cwd, settings, 'update', runtime, undefined);
};

export const addLambdaTrigger = (chain: ExecutionContext, cwd: string, settings: any) => {
  chain = singleSelect(
    chain.wait('What event source do you want to associate with Lambda trigger'),
    settings.triggerType === 'Kinesis' ? 'Amazon Kinesis Stream' : 'Amazon DynamoDB Stream',
    ['Amazon DynamoDB Stream', 'Amazon Kinesis Stream'],
  );

  const res = chain
    .wait(`Choose a ${settings.triggerType} event source option`)
    /**
     * Use API category graphql @model backed DynamoDB table(s) in the current Amplify project
     * or
     * Use storage category DynamoDB table configured in the current Amplify project
     */
    .sendLine(settings.eventSource === 'DynamoDB' ? KEY_DOWN_ARROW : '');

  switch (settings.triggerType + (settings.eventSource || '')) {
    case 'DynamoDBAppSync':
      return settings.expectFailure ? res.wait('No AppSync resources have been configured in API category.') : res;
    case 'DynamoDBDynamoDB':
      return settings.expectFailure
        ? res.wait('There are no DynamoDB resources configured in your project currently')
        : res.wait('Choose from one of the already configured DynamoDB tables').sendCarriageReturn();
    case 'Kinesis':
      return settings.expectFailure
        ? res.wait('No Kinesis streams resource to select. Please use "amplify add analytics" command to create a new Kinesis stream')
        : res;
    default:
      return res;
  }
};

export const functionBuild = (cwd: string, settings: any) => {
  return new Promise((resolve, reject) => {
    spawn(getCLIPath(), ['function', 'build'], { cwd, stripColors: true })
      .wait('Are you sure you want to continue building the resources?')
      .sendLine('Y')
      .sendEof()
      .run((err: Error) => {
        if (!err) {
          resolve();
        } else {
          reject(err);
        }
      });
  });
};

export const selectRuntime = (chain: any, runtime: FunctionRuntimes) => {
  const runtimeName = getRuntimeDisplayName(runtime);
  chain.wait('Choose the function runtime that you want to use');

  // reset cursor to top of list because node is default but it throws off offset calculations
  moveUp(chain, runtimeChoices.indexOf(getRuntimeDisplayName('nodejs')));

  singleSelect(chain, runtimeName, runtimeChoices);
};

const cronWalkthrough = (chain: ExecutionContext, settings: any, action: string) => {
  if (action === 'create') {
    addCron(chain, settings);
  } else {
    chain.wait('Select from the following options:');

    switch (settings.schedulePermissions.action) {
      case 'Update the schedule':
        chain.sendCarriageReturn();
        addCron(chain, settings);
        break;
      case 'Remove the schedule':
        moveDown(chain, 1).sendCarriageReturn();
        break;
      default:
        chain.sendCarriageReturn();
        break;
    }
  }

  return chain;
};

const addminutes = (chain: ExecutionContext) => {
  chain
    .wait('Enter rate for mintues(1-59)?')
    .sendLine('5')
    .sendCarriageReturn();

  return chain;
};

const addhourly = (chain: ExecutionContext) => {
  chain
    .wait('Enter rate for hours(1-23)?')
    .sendLine('5')
    .sendCarriageReturn();

  return chain;
};

const addWeekly = (chain: ExecutionContext) => {
  chain.wait('Please select the  day to start Job').sendCarriageReturn();

  return chain;
};

const addMonthly = (chain: ExecutionContext) => {
  chain.wait('Select date to start cron').sendCarriageReturn();

  return chain;
};

const addYearly = (chain: ExecutionContext) => {
  chain.wait('Select date to start cron').sendCarriageReturn();

  return chain;
};

const addCron = (chain: ExecutionContext, settings: any) => {
  chain.wait('At which interval should the function be invoked:');

  switch (settings.schedulePermissions.interval) {
    case 'Minutes':
      addminutes(chain);
      break;
    case 'Hourly':
      addhourly(moveDown(chain, 1).sendCarriageReturn());
      break;
    case 'Daily':
      moveDown(chain, 2)
        .sendCarriageReturn()
        .wait('Select the start time (use arrow keys):')
        .sendCarriageReturn();
      break;
    case 'Weekly':
      addWeekly(moveDown(chain, 3).sendCarriageReturn());
      break;
    case 'Monthly':
      addMonthly(moveDown(chain, 4).sendCarriageReturn());
      break;
    case 'Yearly':
      addYearly(moveDown(chain, 5).sendCarriageReturn());
      break;
    case 'Custom AWS cron expression':
      moveDown(chain, 6).sendCarriageReturn();
      break;
    default:
      chain.sendCarriageReturn();
      break;
  }

  return chain;
};

export const functionMockAssert = (cwd: string, settings: { funcName: string; successString: string; eventFile: string }) => {
  return new Promise((resolve, reject) => {
    spawn(getCLIPath(), ['mock', 'function', settings.funcName, '--event', settings.eventFile], { cwd, stripColors: true })
      .wait('Result:')
      .wait(settings.successString)
      .wait('Finished execution.')
      .sendEof()
      .run(err => (err ? reject(err) : resolve()));
  });
};

export const functionCloudInvoke = async (
  cwd: string,
  settings: { funcName: string; payload: string },
): Promise<Lambda.InvocationResponse> => {
  const meta = getProjectMeta(cwd);
  const { Name: functionName, Region: region } = meta.function[settings.funcName].output;
  expect(functionName).toBeDefined();
  expect(region).toBeDefined();
  const result = await invokeFunction(functionName, settings.payload, region);
  if (!result.$response.data) {
    fail('No data in lambda response');
  }
  return result.$response.data as Lambda.InvocationResponse;
};

const getTemplateChoices = (runtime: FunctionRuntimes) => {
  switch (runtime) {
    case 'dotnetCore31':
      return dotNetCore31TemplateChoices;
    case 'go':
      return goTemplateChoices;
    case 'java':
      return javaTemplateChoices;
    case 'nodejs':
      return nodeJSTemplateChoices;
    case 'python':
      return pythonTemplateChoices;
    default:
      throw new Error(`Invalid runtime value: ${runtime}`);
  }
};

const getRuntimeDisplayName = (runtime: FunctionRuntimes) => {
  switch (runtime) {
    case 'dotnetCore31':
      return '.NET Core 3.1';
    case 'go':
      return 'Go';
    case 'java':
      return 'Java';
    case 'nodejs':
      return 'NodeJS';
    case 'python':
      return 'Python';
    default:
      throw new Error(`Invalid runtime value: ${runtime}`);
  }
};
