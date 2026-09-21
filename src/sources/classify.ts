/** Shared binary/generated classification for file trees from any host. */

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff', '.heic',
  '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.webm', '.flac',
  '.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.dmg', '.iso',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.jar',
  '.db', '.sqlite', '.sqlite3', '.parquet', '.bin'
]);

const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock)$/,
  /\.min\.(js|css|mjs)$/,
  /\.map$/,
  /(^|\/)(dist|build|out|coverage|target|vendor|node_modules|third_party|generated)(\/|$)/,
  /(^|\/)CHANGELOG\.md$/
];

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

export function isBinaryPath(path: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(path));
}

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATTERNS.some((re) => re.test(path));
}

/** Prism language id for a path, or null when there is no sensible highlighting. */
export function prismLanguageFor(path: string): string | null {
  const ext = extensionOf(path);
  const map: Record<string, string> = {
    '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'jsx',
    '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'tsx',
    '.css': 'css', '.html': 'markup', '.htm': 'markup', '.svg': 'markup', '.xml': 'markup',
    '.json': 'json', '.md': 'markdown', '.py': 'python', '.rb': 'ruby', '.rs': 'rust',
    '.go': 'go', '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash',
    '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.sql': 'sql', '.java': 'java',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin'
  };
  return map[ext] ?? null;
}
