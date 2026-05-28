#!/usr/bin/env node
import { Command } from 'commander';
import { createRunCommand } from './commands/run.js';
import { createStatusCommand } from './commands/status.js';

const program = new Command();

program
  .name('agent-factory')
  .description('Agent Factory CLI — dispatch tasks and monitor the agent orchestration system')
  .version('0.1.0');

program.addCommand(createRunCommand());
program.addCommand(createStatusCommand());

program.parse();
