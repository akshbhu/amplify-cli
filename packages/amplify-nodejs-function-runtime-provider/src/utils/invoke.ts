import { fork } from 'child_process';
import { InvokeOptions } from './invokeOptions';
import path from 'path';

// copied from amplify-util-mock with slight modifications
export function invoke(options: InvokeOptions): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      let data: string = '';
      const lambdaFn = fork(path.join(__dirname, 'execute.js'), [], {
        execArgv: [],
        env: options.environment || {},
        silent: true,
      });
      lambdaFn.stdout.on('data', msg => {
        data += msg;
      });
      lambdaFn.on('close', () => {
        const lines = data.split('\n');
        const lastLine = lines[lines.length - 1];
        const result = JSON.parse(lastLine);
        if (result.error) {
          reject(result.error);
        }
        resolve(result.result);
      });
      lambdaFn.send(JSON.stringify(options));
    } catch (e) {
      reject(e);
    }
  });
}
