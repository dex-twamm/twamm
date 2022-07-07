import Task from '../../src/task';
import { TaskRunOptions } from '../../src/types';
import { TwammPoolDeployment } from './input';

export default async (task: Task, { force, from }: TaskRunOptions = {}): Promise<void> => {
  const input = task.input() as TwammPoolDeployment;
  const args = [input.Vault];
  await task.deployAndVerify('TwammPoolFactory', args, from, force);
};
