#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function loadPersona() {
  try {
    return await fs.readFile(path.join(repoRoot, 'persona.md'), 'utf-8');
  } catch {
    return 'Senior AL reviewer: direct, constructive, enforce TES standards.';
  }
}

async function loadStandards() {
  try {
    const raw = await fs.readFile(path.join(repoRoot, 'standards.json'), 'utf-8');
    return JSON.parse(raw).rules || {};
  } catch {
    return {};
  }
}

function parseALHeader(content) {
  // very small heuristic parser for object headers
  const rx = /(tableextension|table|pageextension|page|codeunit|report|query|xmlport|enum)\s+(\d+)\s+"([^"]+)"(?:\s+extends\s+"([^"]+)")?/i;
  const m = content.match(rx);
  if (!m) return null;
  return { type: m[1].toLowerCase(), id: Number(m[2]), name: m[3], extends: m[4] };
}

function extractTriggers(content) {
  const matches = [...content.matchAll(/trigger\s+(On[A-Za-z0-9_]+)/g)];
  return matches.map(m => m[1]);
}

function extractProcedures(content) {
  const matches = [...content.matchAll(/(?:procedure|local\s+procedure)\s+([A-Za-z_][A-Za-z0-9_]*)/g)];
  return matches.map(m => m[1]);
}

function hasXmlDocAbove(content, name) {
  const rx = new RegExp(`///[\\s\\S]*?\n\s*(?:procedure|local\\s+procedure|trigger)\\s+${name}\\b`);
  return rx.test(content);
}

function lintFile(filePath, content, rules) {
  const findings = [];
  const header = parseALHeader(content) || {};

  // object prefix rule
  if (header.name && rules.objectPrefix?.requiredPrefix && rules.objectPrefix.applyTo?.includes(header.type)) {
    if (!header.name.startsWith(rules.objectPrefix.requiredPrefix)) {
      findings.push({ severity: rules.objectPrefix.severity || 'major', rule: 'objectPrefix', file: filePath, message: `Object name '${header.name}' should start with '${rules.objectPrefix.requiredPrefix}'.` });
    }
  }

  // documentation on triggers/procedures
  if (rules.documentation?.requireXmlDoc) {
    for (const t of extractTriggers(content)) {
      if (!hasXmlDocAbove(content, t)) {
        findings.push({ severity: rules.documentation.severity || 'major', rule: 'xmlDoc', file: filePath, message: `Missing XML doc for trigger ${t}.` });
      }
    }
    for (const p of extractProcedures(content)) {
      if (!hasXmlDocAbove(content, p)) {
        findings.push({ severity: rules.documentation.severity || 'major', rule: 'xmlDoc', file: filePath, message: `Missing XML doc for procedure ${p}.` });
      }
    }
  }

  // variables quick checks
  if (rules.variables?.includeObjectContext) {
    if (/var\s*\n([^;]+);/i.test(content)) {
      // heuristics only: encourage intentful names
    }
  }

  // formatting: basic brace new line check (heuristic)
  if (rules.formatting?.braceOnNewLine) {
    if (/\)\s*\{/.test(content)) {
      findings.push({ severity: rules.formatting.severity || 'minor', rule: 'braceOnNewLine', file: filePath, message: 'Curly brace should be on a new line.' });
    }
  }

  // unused variable simple heuristic
  const varBlock = content.match(/var\s*([\s\S]*?)\bbegin\b/i);
  if (varBlock) {
    const varNames = [...varBlock[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(m => m[1]);
    for (const v of varNames) {
      const rx = new RegExp(`\b${v}\b`, 'g');
      const count = (content.match(rx) || []).length;
      if (count <= 1) {
        findings.push({ severity: 'minor', rule: 'unusedVariable', file: filePath, message: `Variable '${v}' appears unused.` });
      }
    }
  }

  return findings;
}

async function lintRepo(root, globs, rules) {
  const files = await fg(globs, { cwd: root, dot: true });
  const all = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const content = await fs.readFile(abs, 'utf-8');
    const findings = lintFile(rel, content, rules);
    all.push(...findings);
  }
  return all;
}

function renderReview(persona, findings, opts = {}) {
  const bySeverity = { blocker: [], major: [], minor: [], info: [] };
  for (const f of findings) bySeverity[f.severity ?? 'info'].push(f);
  const lines = [];
  lines.push('Summary');
  const total = findings.length;
  const sev = Object.entries(bySeverity).map(([k,v]) => `${k}:${v.length}`).join(', ');
  lines.push(`- Checked ${total} findings. Severity: ${sev}`);
  if (opts.focus) lines.push(`- Focus: ${opts.focus.join(', ')}`);
  lines.push('');
  lines.push('Findings');
  let i = 1;
  for (const f of findings) {
    lines.push(`${i++}. [${f.severity}] ${f.rule} — ${f.message} (${f.file})`);
  }
  lines.push('');
  lines.push('Next steps');
  lines.push('- Address major/blocker items first, then minors.');
  lines.push('- Re-run lint and raise PR.');
  lines.push('');
  lines.push('Reviewer persona');
  lines.push(persona.split('\n').map(l => `> ${l}`).join('\n'));
  return lines.join('\n');
}

async function main() {
  const server = new Server({ name: 'al-reviewer', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'lint_al_repository',
        description: 'Lint AL files against TES standards.json',
        inputSchema: { type: 'object', properties: { repoPath: { type: 'string', description: 'Path to repository root' } }, required: ['repoPath'] }
      },
      {
        name: 'review_al_repository',
        description: 'Persona-shaped human review of AL code based on standards.json and persona.md',
        inputSchema: { type: 'object', properties: { repoPath: { type: 'string' }, focus: { type: 'array', items: { type: 'string' } } }, required: ['repoPath'] }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const persona = await loadPersona();
    const standards = await loadStandards();
    const repoPath = args.repoPath || repoRoot;
    if (name === 'lint_al_repository') {
      const findings = await lintRepo(repoPath, ['**/*.al'], standards);
      return { content: [{ type: 'json', data: { findings } }] };
    }
    if (name === 'review_al_repository') {
      const findings = await lintRepo(repoPath, ['**/*.al'], standards);
      const text = renderReview(persona, findings, { focus: args.focus });
      return { content: [{ type: 'text', text }, { type: 'json', data: { findings } }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
