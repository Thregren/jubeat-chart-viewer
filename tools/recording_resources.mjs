import os from 'node:os';
export function resourcePlan(args, machine = {cpus: os.availableParallelism?.() || os.cpus().length, memory: os.totalmem()}) {
  const integer = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  const quiet = args['resource-mode'] === 'quiet';
  const automatic = Math.max(1, Math.min(9, machine.cpus, Math.floor(machine.memory / (1.5 * 1024 ** 3))));
  const budget = quiet ? 1 : Math.min(32, integer(args['max-workers'], automatic));
  const songs = Math.min(budget, integer(args.concurrency, 1));
  const jobs = Math.max(1, Math.min(3, integer(args.jobs, 1), Math.floor(budget / songs)));
  return {budget, songs, jobs};
}
export function ownedCommand(command, executable, profile, port) {
  const hasArg = arg => command.includes(arg) && command.slice(command.indexOf(arg) + arg.length).match(/^(?:\s|$)/);
  return Boolean(profile && command.startsWith(executable + ' ') && hasArg('--user-data-dir=' + profile) && hasArg('--remote-debugging-port=' + port));
}
