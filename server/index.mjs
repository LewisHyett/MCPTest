#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function loadGuidelines() {
  try {
    return await fs.readFile(path.join(repoRoot, 'README.md'), 'utf-8');
  } catch {
    return 'Guidelines: Keep code clear, documented, and maintainable. Prefer clear names, avoid unused variables, and ensure formatting is consistent.';
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
  const rx = new RegExp(`///[\\s\\S]*?\\n\\s*(?:procedure|local\\s+procedure|trigger)\\s+${name}\\b`);
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
      const rx = new RegExp(`\\b${escapeRegExp(v)}\\b`, 'g');
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

function renderReview(guidelines, findings, opts = {}) {
  const bySeverity = { blocker: [], major: [], minor: [], info: [] };
  for (const f of findings) bySeverity[f.severity ?? 'info'].push(f);
  const sevIcon = { blocker: '⛔', major: '❗', minor: '⚠️', info: '💡' };
  const lines = [];
  lines.push('## Summary');
  const total = findings.length;
  const sev = Object.entries(bySeverity).map(([k,v]) => `${k}:${v.length}`).join(', ');
  lines.push(`- ✅ Reviewed project against README guidelines. Findings: ${total}.`);
  lines.push(`- 🧭 Severity breakdown: ${sev}.`);
  if (opts.focus?.length) lines.push(`- 🎯 Focus: ${opts.focus.join(', ')}`);
  lines.push('');
  lines.push('## Findings');
  if (!findings.length) {
    lines.push('- ✅ No issues found against current rules.');
  } else {
    let i = 1;
    for (const f of findings) {
      const icon = sevIcon[f.severity] || '💡';
      lines.push(`${i++}. ${icon} [${f.severity}] ${f.rule} — ${f.message} (${f.file})`);
    }
  }
  lines.push('');
  lines.push('## Next steps');
  lines.push('- [ ] Address major/blocker items first, then minors.');
  lines.push('- [ ] Save changes and re-run review.');
  lines.push('');
  lines.push('## Guidelines reference');
  lines.push(guidelines.split('\n').map(l => `> ${l}`).join('\n'));
  return lines.join('\n');
}

async function main() {
  const server = new Server(
    { name: 'al-reviewer', version: '0.1.0' }, 
    { capabilities: { tools: {} } }
  );

  // Add error handling for server events
  server.onerror = (error) => {
    console.error('[MCP Server Error]:', error);
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'review_al_repository',
        description: 'Friendly review of AL files against guidelines in README.md, returning a human-readable summary.',
        inputSchema: { 
          type: 'object', 
          properties: { 
            repoPath: { type: 'string', description: 'Path to the AL repository to review' } 
          }, 
          required: ['repoPath'] 
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const { name, arguments: args } = req.params;
      const guidelines = await loadGuidelines();
      const repoPath = args.repoPath || repoRoot;
      
      if (name === 'review_al_repository') {
        const findings = await lintRepo(repoPath, ['**/*.al'], {});
        const text = renderReview(guidelines, findings, {});
        return { content: [{ type: 'text', text }, { type: 'json', data: { findings } }] };
      }
      
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    } catch (error) {
      console.error('[Tool Error]:', error);
      return { 
        content: [{ 
          type: 'text', 
          text: `Error executing tool: ${error.message}` 
        }] 
      };
    }
  });

  const transport = new StdioServerTransport();
  
  // Add connection event handlers
  transport.onclose = () => {
    console.error('[Transport] Connection closed');
    process.exit(0);
  };

  transport.onerror = (error) => {
    console.error('[Transport Error]:', error);
    process.exit(1);
  };

  // Signal that server is ready
  console.error('[MCP Server] Starting AL Reviewer server...');
  
  try {
    await server.connect(transport);
    console.error('[MCP Server] Connected and ready');
  } catch (error) {
    console.error('[MCP Server] Failed to connect:', error);
    process.exit(1);
  }
}

// ---------------- CLI mode for quick local tests ----------------
async function cli() {
  const cmd = process.argv[2];
  if (!cmd || (cmd !== 'review')) return false; // not CLI mode
  const getArg = (name, def) => {
    const i = process.argv.indexOf(name);
    if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
    return def;
  };
  const repoPath = getArg('--repo', path.resolve(repoRoot, '..'));
  const focusArg = getArg('--focus', '');
  const focus = focusArg ? focusArg.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const guidelines = await loadGuidelines();
  const findings = await lintRepo(repoPath, ['**/*.al'], {});
  if (cmd === 'review') {
    const text = renderReview(guidelines, findings, { focus });
    console.log(text);
  }
  return true;
}

(async () => {
  // Handle process signals gracefully
  process.on('SIGINT', () => {
    console.error('[MCP Server] Received SIGINT, shutting down gracefully...');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.error('[MCP Server] Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });

  process.on('uncaughtException', (error) => {
    console.error('[MCP Server] Uncaught exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[MCP Server] Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });

  try {
    const handled = await cli();
    if (!handled) {
      await main();
    }
  } catch (err) {
    console.error('[MCP Server] Fatal error:', err);
    process.exit(1);
  }
})();

// helper
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// (Removed propose/apply helpers; editor UX can offer suggestions natively.)
