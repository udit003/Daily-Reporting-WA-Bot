/**
 * Minimal ambient type declaration for `node-cron` (which ships no types and
 * isn't covered by `@types`). Only the surface we use is declared.
 */
declare module "node-cron" {
  export interface ScheduledTask {
    start(): void;
    stop(): void;
  }

  export interface ScheduleOptions {
    scheduled?: boolean;
    timezone?: string;
    name?: string;
  }

  export function schedule(
    cronExpression: string,
    func: () => void | Promise<void>,
    options?: ScheduleOptions,
  ): ScheduledTask;

  export function validate(cronExpression: string): boolean;
  export function getTasks(): Map<string, ScheduledTask>;

  const _default: {
    schedule: typeof schedule;
    validate: typeof validate;
    getTasks: typeof getTasks;
  };
  export default _default;
}
