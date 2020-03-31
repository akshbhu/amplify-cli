import inquirer from 'inquirer';
inquirer.registerPrompt('datetime', require('inquirer-datepicker'));
import { CronBuilder } from '../utils/cronBuilder';

export async function minuteHelper(context: any) {
  const minuteQuestion = {
    type: 'input',
    name: 'minutes',
    message: 'Enter the rate in mintues:',
    validate: context.amplify.inputValidation({
      operator: 'regex',
      value: '^[1-9][0-9]*$', // change to /d after checking
      onErrorMsg: 'Value needs to be a positive integer',
      required: true,
    }),
  };
  const minuteAnswer = await inquirer.prompt([minuteQuestion]);
  const plural = minuteAnswer.minutes === '1' ? '' : 's';
  return `rate(${minuteAnswer.minutes} minute${plural})`;
}

export async function hourHelper(context: any) {
  const hourQuestion = {
    type: 'input',
    name: 'hours',
    message: 'Enter the rate in hours:',
    validate: context.amplify.inputValidation({
      validation: {
        operator: 'regex',
        value: '^[1-9][0-9]*$',
        onErrorMsg: 'Value needs to be a positive integer',
      },
      required: true,
    }),
  };
  const hourAnswer = await inquirer.prompt([hourQuestion]);
  const plural = hourAnswer.hours === '1' ? '' : 's';
  return `rate(${hourAnswer.hours} hour${plural})`;
}

export async function timeHelper(exp: CronBuilder) {
  const timeQuestion = {
    type: 'datetime',
    name: 'dt',
    message: 'Select the start time (use arrow keys):',
    format: ['hh', ':', 'mm', ' ', 'A'],
  };
  const timeAnswer = await inquirer.prompt([timeQuestion]);
  exp.set(
    'minute',
    (timeAnswer.dt as any)
      .getMinutes()
      .toString()
      .split(),
  );
  exp.set(
    'hour',
    (timeAnswer.dt as any)
      .getHours()
      .toString()
      .split(),
  );
  return exp;
}

export async function weekHelper(exp: CronBuilder) {
  const WeekQuestion = {
    type: 'list',
    name: 'week',
    message: 'Select the day to invoke the function:',
    choices: [
      { name: 'Sunday', value: '1' },
      { name: 'Monday', value: '2' },
      { name: 'Tuesday', value: '3' },
      { name: 'Wednesday', value: '4' },
      { name: 'Thursday', value: '5' },
      { name: 'Friday', value: '6' },
      { name: 'Saturday', value: '7' },
    ],
  };
  const weekAnswer = await inquirer.prompt([WeekQuestion]);
  exp.set('dayOfTheWeek', Array(weekAnswer.week));
  return exp;
}

export async function monthHelper(exp, context) {
  const dateQuestion = {
    type: 'datetime',
    name: 'dt',
    message: 'Select on which day of the month to invoke the function (use arrow keys):',
    format: ['DD'],
  };
  const dateAnswer = await inquirer.prompt([dateQuestion]);
  if ((dateAnswer.dt as any).getDate() > 28) {
    const suffix = (dateAnswer.dt as any).getDate() === 31 ? 'st' : 'th';
    context.print.warning(`Function won't be invoked on months without the ${(dateAnswer.dt as any).getDate()}${suffix} day`);
  }
  exp.set(
    'dayOfTheMonth',
    (dateAnswer.dt as any)
      .getDate()
      .toString()
      .split(),
  );
  return exp;
}

export async function yearHelper(exp, context) {
  const dateQuestion = {
    type: 'datetime',
    name: 'dt',
    message: 'Select the month and date to invoke the function (mm / dd) (use arrow keys):',
    format: ['MM', '/', 'DD'],
  };
  const dateAnswer = await inquirer.prompt([dateQuestion]);
  if ((dateAnswer.dt as any).getDate() > 28) {
    const suffix = (dateAnswer.dt as any).getDate() === 31 ? 'st' : 'th';
    context.print.warning(`Function won't be invoked on months without the ${(dateAnswer.dt as any).getDate()}${suffix} day`);
  }
  exp.set(
    'dayOfTheMonth',
    (dateAnswer.dt as any)
      .getDate()
      .toString()
      .split(),
  );
  exp.set(
    'month',
    (dateAnswer.dt as any)
      .getMonth()
      .toString()
      .split(),
  );
  return exp;
}
