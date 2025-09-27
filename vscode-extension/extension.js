const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');

/**
 * Execute the MCP propose tool and return proposal JSON
 */
async function getProposalForWorkspace(workspaceFolder) {
  const serverDir = path.join(workspaceFolder.uri.fsPath, 'MCPTest', 'server');
  const repoPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!repoPath) throw new Error('No workspace folder open');
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32'
      ? `node index.mjs propose --repo "${repoPath}"`
      : `node index.mjs propose --repo "${repoPath}"`;
    const proc = cp.exec(cmd, { cwd: serverDir, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      try {
        const text = stdout.toString();
        const json = JSON.parse(text.replace(/^\uFEFF/, ''));
        resolve(json);
      } catch (e) {
        reject(new Error('Failed to parse proposal JSON: ' + e.message + '\n' + stdout + '\n' + stderr));
      }
    });
  });
}

function applyEditsToEditor(editor, fileEdits) {
  return editor.edit(editBuilder => {
    // Apply bottom-up: sort by start position descending
    const sorted = [...fileEdits].sort((a, b) => (b.range.start.line - a.range.start.line) || (b.range.start.column - a.range.start.column));
    for (const e of sorted) {
      const start = new vscode.Position(e.range.start.line, e.range.start.column);
      const end = new vscode.Position(e.range.end.line, e.range.end.column);
      editBuilder.replace(new vscode.Range(start, end), e.newText);
    }
  });
}

class TesAlCodeActionProvider {
  provideCodeActions(document, _range, _context, _token) {
    const action = new vscode.CodeAction('TES: Propose and apply file fixes', vscode.CodeActionKind.QuickFix);
    action.command = { command: 'tesAl.applyFileFixes', title: 'Apply TES fixes' };
    return [action];
  }
}

async function proposeFileFixes() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) return;
  const proposal = await getProposalForWorkspace(workspaceFolder);
  const fileProposal = proposal.files?.find(f => path.normalize(path.join(workspaceFolder.uri.fsPath, f.file)).toLowerCase().endsWith(path.normalize(editor.document.uri.fsPath).toLowerCase().replace(path.normalize(workspaceFolder.uri.fsPath).toLowerCase() + path.sep, '')));
  return fileProposal;
}

async function applyFileFixes() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) return;

  const proposal = await getProposalForWorkspace(workspaceFolder);
  const rel = path.relative(workspaceFolder.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/');
  const file = proposal.files?.find(f => f.file === rel);
  if (!file || !file.edits?.length) {
    vscode.window.showInformationMessage('TES: No fixes proposed for this file.');
    return;
  }

  const choice = await vscode.window.showInformationMessage(`Apply ${file.edits.length} TES fix(es) to ${path.basename(rel)}?`, { modal: true }, 'Apply');
  if (choice !== 'Apply') return;

  const applied = await applyEditsToEditor(editor, file.edits);
  if (applied) {
    vscode.window.showInformationMessage('TES: Fixes applied in editor. Save to persist.');
  } else {
    vscode.window.showErrorMessage('TES: Failed to apply fixes.');
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ language: 'al' }, new TesAlCodeActionProvider(), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('tesAl.proposeFileFixes', proposeFileFixes),
    vscode.commands.registerCommand('tesAl.applyFileFixes', applyFileFixes)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
