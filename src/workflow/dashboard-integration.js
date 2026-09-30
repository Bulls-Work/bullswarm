// The agent integration block: each agent's skill, awareness and mod state,
// what an install changed, and the commands that operate the product.
import { glyphs } from '../lib/glyphs.js';
import { rule } from './dash-kit.js';
import { dimText, truncate, visibleLength } from './dashboard-ansi.js';

/** The one-line commands that operate the product, as Runs lists them. */
const DASHBOARD_COMMANDS = Object.freeze([
  'bullswarm run',
  'bullswarm workflow goal "<goal>"',
  'bullswarm workflow watch <id> --next',
  'bullswarm workflow reindex',
  'bullswarm setup',
  'bullswarm doctor',
]);

/** `skill ✓ · awareness ✓`, plus the mod link and hooks flag for Claude. */
function integrationAgentLine(entry) {
  const ok = glyphs().ok;
  const mark = (installed) => (installed ? ok : '—');
  const parts = [
    `skill ${mark(entry.skill?.status === 'installed')}`,
    `awareness ${mark(entry.awareness === true)}`,
  ];
  if (entry.mod !== undefined) {
    parts.push(`mod ${mark(entry.mod?.status === 'installed')}`, `hooks ${mark(entry.hooksFlag === true)}`);
  }
  return `${String(entry.agent ?? '?').padEnd(8)} ${parts.join(' · ')}`;
}

/** What `installIntegration` changed, agent by agent. */
function installResultLines(result) {
  const lines = [' install results'];
  for (const change of result?.changes ?? []) {
    const parts = [
      `skill ${change.skill?.changed ? 'installed' : 'already installed'}`,
      `awareness ${change.awareness?.reason ?? 'unchanged'}`,
    ];
    if (change.mod) parts.push(`mod ${change.mod.changed ? 'linked' : 'already linked'}`);
    if (change.hooksFlag) parts.push(`hooks flag ${change.hooksFlag.reason ?? 'unchanged'}`);
    lines.push(`   ${change.agent} · ${parts.join(' · ')}`);
  }
  if (lines.length === 1) lines.push('   nothing to change');
  return lines;
}

function integrationLines(model, opts, body) {
  const { width } = opts;
  body.push('');
  body.push(rule('agents', null, width));
  const installed = model.integration?.ok === true;
  const button = installed ? `[installed ${glyphs().ok}]` : '[install]';
  const prefix = ' agent integration  ';
  const suffix = installed ? ' · every agent already has it' : ' · i installs the skill and the awareness block for every agent';
  const fits = visibleLength(prefix) + visibleLength(button) + visibleLength(suffix) <= width;
  body.parts([
    { text: prefix },
    { text: button, action: installed ? null : { kind: 'install' } },
    { text: fits ? dimText(suffix, Math.max(0, width - visibleLength(prefix) - visibleLength(button))) : '' },
  ]);
  if (!model.integration) {
    body.push(dimText('   reading the agent integration…', width));
  } else {
    for (const entry of model.integration.agents ?? []) {
      body.push(dimText(`   ${integrationAgentLine(entry)}`, width));
    }
    if (model.installResult) {
      for (const line of installResultLines(model.installResult)) body.push(dimText(truncate(line, width), width));
    }
  }

  body.push('');
  body.push(rule('run it', null, width));
  for (const command of DASHBOARD_COMMANDS) body.push(dimText(`   ${command}`, width));
  return ' bullswarm · runs';
}

export {
  integrationLines,
};
