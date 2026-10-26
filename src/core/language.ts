const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyw: 'python',
  md: 'markdown',
  markdown: 'markdown',
  json: 'json',
  jsonc: 'jsonc',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  java: 'java',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  sh: 'shellscript',
  bash: 'shellscript',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  xml: 'xml',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'dockerfile'
};

export function languageIdForPath(fsPath: string): string | undefined {
  const base = fsPath.replace(/\\/g, '/').split('/').pop() ?? '';
  if (base.toLowerCase() === 'dockerfile') {
    return 'dockerfile';
  }
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot === base.length - 1) {
    return undefined;
  }
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1).toLowerCase()];
}
