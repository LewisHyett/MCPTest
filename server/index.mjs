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

function renderReview(persona, findings, opts = {}) {
  const bySeverity = { blocker: [], major: [], minor: [], info: [] };
  for (const f of findings) bySeverity[f.severity ?? 'info'].push(f);
  const sevIcon = { blocker: '⛔', major: '❗', minor: '⚠️', info: '💡' };
  const lines = [];
  lines.push('## Summary');
  const total = findings.length;
  const sev = Object.entries(bySeverity).map(([k,v]) => `${k}:${v.length}`).join(', ');
  lines.push(`- ✅ Analyzed repository. Findings: ${total}.`);
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
  lines.push('- [ ] Re-run lint and raise PR.');
  lines.push('');
  lines.push('## Reviewer persona');
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
      },
      {
        name: 'propose_fixes',
        description: 'Suggest non-destructive edits for findings (does not apply changes).',
        inputSchema: {
          type: 'object',
          properties: {
            repoPath: { type: 'string' },
            focusRules: { type: 'array', items: { type: 'string' }, description: 'Optional rule filter, e.g., ["unusedVariable","xmlDoc"]' }
          },
          required: ['repoPath']
        }
      },
      {
        name: 'apply_edits',
        description: 'Apply a previously proposed set of edits. Requires confirm=true.',
        inputSchema: {
          type: 'object',
          properties: {
            repoPath: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  edits: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        range: {
                          type: 'object',
                          properties: {
                            start: { type: 'object', properties: { line: { type: 'number' }, column: { type: 'number' } }, required: ['line','column'] },
                            end: { type: 'object', properties: { line: { type: 'number' }, column: { type: 'number' } }, required: ['line','column'] }
                          },
                          required: ['start','end']
                        },
                        newText: { type: 'string' }
                      },
                      required: ['range','newText']
                    }
                  }
                },
                required: ['file','edits']
              }
            },
            confirm: { type: 'boolean', description: 'Must be true to write changes' }
          },
          required: ['repoPath','files','confirm']
        }
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
    if (name === 'propose_fixes') {
      const findings = await lintRepo(repoPath, ['**/*.al'], standards);
      const filtered = Array.isArray(args.focusRules) && args.focusRules.length
        ? findings.filter(f => args.focusRules.includes(f.rule))
        : findings;
      const proposal = await proposeFixes(repoPath, filtered);
      return { content: [{ type: 'json', data: proposal }] };
    }
    if (name === 'apply_edits') {
      if (!args.confirm) {
        return { content: [{ type: 'text', text: 'Edits not applied: confirm=false. Please review and re-run with confirm=true.' }] };
      }
      const result = await applyEdits(repoPath, args.files);
      return { content: [{ type: 'json', data: result }] };
    }
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------- CLI mode for quick local tests ----------------
async function cli() {
  const cmd = process.argv[2];
  if (!cmd || (cmd !== 'lint' && cmd !== 'review' && cmd !== 'propose' && cmd !== 'apply')) return false; // not CLI mode
  const getArg = (name, def) => {
    const i = process.argv.indexOf(name);
    if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
    return def;
  };
  const repoPath = getArg('--repo', path.resolve(repoRoot, '..'));
  const focusArg = getArg('--focus', '');
  const focus = focusArg ? focusArg.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  const persona = await loadPersona();
  const standards = await loadStandards();
  const findings = await lintRepo(repoPath, ['**/*.al'], standards);
  if (cmd === 'lint') {
    console.log(JSON.stringify({ findings }, null, 2));
  } else if (cmd === 'review') {
    const text = renderReview(persona, findings, { focus });
    console.log(text);
  } else if (cmd === 'propose') {
    const proposal = await proposeFixes(repoPath, findings);
    console.log(JSON.stringify(proposal, null, 2));
  } else if (cmd === 'apply') {
    const proposalPath = getArg('--proposal', 'proposal.json');
    const confirm = (getArg('--confirm', 'false') === 'true');
    if (!confirm) {
      console.log('Edits not applied: confirm=false. Pass --confirm true to apply.');
      return true;
    }
    // Read proposal from file (robust for PowerShell encodings) or stdin when path is '-'
    const buf = proposalPath === '-' ? await readAllStdin() : await fs.readFile(proposalPath);
    const raw = decodeBufferToString(buf);
    const proposal = JSON.parse(stripUtf8Bom(raw));
    const result = await applyEdits(repoPath, proposal.files || []);
    console.log(JSON.stringify(result, null, 2));
  }
  return true;
}

(async () => {
  try {
    const handled = await cli();
    if (!handled) await main();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();

// helper
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------- Fix proposal and application helpers -------
async function proposeFixes(root, findings) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }
  const files = [];
  for (const [rel, flist] of byFile.entries()) {
    const abs = path.join(root, rel);
    const text = await fs.readFile(abs, 'utf-8');
    const lines = text.split(/\r?\n/);
    const edits = [];

    // helper to push edit
    const pushEdit = (startLine, startCol, endLine, endCol, newText) => {
      edits.push({ range: { start: { line: startLine, column: startCol }, end: { line: endLine, column: endCol } }, newText });
    };

    for (const f of flist) {
      if (f.rule === 'unusedVariable') {
        // find declaration line between var .. begin
        let varStart = lines.findIndex(l => /^\s*var\b/i.test(l));
        let beginLine = lines.findIndex(l => /\bbegin\b/i.test(l));
        if (varStart !== -1 && beginLine !== -1 && beginLine > varStart) {
          const varName = extractVarNameFromMessage(f.message);
          const declRx = new RegExp(`^\\s*${escapeRegExp(varName)}\\s*:\\s*[^;]+;\\s*$`);
          for (let i = varStart + 1; i < beginLine; i++) {
            const l = lines[i];
            if (declRx.test(l)) {
              // remove this line including trailing newline
              pushEdit(i, 0, i + 1, 0, '');
              break;
            }
          }
        } else {
          // fallback: search entire file for declaration
          const varName = extractVarNameFromMessage(f.message);
          const declRx = new RegExp(`^\\s*${escapeRegExp(varName)}\\s*:\\s*[^;]+;\\s*$`);
          for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (declRx.test(l)) {
              pushEdit(i, 0, i + 1, 0, '');
              break;
            }
          }
        }
      } else if (f.rule === 'xmlDoc') {
        // Insert a minimal XML doc stub above the trigger/procedure
        const name = extractMemberNameFromMessage(f.message);
        const idx = lines.findIndex(l => new RegExp(`\\b(?:trigger|procedure|local\\s+procedure)\\s+${escapeRegExp(name)}\\b`, 'i').test(l));
        if (idx !== -1) {
          const stub = [
            '    /// <summary>',
            `    /// TODO: Document ${name}`,
            '    /// </summary>'
          ].join('\n') + '\n';
          pushEdit(idx, 0, idx, 0, stub);
        }
      } else if (f.rule === 'braceOnNewLine') {
        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          const m = l.match(/^(.*\))\s*\{\s*$/);
          if (m) {
            pushEdit(i, 0, i + 1, 0, `${m[1]}\n{\n`);
            break;
          }
        }
      }
    }

    if (edits.length) files.push({ file: rel, edits });
  }
  return { files };
}

function extractVarNameFromMessage(msg) {
  const m = msg.match(/Variable '([^']+)'/);
  return m ? m[1] : '';
}

function extractMemberNameFromMessage(msg) {
  const m = msg.match(/for (?:trigger|procedure)\s+([A-Za-z0-9_]+)/i);
  return m ? m[1] : 'Member';
}

async function applyEdits(root, files) {
  const results = [];
  for (const f of files) {
    const abs = path.join(root, f.file);
    const text = await fs.readFile(abs, 'utf-8');
    const lines = text.split(/\r?\n/);
    const newlineLen = text.includes('\r\n') ? 2 : 1;
    // Apply edits from bottom to top so offsets remain valid
    const sorted = [...f.edits].sort((a, b) => (b.range.start.line - a.range.start.line) || (b.range.start.column - a.range.start.column));
    let newText = text;
    for (const e of sorted) {
      const start = indexFromPos(lines, e.range.start.line, e.range.start.column, newlineLen);
      const end = indexFromPos(lines, e.range.end.line, e.range.end.column, newlineLen);
      newText = newText.slice(0, start) + e.newText + newText.slice(end);
    }
    await fs.writeFile(abs, newText, 'utf-8');
    results.push({ file: f.file, applied: f.edits.length });
  }
  return { applied: results };
}

function indexFromPos(lines, line, col, newlineLen = 1) {
  let idx = 0;
  for (let i = 0; i < line; i++) idx += lines[i].length + newlineLen; // include newline length
  return idx + col;
}

// --------- Encoding helpers (handle PowerShell UTF-16, BOM) ---------
function stripUtf8Bom(text) {
  if (text.charCodeAt(0) === 0xFEFF) return text.slice(1);
  return text;
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function decodeBufferToString(buf) {
  // Detect BOMs and common encodings: UTF-8, UTF-16 LE/BE
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
    // UTF-16 LE BOM
    return new TextDecoder('utf-16le').decode(buf);
  }
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    // UTF-16 BE BOM
    return new TextDecoder('utf-16be').decode(buf);
  }
  // Heuristic: many NULs indicate UTF-16LE without BOM (common when redirected via PowerShell)
  let nulCount = 0;
  for (let i = 0; i < Math.min(buf.length, 64); i++) if (buf[i] === 0) nulCount++;
  if (nulCount > 10) {
    return new TextDecoder('utf-16le').decode(buf);
  }
  return buf.toString('utf8');
}
