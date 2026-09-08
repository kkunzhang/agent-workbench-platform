import { config } from '../config.js';
import { chooseTool } from './toolService.js';

function titleFor(question) {
  return String(question).replace(/\s+/g, ' ').slice(0, 48);
}

export function buildPlan(question) {
  const toolCalls = chooseTool(question).slice(0, config.agentMaxSteps - 1);
  const steps = [
    { id: 'understand', kind: 'reason', title: '理解目标与约束', status: 'pending' },
    ...toolCalls.map((call, index) => ({
      id: `tool-${index + 1}`,
      kind: 'tool',
      toolName: call.name,
      args: call.args,
      title: `执行 ${call.name}`,
      status: 'pending',
    })),
    { id: 'synthesize', kind: 'answer', title: '基于证据生成回答', status: 'pending' },
  ].slice(0, config.agentMaxSteps + 1);

  return {
    goal: titleFor(question),
    maxSteps: config.agentMaxSteps,
    strategy: toolCalls.length ? 'evidence-first' : 'direct-answer',
    steps,
  };
}

export function formatPlanForPrompt(plan) {
  return plan.steps.map((step, index) => `${index + 1}. ${step.title}`).join('\n');
}
