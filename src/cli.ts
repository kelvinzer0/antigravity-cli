#!/usr/bin/env node
/**
 * Free Antigravity CLI - Community Edition
 * Wraps the official agy CLI with custom model support via a local proxy.
 */
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import inquirer from 'inquirer';
import { addModel, removeModel, listModels, ensureConfigDir, saveModels, CustomModelEntry } from './config';
import { startProxy, getProxyPort, stopProxy } from './proxy';
import { backupFile, decryptString } from './crypto';
import { checkAgyCompatibility } from './manifest';
import {
  ContextMode,
  EnvelopeMode,
  VALID_CONTEXT_MODES,
  VALID_ENVELOPE_MODES,
  getContextConfigPath as getContextSettingsPath,
  loadContextSettings,
  saveContextSettings,
} from './context/settings';
import { getBundledPath, getInstalledPath, ContextVariant, describeContextSource, getGlobalContextDir, readContextFile } from './context/paths';
import { installAgentContext, removeInstalledContext } from './context/installer';
import { getReasoningEffortConfig, getReasoningLabel, ReasoningEffort, VALID_REASONING_EFFORTS, setModelReasoningEffort, supportsReasoningEffort } from './context/reasoningEffort';
import { estimateTextTokens } from './context/tokenEstimator';

// --- Agent context commands ---

function variantLabel(variant: ContextVariant): string {
  return variant === 'full' ? 'full  (agent-context.md)' : 'lite  (agent-context-lite.md)';
}

function printContextStatus(): void {
  const settings = loadContextSettings();
  console.log('\nAgent Context\n' + '─'.repeat(50));
  console.log(`  Mode:      ${settings.mode}${settings.enabled ? '' : '  (disabled)'}`);
  console.log(`  Envelope:  ${settings.envelope}`);
  console.log(`  Native SI: ${settings.keepNativeSystemInstruction ? 'kept (appended after context)' : 'replaced'}`);
  console.log(`  Compaction: ${settings.compaction.enabled ? `on @ ${Math.round(settings.compaction.threshold * 100)}%, keep ${settings.compaction.tailTurns} turn(s)` : 'off'}`);
  console.log(`  Config:    ${getContextSettingsPath()}`);
  console.log(`  Installed: ${getGlobalContextDir()}\n`);

  for (const variant of ['lite', 'full'] as ContextVariant[]) {
    const content = readContextFile(variant);
    const tokens = content ? estimateTextTokens(content) : 0;
    console.log(`  ${variantLabel(variant)}`);
    console.log(`    source: ${describeContextSource(variant)}`);
    console.log(`    size:   ${content ? `${content.length} chars (~${tokens} tokens)` : 'not found'}`);
    console.log(`    install target: ${getInstalledPath(variant)}`);
  }
  console.log('');
}

async function runContextCommand(sub: string | undefined, rest: string[]): Promise<void> {
  const settings = loadContextSettings();

  if (!sub || sub === 'status' || sub === 'show') {
    printContextStatus();
    return;
  }

  if (sub === 'install') {
    const result = installAgentContext();
    if (result.full && result.lite) {
      console.log(`Installed agent context to ${getGlobalContextDir()}`);
      console.log(`  ${result.full}`);
      console.log(`  ${result.lite}`);
    } else {
      console.log('Install incomplete. Reinstall the package or set AGENT_CONTEXT_PATH manually.');
      if (process.env.ANTIGRAVITY_DEBUG === 'true') {
        console.debug('Bundled sources:', getBundledPath('full'), getBundledPath('lite'));
      }
    }
    return;
  }

  if (sub === 'uninstall') {
    removeInstalledContext();
    console.log(`Removed installed agent context from ${getGlobalContextDir()}`);
    return;
  }

  if (sub === 'show-file') {
    const variant = (rest[0] === 'full' ? 'full' : 'lite') as ContextVariant;
    const content = readContextFile(variant);
    if (!content) {
      console.error(`No ${variant} context file found. Run "antigravity context install".`);
      process.exitCode = 1;
      return;
    }
    console.log(`# ${describeContextSource(variant)}\n`);
    console.log(content);
    return;
  }

  if (sub === 'set') {
    const [key, ...valueParts] = rest;
    const value = valueParts.join(' ');
    if (!key || !value) {
      console.log('Usage: antigravity context set <mode|envelope|compaction|compaction-threshold|compaction-tail-turns|keep-native> <value>');
      process.exitCode = 1;
      return;
    }

    const next = { ...settings };
    switch (key) {
      case 'mode':
        if (!VALID_CONTEXT_MODES.includes(value as ContextMode)) {
          console.error(`Invalid mode "${value}". Use one of: ${VALID_CONTEXT_MODES.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        next.mode = value as ContextMode;
        break;
      case 'envelope':
        if (!VALID_ENVELOPE_MODES.includes(value as EnvelopeMode)) {
          console.error(`Invalid envelope "${value}". Use one of: ${VALID_ENVELOPE_MODES.join(', ')}`);
          process.exitCode = 1;
          return;
        }
        next.envelope = value as EnvelopeMode;
        break;
      case 'compaction':
        next.compaction = { ...next.compaction, enabled: value !== 'false' && value !== 'off' };
        break;
      case 'compaction-threshold': {
        const parsed = Number(value);
        if (!(parsed > 0) || parsed >= 1) {
          console.error('compaction-threshold must be a number greater than 0 and less than 1 (e.g. 0.8)');
          process.exitCode = 1;
          return;
        }
        next.compaction = { ...next.compaction, threshold: parsed };
        break;
      }
      case 'compaction-tail-turns': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          console.error('compaction-tail-turns must be a non-negative integer');
          process.exitCode = 1;
          return;
        }
        next.compaction = { ...next.compaction, tailTurns: parsed };
        break;
      }
      case 'keep-native':
        next.keepNativeSystemInstruction = value === 'true' || value === 'on';
        break;
      default:
        console.error(`Unknown key "${key}"`);
        process.exitCode = 1;
        return;
    }

    const result = saveContextSettings(next);
    if (!result.success) {
      console.error(`Failed to save settings: ${result.error}`);
      process.exitCode = 1;
      return;
    }
    console.log(`context.${key} = ${value}`);
    return;
  }

  if (sub === 'effort') {
    const [model, effort] = rest;
    if (!model) {
      const config = getReasoningEffortConfig();
      const entries = Object.entries(config.models);
      console.log('\nReasoning Effort\n' + '─'.repeat(50));
      if (entries.length === 0) {
        console.log('  No per-model overrides set.');
      }
      for (const [name, level] of entries) {
        console.log(`  ${name}: ${level}`);
      }
      console.log('\nDetected reasoning-capable models:');
      for (const m of listModels()) {
        const label = getReasoningLabel(m.externalModelName);
        if (label) console.log(`  ${m.displayName || m.name} → ${label} (${m.externalModelName})`);
      }
      console.log(`\nUsage: antigravity context effort <model> <${VALID_REASONING_EFFORTS.join('|')}>`);
      console.log('');
      return;
    }
    if (!effort) {
      console.log('Usage: antigravity context effort <model> <low|medium|high|max|default>');
      process.exitCode = 1;
      return;
    }
    if (!VALID_REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
      console.error(`Invalid effort "${effort}". Use one of: ${VALID_REASONING_EFFORTS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const ok = setModelReasoningEffort(model, effort as ReasoningEffort);
    console.log(ok ? `reasoning_effort for "${model}" = ${effort}` : 'Failed to save reasoning effort config.');
    if (effort !== 'default' && !supportsReasoningEffort(model)) {
      console.log(`Note: "${model}" is not in the known reasoning-capable list; the value is still sent if the provider accepts it.`);
    }
    return;
  }

  console.log('Usage: antigravity context <status|install|uninstall|show-file|set|effort>');
  process.exitCode = 1;
}

function searchInPath(): string | null {
  try {
    const cmd = os.platform() === 'win32' ? 'where agy' : 'which agy';
    const out = execSync(cmd, { stdio: 'pipe' }).toString().trim().split('\r\n')[0].split('\n')[0];
    if (out && fs.existsSync(out)) return out;
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.debug('[Debug] searchInPath failed:', (e as Error).message);
    }
  }
  return null;
}

function getAgyBin(): string {
  // 1. User Override
  if (process.env.AGY_BIN && fs.existsSync(process.env.AGY_BIN)) {
    return process.env.AGY_BIN;
  }

  // 2. PATH Search
  const pathBin = searchInPath();
  if (pathBin) return pathBin;

  // 3. OS-specific defaults
  const isWin = os.platform() === 'win32';
  const binName = isWin ? 'agy.exe' : 'agy';
  const locations = [
    // Windows default
    path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', binName),
    // macOS default Application Support
    path.join(os.homedir(), 'Library', 'Application Support', 'agy', 'bin', binName),
    // macOS/Linux local share
    path.join(os.homedir(), '.local', 'share', 'agy', 'bin', binName),
    // macOS/Linux local bin fallback
    path.join(os.homedir(), '.local', 'bin', binName),
  ];

  for (const loc of locations) {
    if (fs.existsSync(loc)) return loc;
  }

  // 4. Default fallback based on platform
  if (isWin) {
    return path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
  }
  return path.join(os.homedir(), '.local', 'share', 'agy', 'bin', 'agy');
}

async function ensureProxy(): Promise<number> {
  try { return await startProxy(); }
  catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.warn('[Warn] startProxy failed, using cached port:', (e as Error).message);
    }
    return getProxyPort() || 50998;
  }
}

function getVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      return pkg.version || '1.0.4';
    }
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.debug('[Debug] getVersion failed:', (e as Error).message);
    }
  }
  return '1.0.4';
}

function patchUrlFlexible(buf: Buffer, original: string, replacement: string): boolean {
  const origBuf = Buffer.from(original);
  const idx = buf.indexOf(origBuf);
  if (idx === -1) return false;

  const replBuf = Buffer.from(replacement);
  const paddedRepl = Buffer.alloc(origBuf.length);
  replBuf.copy(paddedRepl);
  // Pad remaining bytes with null (safe inside binary strings)
  for (let i = replBuf.length; i < paddedRepl.length; i++) paddedRepl[i] = 0;

  paddedRepl.copy(buf, idx);
  return true;
}

function discoverGoogleUrls(buf: Buffer): string[] {
  const found = new Set<string>();
  const str = buf.toString('ascii');
  const urlPattern = /https:\/\/[a-z0-9-]+\.googleapis\.com/g;
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(str)) !== null) {
    found.add(match[0]);
  }
  return Array.from(found);
}

function getAgyVersion(binPath: string): string | null {
  try {
    const out = execSync(`"${binPath}" --version`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
    const m = out.match(/(\d+\.\d+\.?\d*)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function ensureAgyPatched(binPath: string): void {
  if (!fs.existsSync(binPath)) return;
  try {
    const version = getAgyVersion(binPath);
    const buf = fs.readFileSync(binPath);
    const port = getProxyPort() || 50998;
    const replBase = `http://localhost:${port}/v1internal/`;

    // Known targets for backwards compatibility
    const knownTargets = [
      { orig: 'https://daily-cloudcode-pa.googleapis.com', repl: replBase + 'xxxxxxx' },
      { orig: 'https://cloudcode-pa.googleapis.com',         repl: replBase + 'x' },
    ];

    // Discover additional Google URLs dynamically from the binary
    const discovered = discoverGoogleUrls(buf);
    const dynamicTargets = discovered
      .filter((url) => !knownTargets.some((k) => k.orig === url))
      .map((url) => ({ orig: url, repl: replBase + 'x' }));

    const allTargets = [...knownTargets, ...dynamicTargets];

    // Check if already fully patched
    if (allTargets.every((t) => buf.includes(Buffer.from(t.repl)))) return;

    // Check for old patches to upgrade (50999 → current port)
    const oldPatches = [
      { old: 'http://localhost:50999/v1internal/xxxxxxx', newP: replBase + 'xxxxxxx' },
    ];
    let upgraded = false;
    for (const op of oldPatches) {
      const oldBuf = Buffer.from(op.old);
      const newBuf = Buffer.from(op.newP);
      const oi = buf.indexOf(oldBuf);
      if (oi !== -1 && newBuf.length === oldBuf.length) {
        backupFile(binPath, version || undefined);
        newBuf.copy(buf, oi);
        upgraded = true;
      }
    }
    if (upgraded) console.log('[ok] agy binary patch upgraded (50999 → current port).');

    // Apply fresh patches (flexible, handles length mismatches via padding)
    let patched = false;
    for (const t of allTargets) {
      if (buf.includes(Buffer.from(t.repl))) continue;
      if (patchUrlFlexible(buf, t.orig, t.repl)) patched = true;
    }

    if (patched || upgraded) {
      if (!upgraded) backupFile(binPath, version || undefined);
      fs.writeFileSync(binPath, buf);
      if (!upgraded) console.log('[ok] agy binary patched for custom model support.');
      if (os.platform() === 'darwin') {
        try {
          execSync(`codesign --force --sign - "${binPath}"`, { stdio: 'ignore' });
          execSync(`xattr -d com.apple.quarantine "${binPath}"`, { stdio: 'ignore' });
        } catch { /* macOS code signing not available */ }
      }
    }
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.warn('[Warn] agy binary patching failed:', e);
    }
  }
}

/** Keeps ~/.antigravity/agent-context.md in sync on every launch so the agent has a stable path. */
function ensureAgentContextInstalled(): void {
  const settings = loadContextSettings();
  if (!settings.installOnStart) return;
  try {
    installAgentContext();
  } catch (e) {
    if (process.env.ANTIGRAVITY_DEBUG === 'true') {
      console.debug('[Debug] Agent context install failed:', (e as Error).message);
    }
  }
}

async function startAndDelegate(agyArgs: string[]): Promise<void> {
  // agy starts interactive mode by default when no flags are given
  const agyBin = getAgyBin();

  if (!fs.existsSync(agyBin)) {
    console.error(`\n[Error] agy CLI not found!`);
    console.error(`Search location checked: ${agyBin}`);
    console.error('\nPlease install the official Antigravity CLI first.');
    console.error('If installed in a custom location, set the AGY_BIN environment variable:');
    console.error('  export AGY_BIN=/path/to/agy\n');
    process.exit(1);
  }

  const version = getAgyVersion(agyBin);
  if (version) {
    await checkAgyCompatibility(version);
  }

  ensureAgyPatched(agyBin);
  ensureAgentContextInstalled();
  process.stdout.write('Starting proxy... ');
  const port = await ensureProxy();
  console.log(`ready (port ${port})\n`);

  const child = spawn(agyBin, agyArgs, { stdio: 'inherit', shell: true });
  child.on('exit', async (code) => { await stopProxy(); process.exit(code || 0); });
  process.on('SIGINT', async () => { child.kill(); await stopProxy(); process.exit(0); });
}

async function main(): Promise<void> {
  let args = process.argv.slice(2);

  // Parse and strip verbose/debug flags
  const isDebug = args.includes('--verbose') || args.includes('--debug') || process.env.ANTIGRAVITY_DEBUG === 'true';
  if (isDebug) {
    process.env.ANTIGRAVITY_DEBUG = 'true';
  }
  args = args.filter(a => a !== '--verbose' && a !== '--debug');

  const cmd = args[0];

  // --- Model management ---
  if (cmd === 'models') {
    const sub = args[1];

    if (sub === 'list') {
      const models = listModels();
      if (models.length === 0) { console.log('No models. Use "antigravity models add".'); return; }
      console.log('\nCustom Models:\n' + '='.repeat(50));
      for (const m of models) {
        console.log(`  ${m.displayName || m.name}`);
        console.log(`  Provider: ${m.provider}  |  Model: ${m.externalModelName}`);
        console.log(`  URL: ${m.apiUrl}`);
        if (m.contextWindow) console.log(`  Context window: ${m.contextWindow} tokens`);
        if (m.reasoningEffort) console.log(`  Reasoning effort: ${m.reasoningEffort}`);
        console.log('');
      }
      return;
    }

    if (sub === 'add') {
      console.log('\n  Add Custom AI Model\n' + '─'.repeat(40));
      const answers = await inquirer.prompt([
        { type: 'list', name: 'provider', message: 'Provider:', choices: [
          'openai', 'anthropic', 'google', 'ollama', 'openrouter', 'custom',
          'deepseek', 'groq', 'mistral', 'cerebras', 'kimi', 'fireworks',
          'lmstudio', 'llamacpp', 'nvidia'
        ] },
        { type: 'input', name: 'modelId', message: 'Model ID (e.g. gpt-4o):', validate: (v: string) => v.length > 0 },
        { type: 'input', name: 'displayName', message: 'Display name:' },
        { type: 'password', name: 'apiKey', message: 'API Key:', mask: '*' },
        { type: 'input', name: 'apiUrl', message: 'API URL:', default: (a: any) => {
          const d: Record<string, string> = {
            openai: 'https://api.openai.com/v1/chat/completions',
            anthropic: 'https://api.anthropic.com/v1/messages',
            google: `https://generativelanguage.googleapis.com/v1beta/models/${a.modelId}:generateContent`,
            ollama: 'http://localhost:11434/v1/chat/completions',
            openrouter: 'https://openrouter.ai/api/v1/chat/completions',
            custom: 'https://api.together.xyz/v1',
            deepseek: 'https://api.deepseek.com/anthropic',
            groq: 'https://api.groq.com/openai/v1',
            mistral: 'https://api.mistral.ai/v1',
            cerebras: 'https://api.cerebras.ai/v1',
            kimi: 'https://api.moonshot.ai/anthropic/v1',
            fireworks: 'https://api.fireworks.ai/inference/v1',
            lmstudio: 'http://localhost:1234/v1',
            llamacpp: 'http://localhost:8080/v1',
            nvidia: 'https://integrate.api.nvidia.com/v1',
          };
          return d[a.provider] || '';
        }},
        { type: 'input', name: 'contextWindow', message: 'Context window in tokens (blank = default 128000):', default: '' },
        { type: 'list', name: 'reasoningEffort', message: 'Reasoning effort:', choices: ['default', 'low', 'medium', 'high', 'max'], default: 'default' },
      ]);
      const contextWindow = answers.contextWindow ? Number(answers.contextWindow) : undefined;
      if (contextWindow !== undefined && (!Number.isFinite(contextWindow) || contextWindow <= 0)) {
        console.error('\nContext window must be a positive number.\n');
        process.exitCode = 1;
        return;
      }
      const r = addModel({
        name: 'models/' + answers.modelId,
        displayName: answers.displayName || answers.modelId,
        description: '',
        provider: answers.provider,
        apiKey: answers.apiKey || 'none',
        apiUrl: answers.apiUrl,
        externalModelName: answers.modelId,
        ...(contextWindow ? { contextWindow } : {}),
        ...(answers.reasoningEffort && answers.reasoningEffort !== 'default' ? { reasoningEffort: answers.reasoningEffort } : {}),
      });
      console.log(r.success ? `\nModel "${answers.displayName || answers.modelId}" added!\n` : `\nFailed: ${r.error}\n`);
      return;
    }

    if (sub === 'remove') {
      const name = args[2];
      if (!name) { console.log('Usage: antigravity models remove <name>'); return; }
      removeModel(name);
      console.log(`Model "${name}" removed.`);
      return;
    }

    if (sub === 'import') {
      const desktopPath = path.join(os.homedir(), '.gemini', 'antigravity', 'custom_models.json');
      if (!fs.existsSync(desktopPath)) { console.log('Desktop Antigravity models not found.\nUse "antigravity models add" instead.'); return; }
      try {
        const models = (JSON.parse(fs.readFileSync(desktopPath, 'utf-8')) as { models?: any[] }).models || [];
        if (models.length === 0) { console.log('No models in desktop config.'); return; }
        ensureConfigDir();
        const imported: CustomModelEntry[] = [];
        for (const m of models) {
          let key = m.apiKey || 'none';
          if (m.encrypted && key !== 'none') {
            try { key = decryptString(key); }
            catch (e2) {
              if (process.env.ANTIGRAVITY_DEBUG === 'true') {
                console.debug('[Debug] decryptString failed for model:', m.name, (e2 as Error).message);
              }
            }
          }
          imported.push({ name: m.name, displayName: m.displayName, description: m.description, provider: m.provider, apiKey: key, apiUrl: m.apiUrl, externalModelName: m.externalModelName, allowUnauthorized: m.allowUnauthorized });
        }
        saveModels(imported);
        console.log(`Imported ${imported.length} model(s). NOTE: API keys from desktop need to be re-entered via "antigravity models add".`);
      } catch (e) { console.error('Import failed:', e); }
      return;
    }

    console.log('Usage: antigravity models <list|add|remove|import>');
    return;
  }

  // --- Agent context management ---
  if (cmd === 'context') {
    await runContextCommand(args[1], args.slice(2));
    return;
  }

  // --- Info commands ---
  if (cmd === 'configure') {
    const contextSettings = loadContextSettings();
    console.log(`Models file: ${path.join(os.homedir(), '.free-antigravity', 'models.json')}`);
    console.log(`Models configured: ${listModels().length}`);
    console.log(`Context file: ${getContextSettingsPath()}`);
    console.log(`Context mode: ${contextSettings.enabled ? contextSettings.mode : 'disabled'}`);
    console.log(`Agent context: ${describeContextSource(contextSettings.mode === 'strip' ? 'full' : 'lite')}`);
    console.log(`Proxy: ${getProxyPort() ? `port ${getProxyPort()}` : 'not running'}`);
    console.log(`agy binary: ${getAgyBin()}`);
    return;
  }

  if (cmd === 'version' || cmd === '--version' || cmd === '-V' || cmd === '-v') {
    console.log(`Free Antigravity CLI v${getVersion()} (Community Edition)`);
    return;
  }

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`Free Antigravity CLI v${getVersion()} - Community Edition
Wraps the official agy CLI with custom model support.

Commands:
  (no args)    Start interactive chat with custom model support
  chat         Same as above
  models list  List custom models
  models add   Add a custom model
  models remove <name>  Remove a custom model
  models import  Import models from desktop Antigravity
  context status  Show agent context mode and sources
  context install  Install agent-context*.md to ~/.antigravity
  context uninstall  Remove the installed agent context
  context show-file [full|lite]  Print the context file
  context set <key> <value>  Change context settings
  context effort [model] [level]  Show or set reasoning effort
  configure    Show configuration
  version      Show version
  help         This help

Context modes: passthrough (off) | lite (default) | strip (full manual)

Any other arguments are passed directly to agy CLI.`);
    return;
  }

  // --- Default: delegate to agy with proxy ---
  if (cmd === 'chat') args.shift();
  await startAndDelegate(args);
}

main().catch(console.error);
